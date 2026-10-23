// Package paritytest supports the tests that compare request replies with the C# reference vectors captured from main's
// sources. Only tests import it, so it never reaches the helper image.
package paritytest

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"companion-helper/internal/nativefs"
)

// Placeholder stands for the synthetic root in the valid-document vectors.
const Placeholder = "{root}"

var requestDigest = regexp.MustCompile(`"requestSha256":"[0-9a-f]{64}"`)

// Vector reads one committed vector from the calling package's testdata/parity folder.
func Vector(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "parity", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// WindowsRoot is the fixed root of the absent-target vectors, the same path on every machine.
func WindowsRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join("C:"+string(filepath.Separator), "Windows")
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Skip("the vectors' fixed Windows directory is absent")
	}
	return root
}

// Root is a canonical synthetic root for the valid-document vectors.
func Root(t *testing.T) string {
	t.Helper()
	admitted, err := nativefs.Admit(t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	return admitted.Path
}

// Fill replaces the placeholder in a vector with the root as it appears inside a JSON string.
func Fill(vector []byte, root string) []byte {
	return []byte(strings.ReplaceAll(string(vector), Placeholder, escaped(root)))
}

// Comparable replaces the root inside JSON strings with the placeholder and masks the request digest, which covers the
// machine-specific root and so is compared only in the fixed-path vectors.
func Comparable(reply []byte, root string) string {
	replaced := strings.ReplaceAll(string(reply), escaped(root), Placeholder)
	return requestDigest.ReplaceAllString(replaced, `"requestSha256":"masked"`)
}

func escaped(root string) string {
	backslash := string(rune(92))
	return strings.ReplaceAll(root, backslash, backslash+backslash)
}
