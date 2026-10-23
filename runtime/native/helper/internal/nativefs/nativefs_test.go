package nativefs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	j "companion-helper/internal/jsondoc"
)

func root(t *testing.T) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	full, err := NormalizePath(directory)
	if err != nil {
		t.Fatal(err)
	}
	return full
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func sum(data []byte) string {
	value := sha256.Sum256(data)
	return hex.EncodeToString(value[:])
}

func TestNormalizePathRefusesAmbiguousSpellings(t *testing.T) {
	// Arrange
	refused := []string{`relative\path`, `C:`, `C:\a\..\b`, `C:\a\.\b`, `C:\a\b.`, `C:\a\b `, `C:\a\CON`, `C:\a\nul.txt`, `C:\a\COM1`, `C:\a\b:c`, `C:\a\\b`, `\\server\share\x`}
	accepted := map[string]string{`C:/a/b`: `C:\a\b`, `c:\a\b\`: `c:\a\b`, `C:\`: `C:\`, `C:\a\CONx`: `C:\a\CONx`}
	for _, candidate := range refused {
		// Act
		_, err := NormalizePath(candidate)

		// Assert
		if err == nil {
			t.Fatalf("%q was accepted", candidate)
		}
	}
	for candidate, expected := range accepted {
		// Act
		actual, err := NormalizePath(candidate)

		// Assert
		if err != nil || actual != expected {
			t.Fatalf("%q normalized to %q (%v), want %q", candidate, actual, err, expected)
		}
	}
}

func TestAdmissionDescribesFilesDirectoriesAndMissingSuffixes(t *testing.T) {
	// Arrange
	base := root(t)
	write(t, filepath.Join(base, "file.json"), "{}")
	if err := os.Mkdir(filepath.Join(base, "folder"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Act
	file, fileErr := AdmitWithin(base, filepath.Join(base, "file.json"), false)
	folder, folderErr := AdmitWithin(base, filepath.Join(base, "folder"), false)
	missing, missingErr := AdmitWithin(base, filepath.Join(base, "folder", "a", "b"), true)
	_, refusedErr := AdmitWithin(base, filepath.Join(base, "absent"), false)
	_, outsideErr := AdmitWithin(filepath.Join(base, "folder"), filepath.Join(base, "file.json"), true)

	// Assert
	if fileErr != nil || !file.Exists || file.IsDirectory || file.Links != 1 || len(file.Volume) != 16 || len(file.Identity) != 32 {
		t.Fatalf("file admission %+v %v", file, fileErr)
	}
	if folderErr != nil || !folder.IsDirectory {
		t.Fatalf("folder admission %+v %v", folder, folderErr)
	}
	if missingErr != nil || missing.Exists || strings.Join(missing.Missing, "/") != "a/b" {
		t.Fatalf("missing admission %+v %v", missing, missingErr)
	}
	if refusedErr == nil || outsideErr == nil {
		t.Fatal("absent or outside paths were admitted")
	}
}

func TestAdmissionRefusesMultiplyLinkedFiles(t *testing.T) {
	// Arrange
	base := root(t)
	write(t, filepath.Join(base, "one.json"), "{}")
	if err := os.Link(filepath.Join(base, "one.json"), filepath.Join(base, "two.json")); err != nil {
		t.Skip("hard links are unavailable here")
	}

	// Act
	_, err := AdmitWithin(base, filepath.Join(base, "one.json"), false)

	// Assert
	if err == nil {
		t.Fatal("a multiply linked file was admitted")
	}
}

func TestPublicationReplacesUnderAnOpenReader(t *testing.T) {
	// Arrange
	base := root(t)
	target := filepath.Join(base, "record.json")
	write(t, target, `{"version":1}`)
	// The runtime's readers (Node and the status process) open with read, write and delete sharing, as here.
	reader, err := OpenRead(target, shareRead|shareWrite|shareDelete)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(reader)
	validate := func(data []byte) error { return j.Validate(data, j.Config) }

	// Act
	result, publishErr := PublishValidated(base, target, []byte(`{"version":2}`), validate, false, NoDeadline)
	old := make([]byte, 64)
	var read uint32
	readErr := syscall.ReadFile(reader, old, &read, nil)
	count := int(read)
	current, currentErr := os.ReadFile(target)

	// Assert
	if publishErr != nil || readErr != nil || currentErr != nil {
		t.Fatalf("publication or reads failed: %v %v %v", publishErr, readErr, currentErr)
	}
	if string(old[:count]) != `{"version":1}` || string(current) != `{"version":2}` {
		t.Fatalf("open reader saw %q and new reader %q", old[:count], current)
	}
	if result.Sha256 != sum([]byte(`{"version":2}`)) || len(result.RetainedSiblings) != 0 {
		t.Fatalf("result %+v", result)
	}
}

func TestCreateOnlyPublicationNeverReplaces(t *testing.T) {
	// Arrange
	base := root(t)
	target := filepath.Join(base, "record.json")
	write(t, target, `{"kept":true}`)
	validate := func(data []byte) error { return j.Validate(data, j.Config) }

	// Act
	_, err := PublishValidated(base, target, []byte(`{"kept":false}`), validate, true, NoDeadline)
	current, _ := os.ReadFile(target)

	// Assert
	if err == nil || string(current) != `{"kept":true}` {
		t.Fatalf("create-only publication replaced its target: %v %q", err, current)
	}
	siblings, _ := filepath.Glob(filepath.Join(base, "record.json.*"))
	if len(siblings) != 0 {
		t.Fatalf("staging residue %v", siblings)
	}
}

func TestPublicationRefusesInvalidDocumentsWithoutResidue(t *testing.T) {
	// Arrange
	base := root(t)
	target := filepath.Join(base, "record.json")
	validate := func(data []byte) error { return j.Validate(data, j.Config) }

	// Act
	_, err := PublishValidated(base, target, []byte(`{"broken":`), validate, false, NoDeadline)

	// Assert
	if !errors.Is(err, j.ErrInvalid) {
		t.Fatalf("invalid document gave %v", err)
	}
	entries, _ := os.ReadDir(base)
	if len(entries) != 0 {
		t.Fatalf("residue %v", entries)
	}
}

func TestHashesReportBytesAbsenceAndScopeChanges(t *testing.T) {
	// Arrange
	base := root(t)
	write(t, filepath.Join(base, "scope.json"), `{"scope":1}`)
	write(t, filepath.Join(base, "a.json"), "alpha")
	request := []byte(`["` + strings.ReplaceAll(filepath.Join(base, "a.json"), `\`, `\\`) + `","` + strings.ReplaceAll(filepath.Join(base, "missing.json"), `\`, `\\`) + `"]`)
	scope := sum([]byte(`{"scope":1}`))
	wrong := strings.Repeat("0", 64)

	// Act
	reply, err := ReadHashes(base, request, &scope)
	_, wrongErr := ReadHashes(base, request, &wrong)

	// Assert
	if err != nil {
		t.Fatal(err)
	}
	expected := `{"requestSha256":"` + sum(request) + `","sha256":["` + sum([]byte("alpha")) + `",null]}`
	if string(reply) != expected {
		t.Fatalf("hash reply %s, want %s", reply, expected)
	}
	if wrongErr == nil {
		t.Fatal("a changed scope was accepted")
	}
}

func TestFileActionsVerifyExactBytes(t *testing.T) {
	// Arrange
	base := root(t)
	source := filepath.Join(base, "event.json")
	write(t, source, "payload")
	hash := sum([]byte("payload"))
	if err := os.Mkdir(filepath.Join(base, "quarantine"), 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(base, "quarantine", "event.quarantined")

	// Act
	wrongErr := FileAction(base, "Move", source, target, strings.Repeat("1", 64), NoDeadline)
	moveErr := FileAction(base, "Move", source, target, hash, NoDeadline)
	removeErr := FileAction(base, "Remove", target, "", hash, NoDeadline)

	// Assert
	if wrongErr == nil || moveErr != nil || removeErr != nil {
		t.Fatalf("file actions: %v %v %v", wrongErr, moveErr, removeErr)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatal("the moved source remains")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("the removed target remains")
	}
}

func TestReadBoundedRefusesOversizeAsInvalid(t *testing.T) {
	// Arrange
	base := root(t)
	path := filepath.Join(base, "large.json")
	write(t, path, string(bytes.Repeat([]byte("x"), 1025)))

	// Act
	_, err := ReadBounded(path, 1024)

	// Assert
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize read gave %v", err)
	}
}
