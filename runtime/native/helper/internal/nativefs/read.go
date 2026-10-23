package nativefs

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"syscall"
	"time"
	"unsafe"
)

// ErrTooLarge marks a document that exceeds its byte budget; callers treat it as document-invalid.
var ErrTooLarge = errors.New("document exceeds its byte budget")

const (
	genericRead     = 0x80000000
	shareRead       = 1
	shareWrite      = 2
	shareDelete     = 4
	normalAttribute = 0x80
)

var procGetFileSizeEx = kernel32.NewProc("GetFileSizeEx")

// OpenRead opens a regular file for reading with the given sharing, following no reparse point at the final component.
func OpenRead(path string, share uint32) (syscall.Handle, error) {
	// Admitted paths are full local paths; the extended prefix keeps long paths from failing as absent.
	name, err := syscall.UTF16PtrFromString(`\\?\` + path)
	if err != nil {
		return syscall.InvalidHandle, ErrUnavailable
	}
	handle, _, callError := procCreateFileW.Call(uintptr(unsafe.Pointer(name)), genericRead, uintptr(share), 0, openExisting, normalAttribute, 0)
	if syscall.Handle(handle) == syscall.InvalidHandle {
		return syscall.InvalidHandle, callError
	}
	return syscall.Handle(handle), nil
}

// FileSize returns the size of an open file.
func FileSize(handle syscall.Handle) (int64, error) {
	var size int64
	if ok, _, _ := procGetFileSizeEx.Call(uintptr(handle), uintptr(unsafe.Pointer(&size))); ok == 0 {
		return 0, ErrUnavailable
	}
	return size, nil
}

// SizeOf returns the length of an admitted file without reading it.
func SizeOf(path string) (int64, error) {
	handle, err := Open(path, readAttributes, shareReadWriteDelete)
	if handle == syscall.InvalidHandle || err != nil {
		return 0, ErrUnavailable
	}
	defer syscall.CloseHandle(handle)
	return FileSize(handle)
}

// ReadBounded reads a whole file shared for read, write and delete, refusing more than maximum bytes.
func ReadBounded(path string, maximum int) ([]byte, error) {
	handle, err := OpenRead(path, shareRead|shareWrite|shareDelete)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer syscall.CloseHandle(handle)
	size, err := FileSize(handle)
	if err != nil {
		return nil, err
	}
	if size > int64(maximum) {
		return nil, ErrTooLarge
	}
	return readAll(handle, maximum)
}

func readAll(handle syscall.Handle, maximum int) ([]byte, error) {
	output := make([]byte, 0, min(maximum, 65536))
	buffer := make([]byte, min(maximum+1, 65536))
	for {
		limit := min(len(buffer), maximum-len(output)+1)
		var count uint32
		if err := syscall.ReadFile(handle, buffer[:limit], &count, nil); err != nil {
			return nil, ErrUnavailable
		}
		if count == 0 {
			return output, nil
		}
		if len(output)+int(count) > maximum {
			return nil, ErrTooLarge
		}
		output = append(output, buffer[:count]...)
	}
}

// RawObservation is the exact-bytes evidence for a file that may not be an admissible document.
type RawObservation struct {
	Sha256 string
	Bytes  int64
}

// ObserveRaw hashes a whole file while denying writers, within a deadline of at most 30 seconds.
func ObserveRaw(path string, timeout time.Duration) (RawObservation, error) {
	if timeout < time.Millisecond || timeout > 30*time.Second {
		return RawObservation{}, ErrUnavailable
	}
	started := time.Now()
	handle, err := OpenRead(path, shareRead|shareDelete)
	if err != nil {
		return RawObservation{}, ErrUnavailable
	}
	defer syscall.CloseHandle(handle)
	length, err := FileSize(handle)
	if err != nil {
		return RawObservation{}, err
	}
	hash := sha256.New()
	buffer := make([]byte, 65536)
	var observed int64
	for {
		if time.Since(started) >= timeout {
			return RawObservation{}, ErrUnavailable
		}
		var count uint32
		if err := syscall.ReadFile(handle, buffer, &count, nil); err != nil {
			return RawObservation{}, ErrUnavailable
		}
		observed += int64(count)
		if observed > length {
			return RawObservation{}, ErrUnavailable
		}
		if count == 0 {
			break
		}
		hash.Write(buffer[:count])
	}
	final, err := FileSize(handle)
	if err != nil || observed != length || final != length || time.Since(started) >= timeout {
		return RawObservation{}, ErrUnavailable
	}
	return RawObservation{Sha256: hex.EncodeToString(hash.Sum(nil)), Bytes: observed}, nil
}
