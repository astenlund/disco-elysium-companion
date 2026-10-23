package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	j "companion-helper/internal/jsondoc"
)

// eventRequest sends one Event-mode inventory request for a staged input file and returns its reply.
func eventRequest(s *session, seq int, root, inputFile, inputSha256 string) map[string]any {
	rootJSON, _ := json.Marshal(root)
	fileJSON, _ := json.Marshal(inputFile)
	s.send(fmt.Sprintf(`{"version":1,"seq":%d,"op":"inventory","deadlineMs":5000,"root":%s,"scopeSha256":"%s","companionRoot":null,"mode":"Event","inputBase64":null,"inputFile":%s,"inputSha256":"%s"}`,
		seq, rootJSON, strings.Repeat("0", 64), fileJSON, inputSha256))
	return s.read()
}

func stage(t *testing.T, directory, name string, data []byte) (string, string) {
	t.Helper()
	path := filepath.Join(directory, name+"."+strings.Repeat("a", 32)+".tmp")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return path, hex.EncodeToString(sum[:])
}

func TestEventModeReadsItsStagedInputFile(t *testing.T) {
	// Arrange: a committed event document staged inside the companion root, and the same bytes staged outside it.
	companion := companionFor(t)
	outside := companionFor(t)
	event, err := os.ReadFile(filepath.Join("..", "events", "testdata", "event-created.json"))
	if err != nil {
		t.Fatal(err)
	}
	inside, digest := stage(t, companion, "0000000000000001.json", event)
	foreign, _ := stage(t, outside, "0000000000000001.json", event)
	unstaged := filepath.Join(companion, "0000000000000002.json")
	if err := os.WriteFile(unstaged, event, 0o600); err != nil {
		t.Fatal(err)
	}
	oversized, oversizedDigest := stage(t, companion, "0000000000000003.json", []byte("{}"))
	if err := os.Truncate(oversized, int64(j.StateEvent.Bytes)+1); err != nil {
		t.Fatal(err)
	}
	s := startIn(t, companion)

	// Act
	admitted := eventRequest(s, 1, companion, inside, digest)
	mismatched := eventRequest(s, 2, companion, inside, strings.Repeat("0", 64))
	outsideRoot := eventRequest(s, 3, companion, foreign, digest)
	notStaged := eventRequest(s, 4, companion, unstaged, digest)
	overBudget := eventRequest(s, 5, companion, oversized, oversizedDigest)

	// Assert
	result, _ := admitted["result"].(map[string]any)
	if admitted["status"] != "ok" || result["admitted"] != true {
		t.Fatalf("a staged event inside the root answered %v", admitted)
	}
	for name, reply := range map[string]map[string]any{"digest mismatch": mismatched, "outside the root": outsideRoot, "not a staging name": notStaged, "over the budget": overBudget} {
		if reply["status"] != "error" || reply["code"] != "inventoryUnavailable" {
			t.Fatalf("a staged event %s answered %v", name, reply)
		}
	}
	if code := s.exitCode(); code != exitClean {
		t.Fatalf("exit %d", code)
	}
}
