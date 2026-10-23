package nativefs

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"syscall"
	"testing"
)

func TestListingHandleSharesDeleteSoTheDirectoryCanBeRenamed(t *testing.T) {
	// Arrange: a directory with two files, held open the way an enumeration holds it.
	parent := t.TempDir()
	directory := filepath.Join(parent, "listed")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.json", "b.json"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("synthetic"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	handle, err := openForListing(directory)
	if handle == syscall.InvalidHandle {
		t.Fatalf("opening for listing failed: %v", err)
	}
	defer syscall.CloseHandle(handle)

	// Act
	renameErr := os.Rename(directory, filepath.Join(parent, "renamed"))
	names, listErr := listHeld(handle)

	// Assert: the rename is not blocked, and the held handle still enumerates the entries.
	if renameErr != nil {
		t.Fatalf("a rename while the directory was held for listing failed: %v", renameErr)
	}
	if listErr != nil {
		t.Fatalf("listing failed: %v", listErr)
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"a.json", "b.json"}) {
		t.Fatalf("listed %v", names)
	}
}

func TestListDirectoryOmitsDotEntriesAndReadsLargeDirectories(t *testing.T) {
	// Arrange: more entries than one enumeration buffer holds.
	directory := t.TempDir()
	const count = 2000
	for index := range count {
		name := filepath.Join(directory, "entry-with-a-reasonably-long-name-"+strconv.Itoa(index)+".json")
		if err := os.WriteFile(name, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// Act
	names, err := ListDirectory(directory)

	// Assert
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != count || slices.Contains(names, ".") || slices.Contains(names, "..") {
		t.Fatalf("listed %d entries", len(names))
	}
}
