package nativefs_test

import (
	"os"
	"path/filepath"
	"testing"

	"companion-helper/internal/nativefs"
	"companion-helper/internal/paritytest"
)

// The parity vectors were captured from main's C# FileHashes for synthetic inputs before those sources were removed.

func TestHashRepliesMatchTheCSharpVectors(t *testing.T) {
	// Arrange: absent targets under the fixed Windows root, and a synthetic root holding one plain file.
	windows := paritytest.WindowsRoot(t)
	root := paritytest.Root(t)
	if err := os.WriteFile(filepath.Join(root, "plain.txt"), []byte("synthetic\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Act
	absent, absentErr := nativefs.ReadHashes(windows, paritytest.Vector(t, "hash-absent-request.json"), nil)
	valid, validErr := nativefs.ReadHashes(root, paritytest.Fill(paritytest.Vector(t, "hash-valid-request.json"), root), nil)

	// Assert: the fixed-path reply matches byte for byte, digest included; the synthetic one matches apart from its root.
	if absentErr != nil || validErr != nil {
		t.Fatalf("hash requests failed: %v %v", absentErr, validErr)
	}
	if string(absent) != string(paritytest.Vector(t, "hash-absent-reply.json")) {
		t.Fatalf("absent-target reply differs from C#:\n%s", absent)
	}
	if paritytest.Comparable(valid, root) != paritytest.Comparable(paritytest.Vector(t, "hash-valid-reply.json"), root) {
		t.Fatalf("synthetic reply differs from C#:\n%s", valid)
	}
}
