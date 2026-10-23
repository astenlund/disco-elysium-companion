package nativefs

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func junction(t *testing.T, link, target string) {
	t.Helper()
	// The contained test environment's PATH holds only the toolchain, so cmd.exe is named through SystemRoot.
	shell := filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
	if output, err := exec.Command(shell, "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J failed: %v %s", err, output)
	}
}

func admittedTempDirectory(t *testing.T) Admission {
	t.Helper()
	directory, err := Admit(t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestAdmitChildMatchesTheFullWalkForOrdinaryEntries(t *testing.T) {
	// Arrange
	directory := admittedTempDirectory(t)
	if err := os.WriteFile(filepath.Join(directory.Path, "plain.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(directory.Path, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Act
	file, fileErr := AdmitChild(directory, "plain.json")
	nested, nestedErr := AdmitChild(directory, "nested")

	// Assert
	walkedFile, err := Admit(filepath.Join(directory.Path, "plain.json"), false)
	if err != nil {
		t.Fatal(err)
	}
	walkedNested, err := Admit(filepath.Join(directory.Path, "nested"), false)
	if err != nil {
		t.Fatal(err)
	}
	if fileErr != nil || !reflect.DeepEqual(file, walkedFile) {
		t.Fatalf("the child file differs from its full walk: %+v %v, want %+v", file, fileErr, walkedFile)
	}
	if nestedErr != nil || !reflect.DeepEqual(nested, walkedNested) {
		t.Fatalf("the child directory differs from its full walk: %+v %v, want %+v", nested, nestedErr, walkedNested)
	}
}

func TestAdmitChildRefusesReparsePointsExtraLinksInvalidNamesAndAbsentEntries(t *testing.T) {
	// Arrange
	directory := admittedTempDirectory(t)
	target := filepath.Join(directory.Path, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	junction(t, filepath.Join(directory.Path, "redirect"), target)
	if err := os.WriteFile(filepath.Join(directory.Path, "linked.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(directory.Path, "linked.json"), filepath.Join(directory.Path, "second.json")); err != nil {
		t.Fatal(err)
	}

	// Act
	refusals := map[string]error{}
	for _, name := range []string{"redirect", "linked.json", "..", "a/b", "absent.json"} {
		_, refusals[name] = AdmitChild(directory, name)
	}

	// Assert
	for name, err := range refusals {
		if err == nil {
			t.Fatalf("AdmitChild admitted %q", name)
		}
	}
}

func TestAdmitChildRefusesAnEntryWhoseAdmittedParentWasRedirected(t *testing.T) {
	// Arrange: admit a directory, then move it and put a junction to the moved directory in its place.
	base := admittedTempDirectory(t)
	parent := filepath.Join(base.Path, "parent")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(parent, "entry.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	admitted, err := Admit(parent, false)
	if err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(base.Path, "moved")
	if err := os.Rename(parent, moved); err != nil {
		t.Fatal(err)
	}
	junction(t, parent, moved)

	// Act
	_, childErr := AdmitChild(admitted, "entry.json")

	// Assert
	if childErr == nil {
		t.Fatal("AdmitChild admitted an entry reached through a redirected parent")
	}
}
