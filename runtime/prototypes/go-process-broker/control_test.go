package broker

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func validControl() map[string]any {
	return map[string]any{
		"command":               "C:/Tools/child.exe",
		"args":                  []string{"", "input"},
		"cwd":                   "C:/Work",
		"jobName":               "Global" + string(rune(92)) + "game-companion-process-0123456789abcdef0123456789abcdef-core",
		"parentPid":             42,
		"parentCreated":         "123456789",
		"brokerProtocolVersion": 2,
		"childEnvironment":      map[string]string{"PATH": "C:/Tools"},
	}
}

func encodeControl(t *testing.T, value map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestControlAcceptsExactFrame(t *testing.T) {
	frame := encodeControl(t, validControl())
	result, err := parseControl(frame)
	if err != nil {
		t.Fatal(err)
	}
	if result.command != "C:/Tools/child.exe" || result.parentPID != 42 || len(result.args) != 2 ||
		result.args[0] != "" || result.childEnvironment["PATH"] != "C:/Tools" {
		t.Fatal("parsed control differs from input")
	}
	reader := bufio.NewReader(bytes.NewReader(append(frame, byte(10))))
	read, err := readControlFrame(reader)
	if err != nil || !bytes.Equal(read, frame) {
		t.Fatal("bounded frame read differs from input")
	}
}

func TestControlRejectsMissingUnknownAndDuplicateFields(t *testing.T) {
	missing := validControl()
	delete(missing, "parentCreated")
	unknown := validControl()
	unknown["extra"] = true
	quote := string(rune(34))
	complete := encodeControl(t, validControl())
	duplicate := append([]byte{}, complete[:len(complete)-1]...)
	duplicate = append(duplicate, []byte(","+quote+"command"+quote+":"+quote+"other"+quote+"}")...)
	for _, frame := range [][]byte{encodeControl(t, missing), encodeControl(t, unknown), duplicate} {
		if _, err := parseControl(frame); !errors.Is(err, errControl) {
			t.Fatal("invalid field set accepted")
		}
	}
}

func TestControlRejectsWrongKindsAndEnvironmentCollisions(t *testing.T) {
	cases := []func(map[string]any){
		func(value map[string]any) { value["brokerProtocolVersion"] = 1 },
		func(value map[string]any) { value["parentPid"] = 3.5 },
		func(value map[string]any) { value["args"] = nil },
		func(value map[string]any) { value["args"] = []any{"ok", nil} },
		func(value map[string]any) { value["command"] = "" },
		func(value map[string]any) { value["childEnvironment"] = map[string]string{"PATH": "x", "path": "y"} },
		func(value map[string]any) { value["childEnvironment"] = map[string]string{"BAD=NAME": "x"} },
		func(value map[string]any) {
			value["childEnvironment"] = map[string]string{"NAME": "x" + string(rune(0))}
		},
	}
	for index, alter := range cases {
		value := validControl()
		alter(value)
		if _, err := parseControl(encodeControl(t, value)); !errors.Is(err, errControl) {
			t.Fatalf("invalid control case %d accepted", index)
		}
	}
}

func TestControlRejectsIncompleteOversizeAndInvalidUTF8(t *testing.T) {
	frame := encodeControl(t, validControl())
	cases := [][]byte{frame, append(append([]byte{}, frame...), byte(255), byte(10)),
		append(bytes.Repeat([]byte{byte(32)}, maxControlBytes+1), byte(10))}
	for index, input := range cases {
		if _, err := readControlFrame(bufio.NewReader(bytes.NewReader(input))); !errors.Is(err, errControl) {
			t.Fatalf("invalid frame case %d accepted", index)
		}
	}
}

func TestControlAppliesDecodedTextAndTokenBudgets(t *testing.T) {
	tooMuchText := validControl()
	tooMuchText["command"] = strings.Repeat("x", maxControlTextBytes+1)
	if _, err := parseControl(encodeControl(t, tooMuchText)); !errors.Is(err, errControl) {
		t.Fatal("decoded text beyond the config budget was accepted")
	}

	atTokenLimit := validControl()
	atTokenLimit["args"] = make([]string, maxControlTokens-22)
	if _, err := parseControl(encodeControl(t, atTokenLimit)); err != nil {
		t.Fatal("control at the config token limit was refused", err)
	}
	overTokenLimit := validControl()
	overTokenLimit["args"] = make([]string, maxControlTokens-21)
	if _, err := parseControl(encodeControl(t, overTokenLimit)); !errors.Is(err, errControl) {
		t.Fatal("control beyond the config token budget was accepted")
	}
}
