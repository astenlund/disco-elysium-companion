package nativefs

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestStagingHandleSharesDeleteAndKeepsCreationExclusive(t *testing.T) {
	// Arrange: a staging file created and still held open.
	staging := filepath.Join(t.TempDir(), "target.json.0123456789abcdef0123456789abcdef.tmp")
	handle, err := createStaging(staging)
	if handle == syscall.InvalidHandle {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)

	// Act
	second, secondErr := createStaging(staging)
	renameErr := os.Rename(staging, staging+".moved")

	// Assert: a second exclusive create fails, while a concurrent rename of the open staging file succeeds.
	if second != syscall.InvalidHandle {
		syscall.CloseHandle(second)
		t.Fatal("a second create of an existing staging file succeeded")
	}
	if secondErr == nil {
		t.Fatal("the refused second create reported no error")
	}
	if renameErr != nil {
		t.Fatalf("renaming the open staging file failed: %v", renameErr)
	}
}
