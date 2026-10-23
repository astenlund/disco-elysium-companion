package context

import (
	"errors"
	"strings"
	"testing"

	j "companion-helper/internal/jsondoc"
)

// These cases were carried over from the deleted Test-ContextFingerprint.ps1 suite.

const fingerprintBase = `{"interactionId":"one","requestReceivedAt":"old","freshness":{"state":"fresh","class":null,"reason":null,"lastGoodGeneratedAt":"old"},` +
	`"operational":{"state":"current","warnings":[]},"correction":null,"degraded":null,"events":[{"eventId":"one","sequence":1,"redelivery":false,` +
	`"type":"state.consumed","baselineReset":false,"warnings":[],"diff":{"currentSource":{"save":"old"},"currentGeneratedAt":"old","baselineGeneratedAt":"old",` +
	`"value":1}}],"state":{"generatedAt":"old","source":{"save":"old"},"extra":{"value":9007199254740993,"source":"meaningful"}}}`

func mustFingerprint(t *testing.T, document, instructionsHash, providerHash string) string {
	t.Helper()
	value, err := Fingerprint([]byte(document), instructionsHash, providerHash)
	if err != nil {
		t.Fatalf("fingerprint of %.80s failed: %v", document, err)
	}
	return value
}

func TestFingerprintIgnoresInteractionSourceTimestampAndRedeliveryChurn(t *testing.T) {
	// Arrange
	churn := strings.NewReplacer(`"old"`, `"new"`, `"one"`, `"two"`, `"sequence":1`, `"sequence":2`, `"redelivery":false`, `"redelivery":true`).Replace(fingerprintBase)

	// Act
	first := mustFingerprint(t, fingerprintBase, instructions, provider)
	churned := mustFingerprint(t, churn, instructions, provider)

	// Assert
	if first != churned {
		t.Fatalf("churn changed the fingerprint: %s and %s", first, churned)
	}
}

func TestFingerprintKeepsSubstantiveChangesDistinct(t *testing.T) {
	// Arrange
	changes := [][2]string{
		{"9007199254740993", "9007199254740992"},
		{`"meaningful"`, `"different"`},
		{`"baselineReset":false`, `"baselineReset":true`},
		{`"state":"fresh"`, `"state":"failed"`},
		{`"correction":null`, `"correction":{"correctionId":"x","reason":"contextUncertain"}`},
	}
	first := mustFingerprint(t, fingerprintBase, instructions, provider)
	for _, change := range changes {
		// Act
		changed := mustFingerprint(t, strings.Replace(fingerprintBase, change[0], change[1], 1), instructions, provider)

		// Assert
		if changed == first {
			t.Fatalf("replacing %s with %s left the fingerprint unchanged", change[0], change[1])
		}
	}
}

func TestFingerprintIncludesInstructionsAndProviderOptions(t *testing.T) {
	// Arrange
	other := strings.Repeat("c", 64)

	// Act
	first := mustFingerprint(t, fingerprintBase, instructions, provider)
	withInstructions := mustFingerprint(t, fingerprintBase, other, provider)
	withProvider := mustFingerprint(t, fingerprintBase, instructions, other)

	// Assert
	if withInstructions == first {
		t.Fatal("instructions do not participate in candidate comparison")
	}
	if withProvider == first {
		t.Fatal("effective provider options do not participate in candidate comparison")
	}
}

func TestFingerprintComparesPropertyOrderEscapesAndExactDecimalsSemantically(t *testing.T) {
	// Arrange: the string value is spelled with a unicode escape for "a", built from the backslash code point.
	escaped := `{"state":{"extra":{"s":"` + string(rune(92)) + `u0061","n":[1.0,100e-2,-0]}}}`
	plain := `{"state":{"extra":{"n":[1,1,0],"s":"a"}}}`

	// Act
	left := mustFingerprint(t, escaped, instructions, provider)
	right := mustFingerprint(t, plain, instructions, provider)

	// Assert
	if left != right {
		t.Fatalf("semantically equal contexts fingerprint differently: %s and %s", left, right)
	}
}

func TestFingerprintNeverPassesLargeExponentsThroughFloatingPoint(t *testing.T) {
	// Arrange
	exponent := strings.Repeat("9", 10000)
	lowerExponent := strings.Repeat("9", 9999) + "8"
	cases := [][2]string{
		{`{"state":{"extra":{"n":1e400}}}`, `{"state":{"extra":{"n":10e399}}}`},
		{`{"state":{"extra":{"n":1e` + exponent + `}}}`, `{"state":{"extra":{"n":10e` + lowerExponent + `}}}`},
	}
	for _, c := range cases {
		// Act
		left := mustFingerprint(t, c[0], instructions, provider)
		right := mustFingerprint(t, c[1], instructions, provider)

		// Assert
		if left != right {
			t.Fatalf("equal magnitudes fingerprint differently: %.40s and %.40s", c[0], c[1])
		}
	}
}

func TestFingerprintRefusesDuplicateProperties(t *testing.T) {
	// Arrange
	duplicated := []byte(`{"state":null,"state":{}}`)

	// Act
	_, err := Fingerprint(duplicated, instructions, provider)

	// Assert
	if !errors.Is(err, j.ErrInvalid) {
		t.Fatalf("a duplicate property answered %v", err)
	}
}
