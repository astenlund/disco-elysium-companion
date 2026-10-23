package events

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	j "companion-helper/internal/jsondoc"
)

// The testdata outputs were captured from the C# PayloadCodec and RuntimeCodec for the shared synthetic payload sample
// before those sources were removed; matching them byte for byte keeps stored journals and their digests compatible.

func golden(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func requireBytes(t *testing.T, label string, actual []byte, err error, expected []byte) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s failed: %v", label, err)
	}
	if !bytes.Equal(actual, expected) {
		t.Fatalf("%s differs from the C# output:\n got %s\nwant %s", label, actual, expected)
	}
}

func TestCodecMatchesCSharpOutputs(t *testing.T) {
	// Arrange
	source := golden(t, "source.json")
	pending := golden(t, "metadata-pending.json")
	accepted := golden(t, "metadata-accepted.json")
	compact := golden(t, "metadata-compact.json")

	// Act
	created, createErr := CreateEvent(source, pending)
	binding, bindingErr := Verify(golden(t, "event-created.json"))
	rewritten, rewriteErr := RewriteEvent(golden(t, "event-created.json"), accepted, false)
	compacted, compactErr := RewriteEvent(golden(t, "event-accepted.json"), compact, true)
	reconstructed, reconstructErr := ReconstructEvent(source, accepted, strings.TrimSpace(string(golden(t, "binding.txt"))))

	// Assert
	requireBytes(t, "created event", created, createErr, golden(t, "event-created.json"))
	requireBytes(t, "binding", []byte(binding), bindingErr, golden(t, "binding.txt"))
	requireBytes(t, "accepted rewrite", rewritten, rewriteErr, golden(t, "event-accepted.json"))
	requireBytes(t, "compacted rewrite", compacted, compactErr, golden(t, "event-compacted.json"))
	requireBytes(t, "reconstructed event", reconstructed, reconstructErr, golden(t, "event-reconstructed.json"))
}

func TestDescriptionsMatchCSharpOutputs(t *testing.T) {
	// Arrange
	cases := []struct {
		input, expected string
		source          bool
		sequence        int64
	}{
		{"source.json", "describe-source.json", true, 1},
		{"event-accepted.json", "describe-accepted.json", false, 0},
		{"event-compacted.json", "describe-compacted.json", false, 0},
	}
	for _, c := range cases {
		// Act
		description, err := InspectFrozen(golden(t, c.input), c.source, c.sequence)

		// Assert
		requireBytes(t, c.expected, description, err, golden(t, c.expected))
	}
}

func TestPayloadValuesSurviveWithoutReserialization(t *testing.T) {
	// Arrange
	created := golden(t, "event-created.json")

	// Act
	root, err := j.Parse(created, j.StateEvent)

	// Assert
	if err != nil {
		t.Fatal(err)
	}
	state := string(root.Get("payload").Get("state").Raw)
	for _, literal := range []string{"9007199254740993", "0.123456789012345678901", "-0", "1e400", `a`, "2026-10-07T01:23:45.1234567Z"} {
		if !strings.Contains(state, literal) {
			t.Fatalf("state lost raw token %s", literal)
		}
	}
}

func TestVerifyRejectsChangedPayloadAndDamagedMetadata(t *testing.T) {
	// Arrange
	accepted := string(golden(t, "event-accepted.json"))
	damaged := []string{
		strings.Replace(accepted, "9007199254740993", "9007199254740994", 1),
		strings.Replace(accepted, `"sequence":1,`, `"sequence":0,`, 1),
		strings.Replace(accepted, `"sequence":1,`, `"sequence":9007199254740992,`, 1),
		strings.Replace(accepted, `"sequence":1,`, `"sequence":1.5,`, 1),
		strings.Replace(accepted, `"occurredAt":"2026-10-07T01:23:45.1234567Z"`, `"occurredAt":"2026-02-30T01:23:45.1234567Z"`, 1),
		strings.Replace(accepted, `"settlement":"accepted"`, `"settlement":"done"`, 1),
	}
	for index, document := range damaged {
		if document == accepted {
			t.Fatalf("mutation %d did not apply", index)
		}

		// Act
		_, err := Verify([]byte(document))

		// Assert
		if err == nil {
			t.Fatalf("mutation %d was accepted", index)
		}
	}
}

func TestCompactedEventCannotRestoreItsPayload(t *testing.T) {
	// Arrange
	compacted := golden(t, "event-compacted.json")
	accepted := golden(t, "metadata-accepted.json")

	// Act
	_, err := RewriteEvent(compacted, accepted, false)

	// Assert
	if err == nil {
		t.Fatal("a compacted event regained a payload")
	}
}
