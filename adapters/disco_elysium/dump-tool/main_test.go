package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"dedump/parser"
)

func testBudget() *parser.MaterializationBudget {
	return parser.NewMaterializationBudget(maxTLVDecodedValues, maxTLVProjectedEntries, maxTLVRetainedTextBytes)
}

func TestParseStatesClosedGrammar(t *testing.T) {
	tests := []struct {
		name       string
		input      []byte
		wantReason string
	}{
		{name: "leading blanks and closed shapes", input: []byte("\n\t \nAreaState[\"A\"]={x=+0002,y=false};\r\nShownOrbs[\"A\"]={x=-0};")},
		{name: "Int64 endpoints", input: []byte("AreaState[\"A\"]={min=-9223372036854775808,max=9223372036854775807};")},
		{name: "invalid UTF-8", input: []byte("\nAreaState[\"A\"]={x=\xff};"), wantReason: "line 2: invalid-utf8"},
		{name: "invalid UTF-8 continuation", input: []byte{'\n', 0x80}, wantReason: "line 2: invalid-utf8"},
		{name: "unknown namespace", input: []byte("Other[\"A\"]={x=1};"), wantReason: "line 1: invalid-record"},
		{name: "empty record name", input: []byte("AreaState[\"\"]={x=1};"), wantReason: "line 1: invalid-record"},
		{name: "control in record name", input: []byte("AreaState[\"A\x7f\"]={x=1};"), wantReason: "line 1: invalid-record"},
		{name: "backslash in record name", input: []byte("AreaState[\"A\\B\"]={x=1};"), wantReason: "line 1: invalid-record"},
		{name: "empty fields", input: []byte("AreaState[\"A\"]={};"), wantReason: "line 1: invalid-field"},
		{name: "leading comma", input: []byte("AreaState[\"A\"]={,x=1};"), wantReason: "line 1: invalid-field"},
		{name: "doubled comma", input: []byte("AreaState[\"A\"]={x=1,,y=2};"), wantReason: "line 1: invalid-field"},
		{name: "bad field name", input: []byte("AreaState[\"A\"]={1x=1};"), wantReason: "line 1: invalid-field"},
		{name: "extra equals", input: []byte("AreaState[\"A\"]={x=1=2};"), wantReason: "line 1: invalid-field"},
		{name: "whitespace in value", input: []byte("AreaState[\"A\"]={x= 1};"), wantReason: "line 1: invalid-value"},
		{name: "uppercase Boolean", input: []byte("AreaState[\"A\"]={x=True};"), wantReason: "line 1: invalid-value"},
		{name: "string value", input: []byte("AreaState[\"A\"]={x=\"v\"};"), wantReason: "line 1: invalid-value"},
		{name: "integer above Int64", input: []byte("AreaState[\"A\"]={x=9223372036854775808};"), wantReason: "line 1: integer-out-of-range"},
		{name: "integer below Int64", input: []byte("AreaState[\"A\"]={x=-9223372036854775809};"), wantReason: "line 1: integer-out-of-range"},
		{name: "duplicate field after later invalid value", input: []byte("AreaState[\"A\"]={x=1,x=oops};"), wantReason: "line 1: invalid-value"},
		{name: "duplicate field", input: []byte("AreaState[\"A\"]={x=1,x=2};"), wantReason: "line 1: duplicate-field"},
		{name: "duplicate record in namespace", input: []byte("AreaState[\"A\"]={x=1};\nAreaState[\"A\"]={y=2};"), wantReason: "line 2: duplicate-record"},
		{name: "malformed trailing record", input: []byte("AreaState[\"A\"]={x=1};\ngarbage"), wantReason: "line 2: invalid-record"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Broad regex acceptance, reordered precedence, or diagnostic data leakage makes this fail.
			areas, orbs, err := parseStates(test.input, testBudget())

			if test.wantReason == "" {
				if err != nil {
					t.Fatal(err)
				}
				if test.name == "Int64 endpoints" {
					if areas["A"]["min"] != int64(math.MinInt64) || areas["A"]["max"] != int64(math.MaxInt64) {
						t.Fatalf("areas=%#v", areas)
					}
				} else if areas["A"]["x"] != int64(2) || areas["A"]["y"] != false || orbs["A"]["x"] != int64(0) {
					t.Fatalf("areas=%#v orbs=%#v", areas, orbs)
				}

				return
			}
			if err == nil || err.Error() != test.wantReason {
				t.Fatalf("error = %v, want %q", err, test.wantReason)
			}
		})
	}
}

func TestParseArgumentsRejectsEmptyAndDuplicateOutput(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "empty output", args: []string{"save.zip", "-o", ""}},
		{name: "duplicate output", args: []string{"save.zip", "-o", "one.json", "-o", "two.json"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Using the output path value as the option-seen marker accepts an empty first value.
			_, err := parseArguments(test.args)

			if err == nil {
				t.Fatal("want error")
			}
		})
	}
}

func TestParseStatesMaterializationBudget(t *testing.T) {
	input := []byte("AreaState[\"AB\"]={x=1};")
	tests := []struct {
		name    string
		budget  *parser.MaterializationBudget
		wantErr bool
	}{
		{name: "exact all counters", budget: parser.NewMaterializationBudget(1, 2, 3)},
		{name: "decoded value plus one", budget: parser.NewMaterializationBudget(0, 2, 3), wantErr: true},
		{name: "projected entry plus one", budget: parser.NewMaterializationBudget(1, 1, 3), wantErr: true},
		{name: "retained text plus one", budget: parser.NewMaterializationBudget(1, 2, 2), wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Reserving after map insertion or failing to charge a record, field, or value makes this fail.
			_, _, err := parseStates(input, test.budget)

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
			if err != nil && err.Error() != "line 1: materialization-budget-exceeded" {
				t.Fatalf("unexpected error %v", err)
			}
		})
	}
}

func commaHeavyStateLine(fieldCount int) []byte {
	var builder strings.Builder
	builder.WriteString(`AreaState["A"]={`)
	for index := 0; index < fieldCount; index++ {
		if index > 0 {
			builder.WriteByte(',')
		}
		fmt.Fprintf(&builder, "f%d=%d", index, index)
	}
	builder.WriteString("};")

	return []byte(builder.String())
}

func TestParseStatesCommaHeavyBudgetFailureAvoidsFieldAllocation(t *testing.T) {
	input := commaHeavyStateLine(200)
	allocations := testing.AllocsPerRun(5, func() {
		_, _, err := parseStates(input, parser.NewMaterializationBudget(200, 200, math.MaxInt64))
		if err == nil || err.Error() != "line 1: materialization-budget-exceeded" {
			panic(fmt.Sprintf("unexpected error %v", err))
		}
	})

	if allocations > 10 {
		t.Fatalf("budget failure allocated %.0f objects, want at most 10 without field materialization", allocations)
	}
}

func TestParseStatesScansNewlineHeavyInputIncrementally(t *testing.T) {
	input := append(bytes.Repeat([]byte{'\n'}, 100_000), []byte(`AreaState["A"]={x=1};`)...)

	areas, _, err := parseStates(input, parser.NewMaterializationBudget(1, 2, 2))

	if err != nil {
		t.Fatal(err)
	}
	if areas["A"]["x"] != int64(1) {
		t.Fatalf("areas = %#v", areas)
	}
}

type countingStateFieldSet struct {
	seen       map[string]struct{}
	operations *int
}

func (set *countingStateFieldSet) Add(name []byte) bool {
	*set.operations++
	key := string(name)
	if _, exists := set.seen[key]; exists {
		return false
	}
	set.seen[key] = struct{}{}

	return true
}

func TestParseStatesDuplicateDetectionIsLinear(t *testing.T) {
	const fieldCount = 10_000
	operations := 0
	factoryCalls := 0
	factory := func(capacity int) stateFieldSet {
		factoryCalls++
		if capacity != fieldCount {
			t.Fatalf("capacity = %d, want %d", capacity, fieldCount)
		}

		return &countingStateFieldSet{seen: make(map[string]struct{}, capacity), operations: &operations}
	}

	_, _, err := parseStatesWithFieldSetFactory(commaHeavyStateLine(fieldCount), parser.NewMaterializationBudget(fieldCount, fieldCount+1, math.MaxInt64), factory)

	if err != nil {
		t.Fatal(err)
	}
	if factoryCalls != 1 || operations != fieldCount {
		t.Fatalf("factory calls=%d operations=%d, want 1 and %d", factoryCalls, operations, fieldCount)
	}
}

func TestParseStatesAffordabilityAndDuplicatePrecedence(t *testing.T) {
	tests := []struct {
		name             string
		input            []byte
		budget           *parser.MaterializationBudget
		wantReason       string
		wantFactoryCalls int
	}{
		{name: "invalid value precedes duplicate", input: []byte(`AreaState["A"]={x=1,x=oops};`), budget: parser.NewMaterializationBudget(2, 3, 3), wantReason: "line 1: invalid-value"},
		{name: "syntax precedes unaffordable budget", input: []byte(`AreaState["A"]={x=oops};`), budget: parser.NewMaterializationBudget(0, 0, 0), wantReason: "line 1: invalid-value"},
		{name: "unaffordable line avoids temporary set", input: []byte(`AreaState["A"]={x=1,y=2};`), budget: parser.NewMaterializationBudget(2, 2, 3), wantReason: "line 1: materialization-budget-exceeded"},
		{name: "affordable duplicate precedes reservation", input: []byte(`AreaState["A"]={x=1,x=2};`), budget: parser.NewMaterializationBudget(2, 3, 3), wantReason: "line 1: duplicate-field", wantFactoryCalls: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			factoryCalls := 0
			factory := func(capacity int) stateFieldSet {
				factoryCalls++

				return &countingStateFieldSet{seen: make(map[string]struct{}, capacity), operations: new(int)}
			}

			_, _, err := parseStatesWithFieldSetFactory(test.input, test.budget, factory)

			if err == nil || err.Error() != test.wantReason {
				t.Fatalf("error = %v, want %q", err, test.wantReason)
			}
			if factoryCalls != test.wantFactoryCalls {
				t.Fatalf("factory calls = %d, want %d", factoryCalls, test.wantFactoryCalls)
			}
		})
	}
}

func manyStateRecords(recordCount int) []byte {
	var builder strings.Builder
	for index := 0; index < recordCount; index++ {
		fmt.Fprintf(&builder, "AreaState[\"R%d\"]={x=1};\n", index)
	}

	return []byte(builder.String())
}

func TestParseStatesRecordDuplicateDetectionUsesOneLookupPerRecord(t *testing.T) {
	const recordCount = 5_000
	lookups := 0
	lookup := func(namespace map[string]map[string]any, recordName string) bool {
		lookups++
		_, exists := namespace[recordName]

		return exists
	}

	areas, _, err := parseStatesWithRecordLookup(manyStateRecords(recordCount), parser.NewMaterializationBudget(recordCount, recordCount*2, math.MaxInt64), lookup)

	if err != nil {
		t.Fatal(err)
	}
	if lookups != recordCount || len(areas) != recordCount {
		t.Fatalf("lookups=%d records=%d, want %d", lookups, len(areas), recordCount)
	}
}

func TestParseStatesAffordableRecordDuplicatePrecedesReserve(t *testing.T) {
	input := []byte("AreaState[\"A\"]={x=1};\nAreaState[\"A\"]={y=2};")
	budget := parser.NewMaterializationBudget(2, 4, 4)
	lookups := 0
	lookup := func(namespace map[string]map[string]any, recordName string) bool {
		lookups++
		_, exists := namespace[recordName]

		return exists
	}

	_, _, err := parseStatesWithRecordLookup(input, budget, lookup)

	if err == nil || err.Error() != "line 2: duplicate-record" {
		t.Fatalf("error = %v, want duplicate-record", err)
	}
	if lookups != 2 {
		t.Fatalf("lookups = %d, want 2", lookups)
	}
	if err := budget.Reserve(1, 2, 2); err != nil {
		t.Fatalf("duplicate line mutated budget: %v", err)
	}
}

func makeVariableTable(taskCount int, counter any, nonBoolean bool) *parser.Table {
	entries := make(map[string]any, taskCount+1)
	for index := 0; index < taskCount; index++ {
		entries[fmt.Sprintf("TASK.%04d", index)] = true
	}
	if nonBoolean && taskCount > 0 {
		entries["TASK.0000"] = int64(1)
	}
	entries["character.books_read_counter"] = counter

	return parseStringTableFixture(entries)
}

func parseStringTableFixture(entries map[string]any) *parser.Table {
	encoded := encodeStringTableFixture(entries)
	values, err := parser.New(encoded, testBudget()).ReadTopLevel()
	if err != nil {
		panic(err)
	}

	return values[0].(*parser.Table)
}

func encodeStringTableFixture(entries map[string]any) []byte {
	var encoded bytes.Buffer
	encoded.WriteByte(parser.TypeTable)
	var count [4]byte
	encoded.Write(count[:])
	binary.LittleEndian.PutUint32(count[:], uint32(len(entries)))
	encoded.Write(count[:])
	for key, value := range entries {
		encoded.WriteByte(parser.TypeString)
		encoded.WriteByte(byte(len(key)))
		encoded.WriteString(key)
		switch typed := value.(type) {
		case bool:
			encoded.WriteByte(parser.TypeBoolean)
			if typed {
				encoded.WriteByte(1)
			} else {
				encoded.WriteByte(0)
			}
		case int64:
			encoded.WriteByte(parser.TypeNumber)
			var number [8]byte
			binary.LittleEndian.PutUint64(number[:], math.Float64bits(float64(typed)))
			encoded.Write(number[:])
		case float64:
			encoded.WriteByte(parser.TypeNumber)
			var number [8]byte
			binary.LittleEndian.PutUint64(number[:], math.Float64bits(typed))
			encoded.Write(number[:])
		default:
			panic(fmt.Sprintf("unsupported fixture value %T", value))
		}
	}
	return encoded.Bytes()
}

func TestFindVariableStoreCompleteSignature(t *testing.T) {
	valid := makeVariableTable(1_131, int64(3), false)
	tests := []struct {
		name    string
		tables  []any
		wantErr bool
	}{
		{name: "unique complete match", tables: []any{parseStringTableFixture(map[string]any{"x": true}), valid}},
		{name: "wrong counter kind", tables: []any{makeVariableTable(1_131, float64(3.5), false)}, wantErr: true},
		{name: "one task short", tables: []any{makeVariableTable(1_130, int64(1), false)}, wantErr: true},
		{name: "one task over", tables: []any{makeVariableTable(1_132, int64(1), false)}, wantErr: true},
		{name: "non-Boolean task", tables: []any{makeVariableTable(1_131, int64(1), true)}, wantErr: true},
		{name: "probe-only decoy and complete match", tables: []any{parseStringTableFixture(map[string]any{"character.books_read_counter": int64(1)}), valid}},
		{name: "zero matches", tables: []any{parseStringTableFixture(map[string]any{"x": true})}, wantErr: true},
		{name: "multiple complete matches", tables: []any{valid, makeVariableTable(1_131, int64(2), false)}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Reverting to one-key probing or first-match-wins makes this fail.
			store, err := findVariableStore(test.tables)

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
			if err == nil && store["character.books_read_counter"] == nil {
				t.Fatalf("store = %#v", store)
			}
		})
	}
}

func nestedJSONObject(depth int) []byte {
	var buffer bytes.Buffer
	for index := 0; index < depth; index++ {
		buffer.WriteString(`{"x":`)
	}
	buffer.WriteString("0")
	for index := 0; index < depth; index++ {
		buffer.WriteByte('}')
	}

	return buffer.Bytes()
}

func TestValidateJSONMember(t *testing.T) {
	tests := []struct {
		name    string
		data    []byte
		wantErr bool
	}{
		{name: "object", data: []byte(`{"a":1,"A":2}`)},
		{name: "depth 63", data: nestedJSONObject(63)},
		{name: "invalid UTF-8", data: []byte{'{', '"', 0xff, '"', ':', '1', '}'}, wantErr: true},
		{name: "scalar root", data: []byte("1"), wantErr: true},
		{name: "array root", data: []byte("[]"), wantErr: true},
		{name: "null root", data: []byte("null"), wantErr: true},
		{name: "depth 64", data: nestedJSONObject(64), wantErr: true},
		{name: "literal duplicate", data: []byte(`{"a":1,"a":2}`), wantErr: true},
		{name: "escape-equivalent duplicate", data: []byte(`{"a":1,"\u0061":2}`), wantErr: true},
		{name: "nested duplicate", data: []byte(`{"x":{"a":1,"a":2}}`), wantErr: true},
		{name: "trailing document", data: []byte(`{} {}`), wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Semantic unmarshalling or root-only duplicate checks make this fail.
			raw, err := validateJSONMember(test.data)

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
			if err == nil && string(raw) != string(test.data) {
				t.Fatalf("raw bytes changed: %q", raw)
			}
		})
	}
}

func validTLVFixture() []byte {
	variableEntries := make(map[string]any, 1_132)
	for index := 0; index < 1_131; index++ {
		variableEntries[fmt.Sprintf("TASK.%04d", index)] = true
	}
	variableEntries[variableProbeKey] = int64(1)
	data := encodeStringTableFixture(variableEntries)
	for index := 0; index < 4; index++ {
		data = append(data, encodeStringTableFixture(map[string]any{})...)
	}

	return data
}

func TestInvalidRequiredJSONNeverPublishes(t *testing.T) {
	invalidCases := []struct {
		name string
		data []byte
	}{
		{name: "invalid UTF-8", data: []byte{'{', '"', 0xff, '"', ':', '1', '}'}},
		{name: "scalar root", data: []byte("1")},
		{name: "array root", data: []byte("[]")},
		{name: "null root", data: []byte("null")},
		{name: "depth 64", data: nestedJSONObject(64)},
		{name: "literal duplicate", data: []byte(`{"a":1,"a":2}`)},
		{name: "escaped duplicate", data: []byte(`{"a":1,"\u0061":2}`)},
	}
	for _, memberIndex := range []int{0, 1} {
		for _, invalidCase := range invalidCases {
			for _, fileMode := range []bool{false, true} {
				name := fmt.Sprintf("member=%d/%s/file=%t", memberIndex+1, invalidCase.name, fileMode)
				t.Run(name, func(t *testing.T) {
					fixtures := requiredZipFixtures("save")
					fixtures[memberIndex].body = invalidCase.data
					fixtures[2].body = validTLVFixture()
					fixtures[3].body = []byte("AreaState[\"A\"]={x=1};")
					path := writeZipFixture(t, fixtures)
					var stdout bytes.Buffer
					arguments := []string{path, "-variables-only"}
					outputPath := ""
					if fileMode {
						outputPath = path + ".json"
						arguments = append(arguments, "-o", outputPath)
					}

					// Validating either JSON member after emission makes this fail.
					err := run(arguments, &stdout)

					if err == nil {
						t.Fatal("want error")
					}
					if stdout.Len() != 0 {
						t.Fatalf("stdout = %q", stdout.Bytes())
					}
					if outputPath != "" {
						if _, statErr := os.Stat(outputPath); !os.IsNotExist(statErr) {
							t.Fatalf("destination exists: %v", statErr)
						}
					}
				})
			}
		}
	}
}

func TestRunPublishesExactDocumentInBothModes(t *testing.T) {
	for _, variablesOnly := range []bool{false, true} {
		t.Run(fmt.Sprintf("variablesOnly=%t", variablesOnly), func(t *testing.T) {
			fixtures := requiredZipFixtures("save")
			fixtures[2].body = validTLVFixture()
			fixtures[3].body = []byte("AreaState[\"A\"]={x=1};")
			path := writeZipFixture(t, fixtures)
			arguments := []string{path}
			if variablesOnly {
				arguments = append(arguments, "-variables-only")
			}
			var stdout bytes.Buffer

			// Dropping any required field, table, or flag-dependent omission makes this fail.
			err := run(arguments, &stdout)

			if err != nil {
				t.Fatal(err)
			}
			if err := validateDumpDocument(stdout.Bytes(), variablesOnly); err != nil {
				t.Fatalf("document = %s, error = %v", stdout.Bytes(), err)
			}
			var root map[string]json.RawMessage
			if err := json.Unmarshal(stdout.Bytes(), &root); err != nil {
				t.Fatal(err)
			}
			var source dumpSource
			if err := json.Unmarshal(root["source"], &source); err != nil {
				t.Fatal(err)
			}
			archiveBytes, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			wantHash := sha256.Sum256(archiveBytes)
			if source.ByteLength != int64(len(archiveBytes)) || source.ContentSHA256 != hex.EncodeToString(wantHash[:]) {
				t.Fatalf("source length=%d hash=%q, want length=%d hash=%q", source.ByteLength, source.ContentSHA256, len(archiveBytes), hex.EncodeToString(wantHash[:]))
			}
		})
	}
}

func TestRunAcceptsOutputFlagsAfterPositionalPath(t *testing.T) {
	fixtures := requiredZipFixtures("save")
	fixtures[2].body = validTLVFixture()
	fixtures[3].body = []byte("ShownOrbs[\"A\"]={seen=true};")
	path := writeZipFixture(t, fixtures)
	destination := path + ".json"

	// Using flag.Parse's stop-at-first-positional behavior makes this fail.
	err := run([]string{path, "-o", destination, "-variables-only"}, io.Discard)

	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateDumpDocument(data, true); err != nil {
		t.Fatal(err)
	}
}

func validCommandArchive(t *testing.T) string {
	t.Helper()
	fixtures := requiredZipFixtures("save")
	fixtures[2].body = validTLVFixture()
	fixtures[3].body = []byte(`AreaState["A"]={x=1};`)

	return writeZipFixture(t, fixtures)
}

func executeForTest(arguments []string, stdout io.Writer) (int, string) {
	var stderr bytes.Buffer
	exitCode := executeCommand(arguments, stdout, &stderr)

	return exitCode, stderr.String()
}

type privateErrorWriter struct{}

func (privateErrorWriter) Write([]byte) (int, error) {
	return 0, errors.New("SECRET\rINJECT")
}

func TestCommandBoundaryUsesClosedDiagnosticRegistry(t *testing.T) {
	tests := []struct {
		name       string
		prepare    func(*testing.T) ([]string, io.Writer)
		wantStderr string
	}{
		{
			name: "argument usage",
			prepare: func(*testing.T) ([]string, io.Writer) {
				return nil, io.Discard
			},
			wantStderr: "dedump: arguments: usage\n",
		},
		{
			name: "invalid output option",
			prepare: func(*testing.T) ([]string, io.Writer) {
				return []string{"save.zip", "-o", ""}, io.Discard
			},
			wantStderr: "dedump: arguments: invalid-output-option\n",
		},
		{
			name: "duplicate variables only",
			prepare: func(*testing.T) ([]string, io.Writer) {
				return []string{"save.zip", "-variables-only", "-variables-only"}, io.Discard
			},
			wantStderr: "dedump: arguments: duplicate-variables-only\n",
		},
		{
			name: "unexpected argument",
			prepare: func(*testing.T) ([]string, io.Writer) {
				return []string{"one.zip", "two.zip"}, io.Discard
			},
			wantStderr: "dedump: arguments: unexpected-argument\n",
		},
		{
			name: "archive path privacy",
			prepare: func(t *testing.T) ([]string, io.Writer) {
				return []string{filepath.Join(t.TempDir(), "SECRET\rINJECT.zip")}, io.Discard
			},
			wantStderr: "dedump: archive: invalid-archive\n",
		},
		{
			name: "header content privacy",
			prepare: func(t *testing.T) ([]string, io.Writer) {
				fixtures := requiredZipFixtures("save")
				fixtures[0].body = []byte(`{"SECRET\rINJECT":`)
				fixtures[2].body = validTLVFixture()
				fixtures[3].body = []byte(`AreaState["A"]={x=1};`)

				return []string{writeZipFixture(t, fixtures)}, io.Discard
			},
			wantStderr: "dedump: header: invalid-json-member\n",
		},
		{
			name: "world content privacy",
			prepare: func(t *testing.T) ([]string, io.Writer) {
				fixtures := requiredZipFixtures("save")
				fixtures[1].body = []byte(`{"SECRET\rINJECT":`)
				fixtures[2].body = validTLVFixture()
				fixtures[3].body = []byte(`AreaState["A"]={x=1};`)

				return []string{writeZipFixture(t, fixtures)}, io.Discard
			},
			wantStderr: "dedump: world: invalid-json-member\n",
		},
		{
			name: "states content privacy",
			prepare: func(t *testing.T) ([]string, io.Writer) {
				fixtures := requiredZipFixtures("save")
				fixtures[2].body = validTLVFixture()
				fixtures[3].body = []byte("SECRET\rINJECT")

				return []string{writeZipFixture(t, fixtures)}, io.Discard
			},
			wantStderr: "dedump: states.lua: line 1: invalid-record\n",
		},
		{
			name: "TLV key privacy",
			prepare: func(t *testing.T) ([]string, io.Writer) {
				fixtures := requiredZipFixtures("save")
				fixtures[2].body = encodeStringTableFixture(map[string]any{"SECRET\rINJECT": int64(1)})
				fixtures[3].body = []byte(`AreaState["A"]={x=1};`)

				return []string{writeZipFixture(t, fixtures)}, io.Discard
			},
			wantStderr: "dedump: tlv: invalid-tlv\n",
		},
		{
			name: "stdout failure",
			prepare: func(t *testing.T) ([]string, io.Writer) {
				return []string{validCommandArchive(t), "-variables-only"}, privateErrorWriter{}
			},
			wantStderr: "dedump: output: stdout-write-failed\n",
		},
		{
			name: "destination exists",
			prepare: func(t *testing.T) ([]string, io.Writer) {
				archive := validCommandArchive(t)
				destination := filepath.Join(t.TempDir(), "SECRET-INJECT.json")
				if err := os.WriteFile(destination, []byte("existing"), 0o600); err != nil {
					t.Fatal(err)
				}

				return []string{archive, "-variables-only", "-o", destination}, io.Discard
			},
			wantStderr: "dedump: output: destination-exists\n",
		},
		{
			name: "publication OS privacy",
			prepare: func(t *testing.T) ([]string, io.Writer) {
				archive := validCommandArchive(t)
				destination := filepath.Join(t.TempDir(), "SECRET\rINJECT", "missing", "out.json")

				return []string{archive, "-variables-only", "-o", destination}, io.Discard
			},
			wantStderr: "dedump: output: publication-failed\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			arguments, stdout := test.prepare(t)

			exitCode, stderr := executeForTest(arguments, stdout)

			if exitCode != 1 || stderr != test.wantStderr {
				t.Fatalf("exit=%d stderr=%q, want exit=1 stderr=%q", exitCode, stderr, test.wantStderr)
			}
			if strings.Contains(stderr, "SECRET") || strings.Contains(stderr, "INJECT") || strings.Count(stderr, "\n") != 1 {
				t.Fatalf("diagnostic escaped closed registry: %q", stderr)
			}
		})
	}
}

func TestCommandBoundaryTranslatesBudgetErrors(t *testing.T) {
	tests := []struct {
		name  string
		input error
		want  commandFailure
	}{
		{name: "TLV budget", input: parser.ErrMaterializationBudgetExceeded, want: commandFailure{stage: "tlv", reason: "materialization-budget-exceeded"}},
		{name: "other TLV", input: errors.New("SECRET key"), want: commandFailure{stage: "tlv", reason: "invalid-tlv"}},
		{name: "output budget", input: ErrOutputBudgetExceeded, want: commandFailure{stage: "output", reason: "output-budget-exceeded"}},
		{name: "destination exists", input: ErrDestinationExists, want: commandFailure{stage: "output", reason: "destination-exists"}},
		{name: "other output", input: errors.New("SECRET OS path"), want: commandFailure{stage: "output", reason: "publication-failed"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var got commandFailure
			if strings.HasPrefix(test.want.stage, "tlv") {
				got = translateTLVFailure(test.input)
			} else {
				got = translateOutputFailure(test.input)
			}

			if got.stage != test.want.stage || got.reason != test.want.reason || strings.Contains(got.Error(), "SECRET") {
				t.Fatalf("got %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestPublicDiagnosticRegistryIsExactAndFailClosed(t *testing.T) {
	want := map[string][]string{
		"arguments": {"usage", "invalid-output-option", "duplicate-variables-only", "unexpected-argument"},
		"archive":   {"invalid-archive"},
		"header":    {"invalid-json-member"},
		"world":     {"invalid-json-member"},
		"tlv":       {"invalid-tlv", "materialization-budget-exceeded"},
		"output":    {"output-budget-exceeded", "stdout-write-failed", "destination-exists", "publication-failed"},
		"internal":  {"failure"},
	}
	wantStates := []string{"invalid-utf8", "invalid-record", "invalid-field", "invalid-value", "integer-out-of-range", "duplicate-record", "duplicate-field", "materialization-budget-exceeded"}

	if !reflect.DeepEqual(publicDiagnosticRegistry, want) || !reflect.DeepEqual(publicStateReasonRegistry, wantStates) {
		t.Fatalf("registry=%#v states=%#v", publicDiagnosticRegistry, publicStateReasonRegistry)
	}
	if got := formatPublicDiagnostic(commandFailure{stage: "archive", reason: "SECRET\rINJECT"}); got != "dedump: internal: failure\n" {
		t.Fatalf("unknown reason escaped registry: %q", got)
	}
	if got := formatPublicDiagnostic(commandFailure{stage: "states.lua", line: 7, reason: "SECRET\rINJECT"}); got != "dedump: internal: failure\n" {
		t.Fatalf("unknown state reason escaped registry: %q", got)
	}
}

func TestBuildDumpDocumentModes(t *testing.T) {
	contents := &archiveContents{
		members:       archiveMembers{header: []byte(`{"n":1e2}`), world: []byte(`{"w":2}`)},
		entries:       []string{"save.1st.ntwtf.json", "save.2nd.ntwtf.json", "save.ntwtf.lua", "save.states.lua"},
		byteLength:    123,
		contentSHA256: strings.Repeat("a", 64),
	}
	tables := []any{parseStringTableFixture(map[string]any{"a": int64(1)}), parseStringTableFixture(map[string]any{}), parseStringTableFixture(map[string]any{}), parseStringTableFixture(map[string]any{}), parseStringTableFixture(map[string]any{})}
	states := parsedStates{areaStates: map[string]map[string]any{}, shownOrbs: map[string]map[string]any{}}
	for _, variablesOnly := range []bool{false, true} {
		t.Run(fmt.Sprintf("variablesOnly=%t", variablesOnly), func(t *testing.T) {
			// Omitting required source fields, remarshalizing RawMessage, or misapplying allTables makes this fail.
			document, err := buildDumpDocument("supplied/path.zip", contents, states, map[string]any{"v": true}, tables, variablesOnly)
			if err != nil {
				t.Fatal(err)
			}
			blob, err := json.Marshal(document)
			if err != nil {
				t.Fatal(err)
			}
			var root map[string]json.RawMessage
			if err := json.Unmarshal(blob, &root); err != nil {
				t.Fatal(err)
			}
			if len(root) != 5 || !bytes.Contains(root["header"], []byte("1e2")) {
				t.Fatalf("root = %s", blob)
			}
			var source map[string]any
			if err := json.Unmarshal(root["source"], &source); err != nil {
				t.Fatal(err)
			}
			if len(source) != 4 || source["zipName"] != "supplied/path.zip" || source["byteLength"] != float64(123) {
				t.Fatalf("source = %#v", source)
			}
			var tlv map[string]json.RawMessage
			if err := json.Unmarshal(root["tlv"], &tlv); err != nil {
				t.Fatal(err)
			}
			_, hasAllTables := tlv["allTables"]
			if hasAllTables == variablesOnly || len(tlv) != 2-boolToInt(variablesOnly) {
				t.Fatalf("tlv = %s", root["tlv"])
			}
		})
	}
}

func boolToInt(value bool) int {
	if value {
		return 1
	}

	return 0
}

func TestRequireFiveTopLevelTables(t *testing.T) {
	for _, count := range []int{4, 5, 6} {
		t.Run(fmt.Sprintf("count=%d", count), func(t *testing.T) {
			values := make([]any, count)
			for index := range values {
				values[index] = parseStringTableFixture(map[string]any{})
			}

			// Accepting clean EOF with any count other than five makes this fail.
			err := validateTopLevelTables(values)

			if (err != nil) != (count != 5) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestCrossSourceBudgetConsumption(t *testing.T) {
	budget := parser.NewMaterializationBudget(2, 3, 22)
	if _, _, err := parseStates([]byte("AreaState[\"AB\"]={x=1};"), budget); err != nil {
		t.Fatal(err)
	}

	// Giving states.lua a separate budget lets this TLV value through and makes the test fail.
	_, err := parser.New([]byte{parser.TypeBoolean, 1, parser.TypeBoolean, 0}, budget).ReadTopLevel()

	if err == nil || !strings.Contains(err.Error(), "materialization-budget-exceeded") {
		t.Fatalf("want shared budget failure, got %v", err)
	}
}

func TestClosedSignatureRejectsNonIntegralCounter(t *testing.T) {
	table := makeVariableTable(1_131, math.MaxFloat64, false)
	if _, err := findVariableStore([]any{table}); err == nil {
		t.Fatal("want signature failure")
	}
}
