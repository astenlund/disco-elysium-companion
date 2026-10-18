package broker

import (
	"bytes"
	"encoding/json"
	"io"
	"reflect"
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
