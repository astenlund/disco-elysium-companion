package events_test

import (
	"os"
	"path/filepath"
	"testing"

	"companion-helper/internal/events"
	"companion-helper/internal/paritytest"
)

// The parity vectors were captured from main's C# EventInspection for synthetic inputs before those sources were removed;
// the C# reply was inflated from its zlib framing, since the service replies uncompressed.

func TestEventBatchRepliesMatchTheCSharpVectors(t *testing.T) {
	// Arrange: absent targets under the fixed Windows root, and a synthetic root holding the committed accepted event.
	windows := paritytest.WindowsRoot(t)
	root := paritytest.Root(t)
	event, err := os.ReadFile(filepath.Join("testdata", "event-accepted.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "0000000000000001.json"), event, 0o600); err != nil {
		t.Fatal(err)
	}

	// Act
	absent, absentErr := events.ReadBatch(windows, paritytest.Vector(t, "batch-absent-request.json"))
	valid, validErr := events.ReadBatch(root, paritytest.Fill(paritytest.Vector(t, "batch-valid-request.json"), root))

	// Assert: the fixed-path reply matches byte for byte, digest included; the synthetic one matches apart from its root.
	if absentErr != nil || validErr != nil {
		t.Fatalf("batch requests failed: %v %v", absentErr, validErr)
	}
	if string(absent) != string(paritytest.Vector(t, "batch-absent-reply.json")) {
		t.Fatalf("absent-target reply differs from C#:\n%s", absent)
	}
	if paritytest.Comparable(valid, root) != paritytest.Comparable(paritytest.Vector(t, "batch-valid-reply.json"), root) {
		t.Fatalf("synthetic reply differs from C#:\n%s", valid)
	}
}
