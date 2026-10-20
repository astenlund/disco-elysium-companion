package broker

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestEnvironmentPairsDoNotAddSystemRoot(t *testing.T) {
	values := map[string]string{"PATH": "C:/Tools", "EMPTY": ""}
	pairs := environmentPairs(values)
	if !reflect.DeepEqual(pairs, []string{"EMPTY=", "PATH=C:/Tools"}) {
		t.Fatal("explicit child environment changed")
	}
}

func TestControlReaderPreservesFollowingChildInput(t *testing.T) {
	frame := encodeControl(t, validControl())
	input := append(append(append([]byte{}, frame...), byte(10)), []byte("child input")...)
	spec, reader, err := readControl(bytes.NewReader(input))
	if err != nil || spec.parentPID != 42 {
		t.Fatal("valid control frame was refused")
	}
	remainder, err := io.ReadAll(reader)
	if err != nil || string(remainder) != "child input" {
		t.Fatal("child input after control frame was lost")
	}
}

func TestOwnedHeaderHasExactFieldSet(t *testing.T) {
	data, err := json.Marshal(ownedHeader{1, "job", 3, "4", 5, "6"})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ownedProcessVersion", "jobName", "pid", "created", "brokerPid", "brokerCreated"} {
		if _, exists := fields[name]; !exists {
			t.Fatal("owned-process header field missing")
		}
	}
	if len(fields) != 6 {
		t.Fatal("owned-process header has extra fields")
	}
}

func TestExecutablePathAppendsOnlyExeToBareNames(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("PATH", directory)
	if err := os.WriteFile(filepath.Join(directory, "probe.cmd"), []byte("@exit 1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if path, err := executablePath("probe"); err == nil {
		t.Fatalf("bare name resolved to a command shim: %s", path)
	}
	executable := filepath.Join(directory, "probe.exe")
	if err := os.WriteFile(executable, []byte("MZ"), 0o600); err != nil {
		t.Fatal(err)
	}
	path, err := executablePath("probe")
	if err != nil || !strings.EqualFold(path, executable) {
		t.Fatalf("bare name resolved to %q, %v", path, err)
	}
}

func TestExecutablePathRefusesDirectories(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("PATH", directory)
	if err := os.Mkdir(filepath.Join(directory, "probe.exe"), 0o700); err != nil {
		t.Fatal(err)
	}
	if path, err := executablePath("probe"); err == nil {
		t.Fatalf("bare name resolved to a directory: %s", path)
	}
}

// The test environment may redirect LOCALAPPDATA and USERPROFILE, so the aliases are found through the token's profile.
func TestLaunchableFileAcceptsAppExecutionAliases(t *testing.T) {
	aliases := filepath.Join(profileDirectory(t), "AppData", "Local", "Microsoft", "WindowsApps")
	entries, err := os.ReadDir(aliases)
	if err != nil {
		t.Skip("no app execution alias folder")
	}
	for _, entry := range entries {
		alias := filepath.Join(aliases, entry.Name())
		info, err := os.Stat(alias)
		if err != nil || !strings.EqualFold(filepath.Ext(alias), ".exe") || info.Mode()&os.ModeIrregular == 0 {
			continue
		}
		if _, err := launchableFile(alias); err != nil {
			t.Fatalf("app execution alias refused: %s: %v", alias, err)
		}
		return
	}
	t.Skip("no app execution alias")
}

func profileDirectory(t *testing.T) string {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		t.Skip("process token is unavailable")
	}
	defer token.Close()
	profile, err := token.GetUserProfileDirectory()
	if err != nil {
		t.Skip("user profile directory is unavailable")
	}
	return profile
}

func TestChildLaunchRequestsItsOwnHiddenConsole(t *testing.T) {
	attributes := childAttributes()
	if !attributes.HideWindow || attributes.CreationFlags&createNoWindow == 0 {
		t.Fatal("child launch shares the broker console")
	}
}
