package context

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The testdata outputs were captured from the C# ContextCodec and ContextFingerprint before those sources were
// removed; matching them byte for byte keeps published contexts and their fingerprints compatible.

const (
	generation   = "11111111111111111111111111111111"
	instructions = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	provider     = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func golden(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func acceptedRecord(t *testing.T) *Record {
	t.Helper()
	event := golden(t, "event-accepted.json")
	sum := sha256.Sum256(event)
	record, err := RecordFromFrozen(event, hex.EncodeToString(sum[:]), generation, true)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func TestRenderingMatchesCSharpOutput(t *testing.T) {
	// Arrange
	record := acceptedRecord(t)
	selection := []Selection{{Record: record}}

	// Act
	rendered, err := Render(golden(t, "template.json"), selection, record, generation, nil, false, false, instructions, provider, MaximumBlockBytes)

	// Assert
	if err != nil || rendered == nil {
		t.Fatalf("render failed: %v", err)
	}
	if !bytes.Equal(rendered.Bytes, golden(t, "context-rendered.txt")) {
		t.Fatalf("rendered block differs:\n got %s\nwant %s", rendered.Bytes, golden(t, "context-rendered.txt"))
	}
	if rendered.Fingerprint != string(golden(t, "context-fingerprint.txt")) {
		t.Fatalf("fingerprint %s differs from %s", rendered.Fingerprint, golden(t, "context-fingerprint.txt"))
	}
}

func TestRedeliveryMatchesCSharpOutput(t *testing.T) {
	// Arrange
	record := acceptedRecord(t)
	rendered, err := Render(golden(t, "template.json"), []Selection{{Record: record}}, record, generation, nil, false, false, instructions, provider, MaximumBlockBytes)
	if err != nil {
		t.Fatal(err)
	}

	// Act
	redelivered, err := Redeliver(rendered, instructions, provider)

	// Assert
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(redelivered.Bytes, golden(t, "context-redelivered.txt")) {
		t.Fatal("redelivered block differs from the C# output")
	}
	var offsets []string
	for _, offset := range redelivered.Offsets {
		offsets = append(offsets, strconv.FormatUint(uint64(offset), 10))
	}
	if strings.Join(offsets, ",") != string(golden(t, "context-offsets.txt")) {
		t.Fatalf("offsets %v differ from %s", offsets, golden(t, "context-offsets.txt"))
	}
}

func TestHeaderFloorMatchesCSharpOutput(t *testing.T) {
	// Arrange
	record := acceptedRecord(t)
	degraded := "eventTooLarge"

	// Act
	rendered, err := Render(golden(t, "template.json"), []Selection{{Record: record}}, nil, generation, &degraded, true, true, instructions, provider, MaximumBlockBytes)

	// Assert
	if err != nil || rendered == nil || !bytes.Equal(rendered.Bytes, golden(t, "context-floor.txt")) {
		t.Fatalf("floor rendering differs from the C# output: %v", err)
	}
}

func TestFingerprintNumberNormalizationMatchesCSharp(t *testing.T) {
	// Arrange
	lines := strings.Split(strings.TrimSpace(string(golden(t, "fingerprint-numbers.txt"))), "\n")
	for _, line := range lines {
		number, expected, _ := strings.Cut(strings.TrimSpace(line), " ")

		// Act
		actual, err := Fingerprint([]byte(`{"companionTurnContextVersion":1,"n":`+number+`}`), instructions, provider)

		// Assert
		if err != nil || actual != expected {
			t.Fatalf("number %s fingerprint %s, want %s (%v)", number, actual, expected, err)
		}
	}
}

func TestRenderRefusesInconsistentOptions(t *testing.T) {
	// Arrange
	record := acceptedRecord(t)
	degraded := "eventTooLarge"
	unknown := "other"
	cases := []struct {
		degraded              *string
		omitDiff, omitWarning bool
		selection             []Selection
	}{
		{&unknown, false, false, nil},
		{nil, true, false, nil},
		{&degraded, false, true, nil},
		{&degraded, true, false, []Selection{{Record: record}, {Record: record}}},
	}
	for index, c := range cases {
		// Act
		_, err := Render(golden(t, "template.json"), c.selection, nil, generation, c.degraded, c.omitDiff, c.omitWarning, instructions, provider, MaximumBlockBytes)

		// Assert
		if err == nil {
			t.Fatalf("case %d rendered", index)
		}
	}
}
