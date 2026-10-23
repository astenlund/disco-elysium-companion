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

// ListDirectory returns the names of a directory's entries, without "." and "..", in the file system's enumeration order.
// It enumerates through a handle that shares read, write and delete, so a concurrent rename or deletion of the directory or
// its entries is never blocked by the enumeration.
func ListDirectory(path string) ([]string, error) {
	handle, err := openForListing(path)
	if handle == syscall.InvalidHandle {
		return nil, err
	}
	defer syscall.CloseHandle(handle)
	return listHeld(handle)
}

// openForListing opens a directory for enumeration without following reparse points, sharing read, write and delete.
func openForListing(path string) (syscall.Handle, error) {
	return Open(path, listDirectoryAccess|synchronizeAccess, shareReadWriteDelete)
}

// listHeld enumerates an open directory handle from its first entry.
func listHeld(handle syscall.Handle) ([]string, error) {
	buffer := make([]byte, directoryBufferBytes)
	var names []string
	class := uintptr(fileFullDirectoryRestartInfo)
	for {
		ok, _, callError := procGetFileInformationByHndX.Call(uintptr(handle), class, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if ok == 0 {
			if callError == errorNoMoreFiles {
				return names, nil
			}
			return nil, callError
		}
		names = appendEntries(names, buffer)
		class = fileFullDirectoryInfo
	}
}

// appendEntries reads the chained FILE_FULL_DIR_INFO records of one filled buffer.
func appendEntries(names []string, buffer []byte) []string {
	for offset := 0; ; {
		record := buffer[offset:]
		length := int(*(*uint32)(unsafe.Pointer(&record[nameLengthField]))) / 2
		name := syscall.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(&record[nameField])), length))
		if name != "." && name != ".." {
			names = append(names, name)
		}
		next := int(*(*uint32)(unsafe.Pointer(&record[nextEntryOffset])))
		if next == 0 {
			return names
		}
		offset += next
	}
}
