package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateDumpDocumentExactShape(t *testing.T) {
	complete := []byte(`{"source":{"zipName":"save.zip","byteLength":1,"contentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":["save.1st.ntwtf.json"]},"header":{"h":1},"world":{"w":2},"states":{"areaStates":{"A":{"x":1}},"shownOrbs":{}},"tlv":{"variables":{"TASK.X":true},"allTables":[{},{},{},{},{}]}}`)
	variablesOnly := []byte(`{"source":{"zipName":"save.zip","byteLength":1,"contentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":["save.1st.ntwtf.json"]},"header":{"h":1},"world":{"w":2},"states":{"areaStates":{},"shownOrbs":{}},"tlv":{"variables":{"TASK.X":true}}}`)
	tests := []struct {
		name          string
		data          []byte
		variablesOnly bool
		wantErr       bool
	}{
		{name: "complete valid", data: complete},
		{name: "variables-only valid", data: variablesOnly, variablesOnly: true},
		{name: "complete extra root", data: bytes.Replace(complete, []byte(`"header"`), []byte(`"extra":{},"header"`), 1), wantErr: true},
		{name: "complete missing world", data: bytes.Replace(complete, []byte(`,"world":{"w":2}`), nil, 1), wantErr: true},
		{name: "complete null states", data: bytes.Replace(complete, []byte(`{"areaStates":{"A":{"x":1}},"shownOrbs":{}}`), []byte(`null`), 1), wantErr: true},
		{name: "complete wrong allTables kind", data: bytes.Replace(complete, []byte(`[{},{},{},{},{}]`), []byte(`{}`), 1), wantErr: true},
		{name: "variables-only extra allTables", data: bytes.Replace(variablesOnly, []byte(`"variables":{"TASK.X":true}`), []byte(`"variables":{"TASK.X":true},"allTables":[]`), 1), variablesOnly: true, wantErr: true},
		{name: "variables-only missing variables", data: bytes.Replace(variablesOnly, []byte(`"variables":{"TASK.X":true}`), []byte(`"other":{}`), 1), variablesOnly: true, wantErr: true},
		{name: "variables-only null variables", data: bytes.Replace(variablesOnly, []byte(`{"TASK.X":true}`), []byte(`null`), 1), variablesOnly: true, wantErr: true},
		{name: "variables-only wrong source kind", data: bytes.Replace(variablesOnly, []byte(`{"zipName":"save.zip","byteLength":1,"contentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":["save.1st.ntwtf.json"]}`), []byte(`[]`), 1), variablesOnly: true, wantErr: true},
		{name: "complete extra states namespace", data: bytes.Replace(complete, []byte(`"shownOrbs":{}`), []byte(`"shownOrbs":{},"extra":{}`), 1), wantErr: true},
		{name: "complete missing states namespace", data: bytes.Replace(complete, []byte(`,"shownOrbs":{}`), nil, 1), wantErr: true},
		{name: "complete null state record", data: bytes.Replace(complete, []byte(`{"x":1}`), []byte(`null`), 1), wantErr: true},
		{name: "complete wrong state field kind", data: bytes.Replace(complete, []byte(`"x":1`), []byte(`"x":"1"`), 1), wantErr: true},
		{name: "complete fractional state field", data: bytes.Replace(complete, []byte(`"x":1`), []byte(`"x":1.5`), 1), wantErr: true},
		{name: "complete duplicate state field", data: bytes.Replace(complete, []byte(`"x":1`), []byte(`"x":1,"\u0078":2`), 1), wantErr: true},
		{name: "complete variable array", data: bytes.Replace(complete, []byte(`"TASK.X":true`), []byte(`"TASK.X":[]`), 1), wantErr: true},
		{name: "complete nested table array", data: bytes.Replace(complete, []byte(`[{},{},{},{},{}]`), []byte(`[{"s:x":[]},{},{},{},{}]`), 1), wantErr: true},
		{name: "complete scalar table", data: bytes.Replace(complete, []byte(`[{},{},{},{},{}]`), []byte(`[1,{},{},{},{}]`), 1), wantErr: true},
		{name: "complete duplicate nested TLV key", data: bytes.Replace(complete, []byte(`[{},{},{},{},{}]`), []byte(`[{"s:x":1,"s:\u0078":2},{},{},{},{}]`), 1), wantErr: true},
		{name: "variables-only wrong state field", data: bytes.Replace(variablesOnly, []byte(`"areaStates":{}`), []byte(`"areaStates":{"A":{"x":null}}`), 1), variablesOnly: true, wantErr: true},
		{name: "variables-only variable array", data: bytes.Replace(variablesOnly, []byte(`"TASK.X":true`), []byte(`"TASK.X":[]`), 1), variablesOnly: true, wantErr: true},
		{name: "variables-only duplicate variable", data: bytes.Replace(variablesOnly, []byte(`"TASK.X":true`), []byte(`"TASK.X":true,"TASK.\u0058":false`), 1), variablesOnly: true, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Permitting extra, missing, null, or wrong-kind fields in either mode makes this fail.
			err := validateDumpDocument(test.data, test.variablesOnly)

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

func TestValidateDumpDocumentProjectedTLVKeys(t *testing.T) {
	complete := []byte(`{"source":{"zipName":"save.zip","byteLength":1,"contentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":["save.1st.ntwtf.json"]},"header":{},"world":{},"states":{"areaStates":{},"shownOrbs":{}},"tlv":{"variables":{"TASK.X":true},"allTables":[{},{},{},{},{}]}}`)
	variablesOnly := []byte(`{"source":{"zipName":"save.zip","byteLength":1,"contentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":["save.1st.ntwtf.json"]},"header":{},"world":{},"states":{"areaStates":{},"shownOrbs":{}},"tlv":{"variables":{"TASK.X":true}}}`)
	tests := []struct {
		name          string
		data          []byte
		variablesOnly bool
		wantErr       bool
	}{
		{name: "complete canonical keys", data: bytes.Replace(complete, []byte(`[{},`), []byte(`[{"s:":1,"b:0":2,"b:1":3,"n:0000000000000000":4},`), 1)},
		{name: "untagged table key", data: bytes.Replace(complete, []byte(`[{},`), []byte(`[{"x":1},`), 1), wantErr: true},
		{name: "invalid Boolean key", data: bytes.Replace(complete, []byte(`[{},`), []byte(`[{"b:2":1},`), 1), wantErr: true},
		{name: "short numeric key", data: bytes.Replace(complete, []byte(`[{},`), []byte(`[{"n:0":1},`), 1), wantErr: true},
		{name: "uppercase numeric key", data: bytes.Replace(complete, []byte(`[{},`), []byte(`[{"n:000000000000000A":1},`), 1), wantErr: true},
		{name: "nonhex numeric key", data: bytes.Replace(complete, []byte(`[{},`), []byte(`[{"n:000000000000000g":1},`), 1), wantErr: true},
		{name: "negative zero numeric key", data: bytes.Replace(complete, []byte(`[{},`), []byte(`[{"n:8000000000000000":1},`), 1), wantErr: true},
		{name: "infinite numeric key", data: bytes.Replace(complete, []byte(`[{},`), []byte(`[{"n:7ff0000000000000":1},`), 1), wantErr: true},
		{name: "NaN numeric key", data: bytes.Replace(complete, []byte(`[{},`), []byte(`[{"n:7ff8000000000000":1},`), 1), wantErr: true},
		{name: "malformed string tag", data: bytes.Replace(complete, []byte(`[{},`), []byte(`[{"s":1},`), 1), wantErr: true},
		{name: "complete nested invalid key", data: bytes.Replace(complete, []byte(`"TASK.X":true`), []byte(`"TASK.X":{"s:outer":{"x":1}}`), 1), wantErr: true},
		{name: "variables-only nested invalid key", data: bytes.Replace(variablesOnly, []byte(`"TASK.X":true`), []byte(`"TASK.X":{"s:outer":{"x":1}}`), 1), variablesOnly: true, wantErr: true},
		{name: "variables-only untagged root remains legal", data: variablesOnly, variablesOnly: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateDumpDocument(test.data, test.variablesOnly)

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

func dumpWithNestedVariable(variablesOnly bool, nestedDepth int) []byte {
	allTables := `,"allTables":[{},{},{},{},{}]`
	if variablesOnly {
		allTables = ""
	}

	nested := bytes.ReplaceAll(nestedJSONObject(nestedDepth), []byte(`"x"`), []byte(`"s:x"`))

	return []byte(fmt.Sprintf(`{"source":{"zipName":"save.zip","byteLength":1,"contentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":["save.1st.ntwtf.json"]},"header":{},"world":{},"states":{"areaStates":{},"shownOrbs":{}},"tlv":{"variables":{"v":%s}%s}}`, nested, allTables))
}

func TestValidateDumpDocumentDepthBoundary(t *testing.T) {
	for _, variablesOnly := range []bool{false, true} {
		for _, test := range []struct {
			name    string
			depth   int
			wantErr bool
		}{
			{name: "embedded depth 64", depth: 61},
			{name: "embedded depth 65", depth: 62, wantErr: true},
		} {
			t.Run(fmt.Sprintf("variablesOnly=%t/%s", variablesOnly, test.name), func(t *testing.T) {
				err := validateDumpDocument(dumpWithNestedVariable(variablesOnly, test.depth), variablesOnly)

				if (err != nil) != test.wantErr {
					t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
				}
			})
		}
	}
}

func TestSerializedOutputBudgetExactBoundaries(t *testing.T) {
	tests := []struct {
		name    string
		data    []byte
		budget  dumpOutputBudget
		wantErr bool
	}{
		{name: "bytes exact", data: []byte(`{"x":"y"}`), budget: dumpOutputBudget{bytes: 9, tokens: 4, textBytes: 2}},
		{name: "bytes plus one", data: []byte(`{"x":"y"}`), budget: dumpOutputBudget{bytes: 8, tokens: 4, textBytes: 2}, wantErr: true},
		{name: "tokens exact", data: []byte(`{"x":"y"}`), budget: dumpOutputBudget{bytes: 9, tokens: 4, textBytes: 2}},
		{name: "tokens plus one", data: []byte(`{"x":"y"}`), budget: dumpOutputBudget{bytes: 9, tokens: 3, textBytes: 2}, wantErr: true},
		{name: "text exact", data: []byte(`{"x":"y"}`), budget: dumpOutputBudget{bytes: 9, tokens: 4, textBytes: 2}},
		{name: "text plus one", data: []byte(`{"x":"y"}`), budget: dumpOutputBudget{bytes: 9, tokens: 4, textBytes: 1}, wantErr: true},
		{name: "multiple documents", data: []byte(`{}{}`), budget: dumpOutputBudget{bytes: 4, tokens: 4, textBytes: 0}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Off-by-one comparisons or omitted keys in token/text accounting make this fail.
			err := validateSerializedOutput(test.data, test.budget)

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

type failingWriter struct {
	accepted int
}

func (writer *failingWriter) Write(data []byte) (int, error) {
	if writer.accepted >= len(data) {
		return 0, io.ErrClosedPipe
	}

	return writer.accepted, io.ErrClosedPipe
}

func TestWriteStdoutChecksCountAndError(t *testing.T) {
	tests := []struct {
		name    string
		writer  io.Writer
		wantErr bool
	}{
		{name: "complete", writer: &bytes.Buffer{}},
		{name: "short with error", writer: &failingWriter{accepted: 2}, wantErr: true},
		{name: "zero with error", writer: &failingWriter{}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Ignoring Write's returned count or error makes this fail.
			err := writeStdout(test.writer, []byte("document"))

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

type controlledPublicationFile struct {
	buffer   bytes.Buffer
	writeErr error
	syncErr  error
	closeErr error
}

func (file *controlledPublicationFile) Write(data []byte) (int, error) {
	if file.writeErr != nil {
		return 0, file.writeErr
	}

	return file.buffer.Write(data)
}

func (file *controlledPublicationFile) Sync() error {
	return file.syncErr
}

func (file *controlledPublicationFile) Close() error {
	return file.closeErr
}

func TestPublishDestinationFailureStagesPreserveExistingDestination(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*publicationHooks, string)
	}{
		{name: "create failure", configure: func(hooks *publicationHooks, _ string) {
			hooks.create = func(string) (publicationFile, error) { return nil, errors.New("create") }
		}},
		{name: "write failure", configure: func(hooks *publicationHooks, _ string) {
			hooks.create = func(string) (publicationFile, error) {
				return &controlledPublicationFile{writeErr: errors.New("write")}, nil
			}
		}},
		{name: "flush failure", configure: func(hooks *publicationHooks, _ string) {
			hooks.create = func(string) (publicationFile, error) {
				return &controlledPublicationFile{syncErr: errors.New("sync")}, nil
			}
		}},
		{name: "close failure", configure: func(hooks *publicationHooks, _ string) {
			hooks.create = func(string) (publicationFile, error) {
				return &controlledPublicationFile{closeErr: errors.New("close")}, nil
			}
		}},
		{name: "destination races publication", configure: func(hooks *publicationHooks, _ string) {
			hooks.publish = func(source, destination string) error {
				if err := os.WriteFile(destination, []byte("racer"), 0o600); err != nil {
					return err
				}

				return os.Link(source, destination)
			}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			destination := filepath.Join(directory, "out.json")
			temp := destination + ".0123456789abcdef0123456789abcdef.tmp"
			hooks := defaultPublicationHooks()
			hooks.suffix = func() (string, error) { return "0123456789abcdef0123456789abcdef", nil }
			test.configure(&hooks, temp)

			// Publishing before every successful stage or overwriting a racing destination makes this fail.
			err := publishDestination(destination, []byte("new"), hooks)

			if err == nil {
				t.Fatal("want error")
			}
			if data, readErr := os.ReadFile(destination); readErr == nil && !bytes.Equal(data, []byte("racer")) {
				t.Fatalf("destination changed to %q", data)
			}
		})
	}
}

func TestPublishDestinationNeverOverwritesPreExistingFile(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "out.json")
	if err := os.WriteFile(destination, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Removing the absent-destination precondition makes this fail.
	err := publishDestination(destination, []byte("new"), defaultPublicationHooks())

	if err == nil {
		t.Fatal("want error")
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "existing" {
		t.Fatalf("destination = %q", data)
	}
}

func TestPublishDestinationSuccessUsesBoundedSiblingName(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "out.json")
	hooks := defaultPublicationHooks()
	hooks.suffix = func() (string, error) { return strings.Repeat("a", 32), nil }

	err := publishDestination(destination, []byte("complete"), hooks)

	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "complete" {
		t.Fatalf("destination = %q", data)
	}
	if _, err := os.Stat(destination + "." + strings.Repeat("a", 32) + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("owned sibling remains: %v", err)
	}
}
