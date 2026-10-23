package inventory

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"companion-helper/internal/nativefs"
)

// testdata/scope is a synthetic runtime-data scope; inventory.json and marker.json are the outputs the C#
// ResourceInventory gave for it, with free space masked, captured before the C# helper sources were removed.

var maskFree = regexp.MustCompile(`"freeBytes":"[0-9]+"`)

func copyScope(t *testing.T) string {
	t.Helper()
	target := filepath.Join(t.TempDir(), "scope")
	err := filepath.Walk(filepath.Join("testdata", "scope"), func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(filepath.Join("testdata", "scope"), path)
		destination := filepath.Join(target, relative)
		if info.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(destination, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return target
}

func expected(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(data))
}

func TestInventoryMatchesCSharpOutputs(t *testing.T) {
	// Arrange
	root := copyScope(t)
	scope := expected(t, "scope-sha256.txt")

	// Act
	inventory, inventoryErr := Read(root, scope, false, "", nativefs.NoDeadline)
	marker, markerErr := Read(root, scope, true, "", nativefs.NoDeadline)

	// Assert
	if inventoryErr != nil || markerErr != nil {
		t.Fatalf("inventory failed: %v %v", inventoryErr, markerErr)
	}
	if got := maskFree.ReplaceAllString(string(inventory), `"freeBytes":"*"`); got != expected(t, "inventory.json") {
		t.Fatalf("inventory differs:\n got %s\nwant %s", got, expected(t, "inventory.json"))
	}
	if got := maskFree.ReplaceAllString(string(marker), `"freeBytes":"*"`); got != expected(t, "marker.json") {
		t.Fatalf("marker differs:\n got %s\nwant %s", got, expected(t, "marker.json"))
	}
}

func TestInventoryRefusesChangedScopeAndUnexpectedEntries(t *testing.T) {
	// Arrange
	root := copyScope(t)
	scope := expected(t, "scope-sha256.txt")

	// Act
	_, changedErr := Read(root, strings.Repeat("0", 64), false, "", nativefs.NoDeadline)
	if err := os.WriteFile(filepath.Join(root, "unexpected.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, unexpectedErr := Read(root, scope, false, "", nativefs.NoDeadline)

	// Assert
	if changedErr == nil || unexpectedErr == nil {
		t.Fatalf("expected refusals, got %v and %v", changedErr, unexpectedErr)
	}
}

func TestQuarantineTrimKeepsTheRetentionLimitAndProtectedFiles(t *testing.T) {
	// Arrange
	root := copyScope(t)
	scope := expected(t, "scope-sha256.txt")
	for index := 0; index < 260; index++ {
		name := filepath.Join(root, "quarantine", "extra."+strings.Repeat("0", 29)+leftPad(index)+".quarantined")
		if err := os.WriteFile(name, []byte{byte(index)}, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	protected := `["quarantine/item.00000000000000000000000000000001.quarantined"]`

	// Act
	result, err := TrimQuarantine(root, scope, []byte(protected), nativefs.NoDeadline)

	// Assert
	if err != nil {
		t.Fatal(err)
	}
	if string(result) != `{"removed":7,"remaining":256}` {
		t.Fatalf("trim result %s", result)
	}
	if _, err := os.Stat(filepath.Join(root, "quarantine", "item.00000000000000000000000000000001.quarantined")); err != nil {
		t.Fatal("a protected file was removed")
	}
}

func leftPad(value int) string { return fmt.Sprintf("%03d", value) }
