package jsondoc

import (
	"encoding/base64"
	"strings"
	"testing"
)

// admissionCases are documents with the verdict System.Text.Json and the C# JsonDocuments.Validate gave them under the
// config profile, captured before the C# helper sources were removed.
var admissionCases = []struct {
	base64 string
	valid  bool
}{
	{"e30=", true},
	{"W10=", true},
	{"IiI=", true},
	{"MA==", true},
	{"LTA=", true},
	{"MS41", true},
	{"MWU1", true},
	{"MUUrNQ==", true},
	{"MWUtNQ==", true},
	{"MDE=", false},
	{"MS4=", false},
	{"LjU=", false},
	{"LQ==", false},
	{"KzE=", false},
	{"MXg=", false},
	{"dHJ1ZQ==", true},
	{"dHJ1ZXg=", false},
	{"bnVs", false},
	{"bnVsbA==", true},
	{"IG51bGwg", true},
	{"CXt9DQo=", true},
	{"eyJhIjoxLH0=", false},
	{"WzEsXQ==", false},
	{"eyJhIjoxICJiIjoyfQ==", false},
	{"eyJhIjoxLCJhIjoyfQ==", false},
	{"eyJhIjoxLCJcdTAwNjEiOjJ9", false},
	{"eyJhIjoiXHVkODAwIn0=", false},
	{"eyJhIjoiXHVkYzAwIn0=", false},
	{"eyJhIjoiXHVkODNkXHVkZTAwIn0=", true},
	{"eyJhIjoiXHVkODNkIn0=", false},
	{"eyJhIjoiXHVkODNkeCJ9", false},
	{"Ilx1MDBlOSI=", true},
	{"Ilx4Ig==", false},
	{"ImEJYiI=", false},
	{"ImFcL2Ii", true},
	{"IlxVMDA0MSI=", false},
	{"LypjKi97fQ==", false},
	{"e30vLw==", false},
	{"e30ge30=", false},
	{"WzEgMl0=", false},
	{"eyJhIn0=", false},
	{"eyJhIjp9", false},
	{"ezoxfQ==", false},
	{"Wyxd", false},
	{"Ilx1MDA0Ig==", false},
	{"MWU=", false},
	{"MWUr", false},
	{"LTAx", false},
	{"LTAuMA==", true},
	{"MGUw", true},
	{"W1tbXV1d", true},
	{"wqB7fQ==", false},
	{"eyLDqSI6IsOpIn0=", true},
	{"WzEsMiwzLDRd", true},
	{"eyJhIjpbeyJiIjp7ImMiOm51bGx9fV19", true},
	{"TmFO", false},
	{"SW5maW5pdHk=", false},
	{"Ig==", false},
	{"Ww==", false},
	{"ew==", false},
	{"eyJhIjox", false},
	{"WzE=", false},
	{"MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkw", true},
	{"77u/e30=", false},
	{"IsMoIg==", false},
	{"Iu2ggCI=", false},
	{"IsCvIg==", false},
	{"IgAi", false},
	{"", false},
	{"W1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1d", true},
	{"eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6MX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fQ==", true},
	{"W1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW11dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV0=", true},
	{"eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjoxfX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fQ==", true},
	{"W1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tdXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXQ==", false},
	{"eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOjF9fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fQ==", false},
	{"W1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1d", false},
	{"eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6eyJhIjp7ImEiOnsiYSI6MX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fX19fQ==", false},
}

func TestAdmissionMatchesCSharpVerdicts(t *testing.T) {
	for index, c := range admissionCases {
		// Arrange
		data, err := base64.StdEncoding.DecodeString(c.base64)
		if err != nil {
			t.Fatal(err)
		}

		// Act
		actual := Validate(data, Config) == nil

		// Assert
		if actual != c.valid {
			t.Fatalf("case %d (%q): valid=%v, want %v", index, data, actual, c.valid)
		}
	}
}

func TestBudgetsAreInclusive(t *testing.T) {
	// Arrange
	array := func(count int) []byte {
		return []byte("[" + strings.TrimSuffix(strings.Repeat("1,", count), ",") + "]")
	}
	text := func(count int) []byte { return []byte("[\"" + strings.Repeat("x", count) + "\"]") }
	padded := func(count int) []byte { return []byte("[" + strings.Repeat(" ", count-2) + "]") }
	cases := []struct {
		name  string
		data  []byte
		valid bool
	}{
		{"tokens at the bound", array(65534), true},
		{"tokens over the bound", array(65535), false},
		{"text at the bound", text(524288), true},
		{"text over the bound", text(524289), false},
		{"bytes at the bound", padded(1048576), true},
		{"bytes over the bound", padded(1048577), false},
	}
	for _, c := range cases {
		// Act
		actual := Validate(c.data, Config) == nil

		// Assert
		if actual != c.valid {
			t.Fatalf("%s: valid=%v, want %v", c.name, actual, c.valid)
		}
	}
}

func TestWriterEscapesLikeUtf8JsonWriter(t *testing.T) {
	// Arrange
	cases := map[string]string{
		"plain":                  `"plain"`,
		"\b\f\n\r\t":             `"\b\f\n\r\t"`,
		"\x00\x1f\x7f":           `"\u0000\u001F\u007F"`,
		"\"&'+<>\\`":             `"\u0022\u0026\u0027\u002B\u003C\u003E\\\u0060"`,
		"\u00e9\u20ac\U0001F600": `"\u00E9\u20AC\uD83D\uDE00"`,
	}
	for input, expected := range cases {
		// Act
		actual := string(AppendString(nil, input))

		// Assert
		if actual != expected {
			t.Fatalf("escape of %q is %s, want %s", input, actual, expected)
		}
	}
}
