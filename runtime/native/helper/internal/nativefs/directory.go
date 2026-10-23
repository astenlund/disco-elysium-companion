package nativefs

import (
	"syscall"
	"unsafe"
)

const (
	listDirectoryAccess          = 0x1
	synchronizeAccess            = 0x100000
	fileFullDirectoryInfo        = 14
	fileFullDirectoryRestartInfo = 15
	errorNoMoreFiles             = syscall.Errno(18)
	directoryBufferBytes         = 64 * 1024
	// The FILE_FULL_DIR_INFO offsets of NextEntryOffset, FileNameLength and FileName.
	nextEntryOffset = 0
	nameLengthField = 60
	nameField       = 68
)

// WalkDirectory visits the names of a directory's entries, without "." and "..", in the file system's enumeration order,
// one buffer at a time, so a caller can stop or check its deadline before the whole directory is read. It enumerates
// through a handle that shares read, write and delete, so a concurrent rename or deletion of the directory or its entries
// is never blocked by the enumeration. An error from visit stops the walk and is returned unchanged.
func WalkDirectory(path string, visit func(name string) error) error {
	handle, err := openForListing(path)
	if handle == syscall.InvalidHandle {
		return err
	}
	defer syscall.CloseHandle(handle)
	return walkHeld(handle, visit)
}

// ListDirectory returns the names WalkDirectory visits, for callers that need every entry, such as an ordering.
func ListDirectory(path string) ([]string, error) {
	var names []string
	if err := WalkDirectory(path, func(name string) error { names = append(names, name); return nil }); err != nil {
		return nil, err
	}
	return names, nil
}

// openForListing opens a directory for enumeration without following reparse points, sharing read, write and delete.
func openForListing(path string) (syscall.Handle, error) {
	return Open(path, listDirectoryAccess|synchronizeAccess, shareReadWriteDelete)
}

// listHeld enumerates an open directory handle from its first entry into one slice.
func listHeld(handle syscall.Handle) ([]string, error) {
	var names []string
	if err := walkHeld(handle, func(name string) error { names = append(names, name); return nil }); err != nil {
		return nil, err
	}
	return names, nil
}

// walkHeld visits an open directory handle's entries from its first entry, one filled buffer at a time.
func walkHeld(handle syscall.Handle, visit func(name string) error) error {
	buffer := make([]byte, directoryBufferBytes)
	class := uintptr(fileFullDirectoryRestartInfo)
	for {
		ok, _, callError := procGetFileInformationByHndX.Call(uintptr(handle), class, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if ok == 0 {
			if callError == errorNoMoreFiles {
				return nil
			}
			return callError
		}
		if err := visitEntries(buffer, visit); err != nil {
			return err
		}
		class = fileFullDirectoryInfo
	}
}

// visitEntries reads the chained FILE_FULL_DIR_INFO records of one filled buffer.
func visitEntries(buffer []byte, visit func(name string) error) error {
	for offset := 0; ; {
		record := buffer[offset:]
		length := int(*(*uint32)(unsafe.Pointer(&record[nameLengthField]))) / 2
		name := syscall.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(&record[nameField])), length))
		if name != "." && name != ".." {
			if err := visit(name); err != nil {
				return err
			}
		}
		next := int(*(*uint32)(unsafe.Pointer(&record[nextEntryOffset])))
		if next == 0 {
			return nil
		}
		offset += next
	}
}
