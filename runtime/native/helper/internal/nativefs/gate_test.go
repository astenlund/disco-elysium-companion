package nativefs

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	j "companion-helper/internal/jsondoc"
)

var expired Gate = Until(time.Now().Add(-time.Second))

func TestPublicationPastItsDeadlineCommitsNothing(t *testing.T) {
	// Arrange
	base := root(t)
	target := filepath.Join(base, "record.json")
	write(t, target, `{"version":1}`)
	validate := func(data []byte) error { return j.Validate(data, j.Config) }

	// Act
	_, err := PublishValidated(base, target, []byte(`{"version":2}`), validate, false, expired)
	current, _ := os.ReadFile(target)

	// Assert
	if !errors.Is(err, ErrDeadline) || string(current) != `{"version":1}` {
		t.Fatalf("a late publication gave %v and left %q", err, current)
	}
	siblings, _ := filepath.Glob(filepath.Join(base, "record.json.*"))
	if len(siblings) != 0 {
		t.Fatalf("staging residue %v", siblings)
	}
}

func TestFileActionPastItsDeadlineLeavesItsSource(t *testing.T) {
	// Arrange
	base := root(t)
	source := filepath.Join(base, "owned.json")
	write(t, source, `{"owned":true}`)
	hash := sum([]byte(`{"owned":true}`))

	// Act
	moveErr := FileAction(base, "Move", source, filepath.Join(base, "moved.json"), hash, expired)
	removeErr := FileAction(base, "Remove", source, "", hash, expired)
	_, statErr := os.Stat(source)

	// Assert
	if !errors.Is(moveErr, ErrDeadline) || !errors.Is(removeErr, ErrDeadline) || statErr != nil {
		t.Fatalf("late file actions gave %v %v and the source %v", moveErr, removeErr, statErr)
	}
}

func TestPublicationReplacesUnderARawObservationReader(t *testing.T) {
	// Arrange
	base := root(t)
	target := filepath.Join(base, "record.json")
	write(t, target, `{"version":1}`)
	// A raw observation, as a second service process serving status would hold it, shares read and delete only.
	reader, err := OpenRead(target, shareRead|shareDelete)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(reader)
	validate := func(data []byte) error { return j.Validate(data, j.Config) }

	// Act
	_, publishErr := PublishValidated(base, target, []byte(`{"version":2}`), validate, false, NoDeadline)
	current, _ := os.ReadFile(target)

	// Assert
	if publishErr != nil || string(current) != `{"version":2}` {
		t.Fatalf("replacement under a raw observation gave %v and %q", publishErr, current)
	}
}

func TestRawObservationExcludesWritersWhileBoundedReadsShareThem(t *testing.T) {
	// Arrange
	base := root(t)
	target := filepath.Join(base, "record.json")
	write(t, target, `{"version":1}`)
	name, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		t.Fatal(err)
	}
	writerHandle, err := syscall.CreateFile(name, syscall.GENERIC_WRITE, shareRead|shareWrite|shareDelete, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(writerHandle)

	// Act
	_, observeErr := ObserveRaw(target, time.Second)
	data, readErr := ReadBounded(target, 1024)

	// Assert
	if observeErr == nil {
		t.Fatal("a raw observation shared a concurrent writer")
	}
	if readErr != nil || !strings.Contains(string(data), "version") {
		t.Fatalf("a bounded read under a writer gave %v %q", readErr, data)
	}
}
