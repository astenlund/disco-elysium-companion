package inventory

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"companion-helper/internal/nativefs"
)

// readFailure runs a full inventory of the fixture's scope and returns its error, failing the test when it succeeds.
func (f *resourceScopeFixture) readFailure(t *testing.T) error {
	t.Helper()
	_, err := Read(f.scope, f.hash, false, f.companion, nativefs.NoDeadline)
	if err == nil {
		t.Fatal("inventory succeeded over an unavailable scope")
	}
	return err
}

func TestForeignEntriesNameTheirOwnedDirectoryAndStayUnavailable(t *testing.T) {
	cases := []struct {
		name, relative string
		directory      bool
		label          string
	}{
		{"file at the scope root", "unexpected.json", false, ScopeRoot},
		{"folder at the scope root", "unexpected", true, ScopeRoot},
		{"file in journal", "journal/unexpected.txt", false, Journal},
		{"folder in journal", "journal/unexpected", true, Journal},
		{"folder in journal events", "journal/events/unexpected", true, JournalEvents},
		{"misnamed operation", "operations/unexpected.json", false, Operations},
		{"folder in operations", "operations/unexpected", true, Operations},
		{"folder in quarantine", "quarantine/unexpected", true, Quarantine},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Arrange
			f := newResourceScope(t)
			target := filepath.Join(f.scope, filepath.FromSlash(c.relative))
			if c.directory {
				if err := os.MkdirAll(target, 0o755); err != nil {
					t.Fatal(err)
				}
			} else {
				writeTestFile(t, target, "{}")
			}

			// Act
			err := f.readFailure(t)

			// Assert
			var foreign *ForeignEntryError
			if !errors.As(err, &foreign) || foreign.Directory != c.label {
				t.Fatalf("got %v, want a foreign entry in %s", err, c.label)
			}
			if !errors.Is(err, ErrUnavailable) {
				t.Fatalf("a foreign entry is not unavailable: %v", err)
			}
			if strings.Contains(err.Error(), "unexpected") || strings.Contains(err.Error(), f.scope) {
				t.Fatalf("the failure names the entry or its path: %v", err)
			}
		})
	}
}

func TestQuarantineTrimNamesAForeignQuarantineEntry(t *testing.T) {
	cases := []struct {
		name, entry string
		directory   bool
		foreign     bool
	}{
		{"misnamed file", "notes.txt", false, true},
		{"folder", "unexpected", true, true},
		{"publication temporary", "record." + strings.Repeat("a", 32) + ".quarantined." + strings.Repeat("b", 32) + ".tmp", false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Arrange
			f := newResourceScope(t)
			writeTestFile(t, filepath.Join(f.scope, "quarantine", "record."+strings.Repeat("c", 32)+".quarantined"), "diagnostic")
			target := filepath.Join(f.scope, "quarantine", c.entry)
			if c.directory {
				if err := os.MkdirAll(target, 0o755); err != nil {
					t.Fatal(err)
				}
			} else {
				writeTestFile(t, target, "stray")
			}

			// Act
			_, err := TrimQuarantine(f.scope, f.hash, []byte(`[]`), nativefs.NoDeadline)

			// Assert
			var foreign *ForeignEntryError
			if c.foreign && (!errors.As(err, &foreign) || foreign.Directory != Quarantine) {
				t.Fatalf("got %v, want a foreign entry in quarantine", err)
			}
			if !c.foreign && (!errors.Is(err, ErrUnavailable) || errors.As(err, &foreign)) {
				t.Fatalf("got %v, want the generic unavailable class", err)
			}
			if strings.Contains(err.Error(), c.entry) || strings.Contains(err.Error(), f.scope) {
				t.Fatalf("the failure names the entry or its path: %v", err)
			}
		})
	}
}

func TestAnOwnedEntryThatCannotBeReadIsUnreadable(t *testing.T) {
	// Arrange
	f := newResourceScope(t)
	operation := filepath.Join(f.scope, "operations", "jr-"+strings.Repeat("0", 32)+".json")
	writeTestFile(t, operation, `{"compacted":false,"completedAt":null,"kind":null}`)
	name, err := syscall.UTF16PtrFromString(operation)
	if err != nil {
		t.Fatal(err)
	}
	// A handle that shares nothing makes every read open fail, while attribute-only admission still succeeds.
	held, err := syscall.CreateFile(name, syscall.GENERIC_READ, 0, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(held)

	// Act
	readErr := f.readFailure(t)

	// Assert
	if !errors.Is(readErr, ErrUnreadable) || !errors.Is(readErr, ErrUnavailable) {
		t.Fatalf("got %v, want an unreadable owned entry", readErr)
	}
}

func TestOtherInventoryFailuresKeepTheGenericClass(t *testing.T) {
	// Arrange
	f := newResourceScope(t)

	// Act
	_, err := Read(f.scope, strings.Repeat("0", 64), false, f.companion, nativefs.NoDeadline)

	// Assert
	var foreign *ForeignEntryError
	if !errors.Is(err, ErrUnavailable) || errors.Is(err, ErrUnreadable) || errors.As(err, &foreign) {
		t.Fatalf("got %v, want the generic unavailable class", err)
	}
}
