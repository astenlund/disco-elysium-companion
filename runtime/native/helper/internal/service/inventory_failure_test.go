package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"companion-helper/internal/inventory"
	"companion-helper/internal/nativefs"
)

func TestInventoryFailureCodesNameTheirCategory(t *testing.T) {
	cases := map[string]struct {
		err  error
		code string
	}{
		"foreign entry at the scope root": {&inventory.ForeignEntryError{Directory: inventory.ScopeRoot}, "foreignEntryScopeRoot"},
		"foreign entry in journal":        {&inventory.ForeignEntryError{Directory: inventory.Journal}, "foreignEntryJournal"},
		"foreign entry in journal events": {&inventory.ForeignEntryError{Directory: inventory.JournalEvents}, "foreignEntryJournalEvents"},
		"foreign entry in operations":     {&inventory.ForeignEntryError{Directory: inventory.Operations}, "foreignEntryOperations"},
		"foreign entry in quarantine":     {&inventory.ForeignEntryError{Directory: inventory.Quarantine}, "foreignEntryQuarantine"},
		"unknown directory label":         {&inventory.ForeignEntryError{Directory: "elsewhere"}, "inventoryUnavailable"},
		"unreadable owned entry":          {inventory.ErrUnreadable, "inventoryUnreadable"},
		"generic unavailability":          {inventory.ErrUnavailable, "inventoryUnavailable"},
		"deadline":                        {nativefs.ErrDeadline, "deadlineExceeded"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			// Act
			code := inventoryFailure(c.err, "inventoryUnavailable")

			// Assert
			if code != c.code {
				t.Fatalf("got %s, want %s", code, c.code)
			}
		})
	}
}

func TestInventoryRequestReportsAForeignEntryByItsDirectory(t *testing.T) {
	// Arrange
	companion := companionFor(t)
	scope := filepath.Join(companion, "scope")
	binding := []byte(`{"runtimeScopeVersion":1}`)
	if err := os.MkdirAll(filepath.Join(scope, "journal", "unexpected"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(scope, "scope.json"), binding, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(binding)
	rootJSON, _ := json.Marshal(scope)
	s := startIn(t, companion)

	// Act
	s.send(fmt.Sprintf(`{"version":1,"seq":1,"op":"inventory","deadlineMs":5000,"root":%s,"scopeSha256":"%s","companionRoot":null,"mode":"Inventory","inputBase64":null,"inputFile":null,"inputSha256":null}`,
		rootJSON, hex.EncodeToString(sum[:])))
	reply := s.read()

	// Assert
	if reply["status"] != "error" || reply["code"] != "foreignEntryJournal" {
		t.Fatalf("a foreign folder in journal answered %v", reply)
	}
	if code := s.exitCode(); code != exitClean {
		t.Fatalf("exit %d", code)
	}
}
