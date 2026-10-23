package nativefs

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"regexp"
	"syscall"
	"unsafe"
)

var (
	procMoveFileExW  = kernel32.NewProc("MoveFileExW")
	procReplaceFileW = kernel32.NewProc("ReplaceFileW")
	procFlushBuffers = kernel32.NewProc("FlushFileBuffers")
	procDeleteFileW  = kernel32.NewProc("DeleteFileW")
)

const (
	genericWrite              = 0x40000000
	createNew                 = 1
	replaceIgnoreMergeErrors  = 0x2
	maximumSiblingAllocations = 4
)

// PublicationResult reports the published bytes' digest and any owned siblings left behind.
type PublicationResult struct {
	Sha256           string
	RetainedSiblings []string
}

// IsOwnedSibling reports whether input is target's owned staging sibling: the same directory and the name
// <target name>.<32 lowercase hex>.tmp, compared like the C# original.
func IsOwnedSibling(target, input string) bool {
	if !EqualOrdinalIgnoreCase(filepath.Dir(target), filepath.Dir(input)) {
		return false
	}
	pattern := regexp.MustCompile(`^` + regexp.QuoteMeta(filepath.Base(target)) + `\.[a-f0-9]{32}\.tmp$`)
	return pattern.MatchString(filepath.Base(input))
}

// PublishValidated writes bytes to a fresh owned sibling and publishes it atomically: a create-only or absent target
// is moved into place without replacement, and an existing target is replaced with a separate owned backup.
// gate is consulted immediately before the move or replacement, the publication's commit point.
func PublishValidated(root, target string, data []byte, validate func([]byte) error, createOnly bool, gate Gate) (PublicationResult, error) {
	destination, err := AdmitWithin(root, target, true)
	if err != nil {
		return PublicationResult{}, err
	}
	if destination.IsDirectory || len(destination.Missing) > 1 || createOnly && destination.Exists {
		return PublicationResult{}, ErrUnavailable
	}
	target = destination.Path
	if err := validate(data); err != nil {
		return PublicationResult{}, err
	}
	sum := sha256.Sum256(data)
	actualHash := hex.EncodeToString(sum[:])
	temporary, err := newSibling(root, target, ".tmp")
	if err != nil {
		return PublicationResult{}, err
	}
	backup, err := newSibling(root, target, ".bak")
	if err != nil {
		return PublicationResult{}, err
	}
	temporaryCreated, backupCreated := false, false
	var retained []string
	publish := func() error {
		if err := writeNew(temporary, data); err != nil {
			if err == errCreated {
				temporaryCreated = true
			}
			return ErrUnavailable
		}
		temporaryCreated = true
		current, err := AdmitWithin(root, target, true)
		if err != nil {
			return err
		}
		if current.IsDirectory || len(current.Missing) > 1 {
			return ErrUnavailable
		}
		if err := gate(); err != nil {
			return err
		}
		if createOnly || !current.Exists {
			if err := moveNoReplace(temporary, target); err != nil {
				return ErrUnavailable
			}
		} else {
			collision, err := AdmitWithin(root, backup, true)
			if err != nil {
				return err
			}
			if collision.Exists {
				return ErrUnavailable
			}
			if err := replaceFile(target, temporary, backup); err != nil {
				return ErrUnavailable
			}
			backupCreated = true
		}
		temporaryCreated = false
		return nil
	}
	failure := publish()
	if temporaryCreated && !removeOwned(root, temporary) {
		retained = append(retained, temporary)
	}
	if backupCreated && !removeOwned(root, backup) {
		retained = append(retained, backup)
	}
	if failure != nil {
		return PublicationResult{}, failure
	}
	if retained == nil {
		retained = []string{}
	}
	return PublicationResult{Sha256: actualHash, RetainedSiblings: retained}, nil
}

func newSibling(root, target, suffix string) (string, error) {
	for attempt := 0; attempt < maximumSiblingAllocations; attempt++ {
		token := make([]byte, 16)
		if _, err := rand.Read(token); err != nil {
			return "", ErrUnavailable
		}
		candidate := target + "." + hex.EncodeToString(token) + suffix
		admission, err := AdmitWithin(root, candidate, true)
		if err != nil {
			return "", err
		}
		if !admission.Exists {
			return candidate, nil
		}
	}
	return "", ErrUnavailable
}

type createdError struct{}

func (createdError) Error() string { return "staging file created but not completed" }

var errCreated error = createdError{}

// writeNew creates path exclusively, writes data, flushes it to disk and closes it. errCreated means the file exists
// and is owned by this call even though the write did not complete.
func writeNew(path string, data []byte) error {
	handle, err := createStaging(path)
	if handle == syscall.InvalidHandle {
		return err
	}
	written := 0
	for written < len(data) {
		var count uint32
		chunk := data[written:min(len(data), written+1<<20)]
		if err := syscall.WriteFile(handle, chunk, &count, nil); err != nil || count == 0 {
			syscall.CloseHandle(handle)
			return errCreated
		}
		written += int(count)
	}
	if ok, _, _ := procFlushBuffers.Call(uintptr(handle)); ok == 0 {
		syscall.CloseHandle(handle)
		return errCreated
	}
	if err := syscall.CloseHandle(handle); err != nil {
		return errCreated
	}
	return nil
}

// createStaging creates path exclusively for writing. The handle shares read, write and delete like every open except the
// held helper image, so it never blocks a concurrent rename or deletion; create-new keeps its creation exclusive, and
// publication still verifies the staged bytes before replacing the target.
func createStaging(path string) (syscall.Handle, error) {
	name, err := extended(path)
	if err != nil {
		return syscall.InvalidHandle, err
	}
	raw, _, callError := procCreateFileW.Call(uintptr(unsafe.Pointer(name)), genericWrite, shareReadWriteDelete, 0, createNew, normalAttribute, 0)
	if syscall.Handle(raw) == syscall.InvalidHandle {
		return syscall.InvalidHandle, callError
	}
	return syscall.Handle(raw), nil
}

func extended(path string) (*uint16, error) { return syscall.UTF16PtrFromString(`\\?\` + path) }

// moveNoReplace is MoveFileExW without flags: it fails when the destination exists and never copies across volumes.
func moveNoReplace(source, destination string) error {
	from, err := extended(source)
	if err != nil {
		return err
	}
	to, err := extended(destination)
	if err != nil {
		return err
	}
	if ok, _, callError := procMoveFileExW.Call(uintptr(unsafe.Pointer(from)), uintptr(unsafe.Pointer(to)), 0); ok == 0 {
		return callError
	}
	return nil
}

// replaceFile is ReplaceFileW with REPLACEFILE_IGNORE_MERGE_ERRORS, the flag .NET File.Replace passes when metadata
// errors are ignored.
func replaceFile(target, replacement, backup string) error {
	replaced, err := extended(target)
	if err != nil {
		return err
	}
	source, err := extended(replacement)
	if err != nil {
		return err
	}
	saved, err := extended(backup)
	if err != nil {
		return err
	}
	if ok, _, callError := procReplaceFileW.Call(uintptr(unsafe.Pointer(replaced)), uintptr(unsafe.Pointer(source)), uintptr(unsafe.Pointer(saved)),
		replaceIgnoreMergeErrors, 0, 0); ok == 0 {
		return callError
	}
	return nil
}

// DeleteFile removes one file by its admitted path.
func DeleteFile(path string) error {
	name, err := extended(path)
	if err != nil {
		return err
	}
	if ok, _, callError := procDeleteFileW.Call(uintptr(unsafe.Pointer(name))); ok == 0 {
		return callError
	}
	return nil
}

// removeOwned deletes an owned sibling if it still exists as an ordinary file. Failure retains it as residue; cleanup
// cannot undo a completed publication.
func removeOwned(root, target string) bool {
	admission, err := AdmitWithin(root, target, true)
	if err != nil {
		return false
	}
	if !admission.Exists {
		return true
	}
	if admission.IsDirectory {
		return false
	}
	return DeleteFile(admission.Path) == nil
}

// MoveNoReplace exposes the flagless move for hash-verified file actions.
func MoveNoReplace(source, destination string) error { return moveNoReplace(source, destination) }
