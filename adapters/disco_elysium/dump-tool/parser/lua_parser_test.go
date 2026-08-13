package parser

import (
	"bytes"
	"encoding/binary"
	"math"
	"strings"
	"testing"
)

func encodeStringBytes(body []byte) []byte {
	encoded := []byte{TypeString, byte(len(body))}

	return append(encoded, body...)
}

func encodeString(text string) []byte {
	return encodeStringBytes([]byte(text))
}

func encodeNumber(value float64) []byte {
	encoded := []byte{TypeNumber}
	var body [8]byte
	binary.LittleEndian.PutUint64(body[:], math.Float64bits(value))

	return append(encoded, body[:]...)
}

func encodeBoolean(value bool) []byte {
	if value {
		return []byte{TypeBoolean, 1}
	}

	return []byte{TypeBoolean, 0}
}

func encodeTable(arrayValues [][]byte, hashPairs [][2][]byte) []byte {
	var encoded bytes.Buffer
	encoded.WriteByte(TypeTable)
	var count [4]byte
	binary.LittleEndian.PutUint32(count[:], uint32(len(arrayValues)))
	encoded.Write(count[:])
	for _, value := range arrayValues {
		encoded.Write(value)
	}
	binary.LittleEndian.PutUint32(count[:], uint32(len(hashPairs)))
	encoded.Write(count[:])
	for _, pair := range hashPairs {
		encoded.Write(pair[0])
		encoded.Write(pair[1])
	}

	return encoded.Bytes()
}

func unlimitedBudget() *MaterializationBudget {
	return NewMaterializationBudget(math.MaxInt64, math.MaxInt64, math.MaxInt64)
}

func TestRead7BitIntBoundaries(t *testing.T) {
	tests := []struct {
		name    string
		encoded []byte
		want    uint32
	}{
		{name: "zero", encoded: []byte{0x00}, want: 0},
		{name: "one byte maximum", encoded: []byte{0x7f}, want: 127},
		{name: "two byte minimum", encoded: []byte{0x80, 0x01}, want: 128},
		{name: "two byte maximum", encoded: []byte{0xff, 0x7f}, want: 16_383},
		{name: "three byte minimum", encoded: []byte{0x80, 0x80, 0x01}, want: 16_384},
		{name: "three byte maximum", encoded: []byte{0xff, 0xff, 0x7f}, want: 2_097_151},
		{name: "four byte minimum", encoded: []byte{0x80, 0x80, 0x80, 0x01}, want: 2_097_152},
		{name: "four byte maximum", encoded: []byte{0xff, 0xff, 0xff, 0x7f}, want: 268_435_455},
		{name: "five byte minimum", encoded: []byte{0x80, 0x80, 0x80, 0x80, 0x01}, want: 268_435_456},
		{name: "uint32 maximum", encoded: []byte{0xff, 0xff, 0xff, 0xff, 0x0f}, want: math.MaxUint32},
		{name: "noncanonical termination", encoded: []byte{0x81, 0x00}, want: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// A broken shift width, termination condition, or fifth-byte mask makes this fail.
			parser := New(test.encoded, unlimitedBudget())

			got, err := parser.read7BitInt()

			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("got %d, want %d", got, test.want)
			}
		})
	}
}

func TestRead7BitIntRejectsInvalidWidths(t *testing.T) {
	tests := []struct {
		name    string
		encoded []byte
	}{
		{name: "unterminated fifth byte", encoded: []byte{0x80, 0x80, 0x80, 0x80, 0x80}},
		{name: "fifth byte payload overflow", encoded: []byte{0x80, 0x80, 0x80, 0x80, 0x10}},
		{name: "truncated", encoded: []byte{0x80}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Removing the five-byte width or remaining-input guard makes this fail.
			_, err := New(test.encoded, unlimitedBudget()).read7BitInt()

			if err == nil {
				t.Fatal("want error")
			}
		})
	}
}

func TestReadValueRejectsInvalidStringsAndNumbers(t *testing.T) {
	tests := []struct {
		name string
		data []byte
	}{
		{name: "length beyond remaining", data: []byte{TypeString, 2, 'x'}},
		{name: "invalid UTF-8", data: encodeStringBytes([]byte{0xff})},
		{name: "NaN", data: encodeNumber(math.NaN())},
		{name: "positive infinity", data: encodeNumber(math.Inf(1))},
		{name: "negative infinity", data: encodeNumber(math.Inf(-1))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Removing validation before retention or JSON serialization makes this fail.
			_, err := New(test.data, unlimitedBudget()).ReadTopLevel()

			if err == nil {
				t.Fatal("want error")
			}
		})
	}
}

func TestNumberValueConversionBoundaries(t *testing.T) {
	tests := []struct {
		name  string
		value float64
		want  any
	}{
		{name: "minimum Int64", value: -9_223_372_036_854_775_808.0, want: int64(math.MinInt64)},
		{name: "upper endpoint stays binary64", value: 9_223_372_036_854_775_808.0, want: float64(9_223_372_036_854_775_808.0)},
		{name: "integral", value: 42, want: int64(42)},
		{name: "fractional", value: 1.5, want: float64(1.5)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Using a rounded MaxInt64 comparison converts the upper endpoint incorrectly.
			values, err := New(encodeNumber(test.value), unlimitedBudget()).ReadTopLevel()

			if err != nil {
				t.Fatal(err)
			}
			if got := values[0]; got != test.want {
				t.Fatalf("got %#v (%T), want %#v (%T)", got, got, test.want, test.want)
			}
		})
	}
}

func TestCanonicalProjectedKeysPreserveTypeAndNumericBits(t *testing.T) {
	pairs := [][2][]byte{
		{encodeNumber(1.5), encodeString("positive fraction")},
		{encodeNumber(-1.5), encodeString("negative fraction")},
		{encodeNumber(1), encodeString("integral number")},
		{encodeString("1"), encodeString("string")},
		{encodeBoolean(true), encodeString("boolean")},
		{encodeNumber(math.Copysign(0, -1)), encodeString("negative zero")},
	}
	// Replacing type-preserving projection with fmt.Sprint or retaining signed zero makes this fail.
	values, err := New(encodeTable(nil, pairs), unlimitedBudget()).ReadTopLevel()

	if err != nil {
		t.Fatal(err)
	}
	table := values[0].(*Table)
	wants := map[string]any{
		"n:3ff8000000000000": "positive fraction",
		"n:bff8000000000000": "negative fraction",
		"n:3ff0000000000000": "integral number",
		"s:1":                "string",
		"b:1":                "boolean",
		"n:0000000000000000": "negative zero",
	}
	for key, want := range wants {
		if got := table.Entries[key]; got != want {
			t.Errorf("key %q got %#v, want %#v", key, got, want)
		}
	}
}

func TestTableRejectsInvalidKeysAndProjectedCollisions(t *testing.T) {
	tests := []struct {
		name string
		data []byte
	}{
		{name: "table key", data: encodeTable(nil, [][2][]byte{{encodeTable(nil, nil), encodeNumber(1)}})},
		{name: "unknown key", data: encodeTable(nil, [][2][]byte{{[]byte{'X'}, encodeNumber(1)}})},
		{name: "null key", data: encodeTable(nil, [][2][]byte{{[]byte{0}, encodeNumber(1)}})},
		{name: "NaN key", data: encodeTable(nil, [][2][]byte{{encodeNumber(math.NaN()), encodeNumber(1)}})},
		{name: "infinite key", data: encodeTable(nil, [][2][]byte{{encodeNumber(math.Inf(1)), encodeNumber(1)}})},
		{name: "array hash collision", data: encodeTable([][]byte{encodeString("array")}, [][2][]byte{{encodeNumber(1), encodeString("hash")}})},
		{name: "repeated hash key", data: encodeTable(nil, [][2][]byte{{encodeString("k"), encodeNumber(1)}, {encodeString("k"), encodeNumber(2)}})},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Permitting invalid key kinds or checking duplicates before projection makes this fail.
			_, err := New(test.data, unlimitedBudget()).ReadTopLevel()

			if err == nil {
				t.Fatal("want error")
			}
		})
	}
}

func TestTableDepthLimit(t *testing.T) {
	makeNested := func(depth int) []byte {
		value := encodeString("leaf")
		for index := 0; index < depth; index++ {
			value = encodeTable([][]byte{value}, nil)
		}

		return value
	}
	tests := []struct {
		name    string
		depth   int
		wantErr bool
	}{
		{name: "depth 61 accepted", depth: 61},
		{name: "depth 62 rejected", depth: 62, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Moving the recursion guard after descent or using the wrong boundary makes this fail.
			_, err := New(makeNested(test.depth), unlimitedBudget()).ReadTopLevel()

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

func TestMaterializationBudgetExactBoundaries(t *testing.T) {
	tests := []struct {
		name    string
		budget  *MaterializationBudget
		data    []byte
		wantErr bool
	}{
		{name: "decoded values exact", budget: NewMaterializationBudget(2, 1, 20), data: encodeTable([][]byte{encodeBoolean(true)}, nil)},
		{name: "decoded values plus one", budget: NewMaterializationBudget(1, 1, 20), data: encodeTable([][]byte{encodeBoolean(true)}, nil), wantErr: true},
		{name: "projected entries exact", budget: NewMaterializationBudget(2, 1, 20), data: encodeTable([][]byte{encodeBoolean(true)}, nil)},
		{name: "projected entries plus one", budget: NewMaterializationBudget(2, 0, 20), data: encodeTable([][]byte{encodeBoolean(true)}, nil), wantErr: true},
		{name: "retained text exact", budget: NewMaterializationBudget(2, 1, 19), data: encodeTable([][]byte{encodeString("x")}, nil)},
		{name: "retained text plus one", budget: NewMaterializationBudget(2, 1, 18), data: encodeTable([][]byte{encodeString("x")}, nil), wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Failing to reserve before allocation or charging a boundary twice makes this fail.
			_, err := New(test.data, test.budget).ReadTopLevel()

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

func TestMaterializationBudgetCanReserveIsExactAndNonMutating(t *testing.T) {
	budget := NewMaterializationBudget(2, 3, 4)
	tests := []struct {
		name      string
		decoded   int64
		projected int64
		text      int64
		want      bool
	}{
		{name: "exact", decoded: 2, projected: 3, text: 4, want: true},
		{name: "decoded over", decoded: 3, projected: 3, text: 4},
		{name: "projected over", decoded: 2, projected: 4, text: 4},
		{name: "text over", decoded: 2, projected: 3, text: 5},
		{name: "negative", decoded: -1, projected: 0, text: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := budget.CanReserve(test.decoded, test.projected, test.text); got != test.want {
				t.Fatalf("CanReserve = %t, want %t", got, test.want)
			}
		})
	}
	if err := budget.Reserve(2, 3, 4); err != nil {
		t.Fatalf("affordability query mutated budget: %v", err)
	}
}

func TestProjectedKeyBudgetFailsBeforeConstruction(t *testing.T) {
	tests := []struct {
		name       string
		data       []byte
		textBudget int64
		install    func(*LuaParser, *int)
	}{
		{
			name:       "string hash key",
			data:       encodeTable(nil, [][2][]byte{{encodeString("k"), encodeBoolean(true)}}),
			textBudget: 3,
			install: func(parser *LuaParser, calls *int) {
				parser.projector.stringKey = func(string) string { *calls++; return "must-not-run" }
			},
		},
		{
			name:       "numeric hash key",
			data:       encodeTable(nil, [][2][]byte{{encodeNumber(1), encodeBoolean(true)}}),
			textBudget: 17,
			install: func(parser *LuaParser, calls *int) {
				parser.projector.numericKey = func(float64) string { *calls++; return "must-not-run" }
			},
		},
		{
			name:       "Boolean hash key",
			data:       encodeTable(nil, [][2][]byte{{encodeBoolean(true), encodeBoolean(true)}}),
			textBudget: 2,
			install: func(parser *LuaParser, calls *int) {
				parser.projector.booleanKey = func(bool) string { *calls++; return "must-not-run" }
			},
		},
		{
			name:       "synthetic array key",
			data:       encodeTable([][]byte{encodeBoolean(true)}, nil),
			textBudget: 17,
			install: func(parser *LuaParser, calls *int) {
				parser.projector.arrayKey = func(int) string { *calls++; return "must-not-run" }
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			budget := NewMaterializationBudget(4, 1, test.textBudget)
			luaParser := New(test.data, budget)
			calls := 0
			test.install(luaParser, &calls)

			_, err := luaParser.ReadTopLevel()

			if err == nil || !strings.Contains(err.Error(), "materialization-budget-exceeded") {
				t.Fatalf("want budget error, got %v", err)
			}
			if calls != 0 {
				t.Fatalf("projected key constructed %d times after exhausted budget", calls)
			}
		})
	}
}

func TestStringKeyBudgetFailsBeforeBodyRead(t *testing.T) {
	data := encodeTable(nil, [][2][]byte{{encodeString("k"), encodeBoolean(true)}})
	luaParser := New(data, NewMaterializationBudget(4, 1, 3))

	_, err := luaParser.ReadTopLevel()

	if err == nil {
		t.Fatal("want budget error")
	}
	if luaParser.Remaining() != 3 {
		t.Fatalf("remaining = %d, want unread string body plus value = 3", luaParser.Remaining())
	}
}

func TestStrictTopLevelParsing(t *testing.T) {
	tests := []struct {
		name      string
		data      []byte
		wantCount int
		wantErr   bool
	}{
		{name: "multiple complete values", data: append(encodeTable(nil, nil), encodeTable(nil, nil)...), wantCount: 2},
		{name: "truncated value", data: encodeTable(nil, [][2][]byte{{encodeString("k"), encodeNumber(1)[:4]}}), wantErr: true},
		{name: "trailing null", data: append(encodeTable(nil, nil), 0), wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Restoring the reference parser's partial-success or null-skip tolerance makes this fail.
			values, err := New(test.data, unlimitedBudget()).ReadTopLevel()

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
			if err == nil && len(values) != test.wantCount {
				t.Fatalf("got %d values, want %d", len(values), test.wantCount)
			}
		})
	}
}

func TestStringProjectionRequiresHashOnlyStringKeys(t *testing.T) {
	tests := []struct {
		name    string
		data    []byte
		wantErr bool
	}{
		{name: "hash-only strings", data: encodeTable(nil, [][2][]byte{{encodeString("key"), encodeNumber(1)}})},
		{name: "array part", data: encodeTable([][]byte{encodeNumber(1)}, nil), wantErr: true},
		{name: "numeric hash key", data: encodeTable(nil, [][2][]byte{{encodeNumber(1), encodeNumber(1)}}), wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Reprojecting a mixed or array table as semantic names makes this fail.
			values, err := New(test.data, unlimitedBudget()).ReadTopLevel()
			if err != nil {
				t.Fatal(err)
			}

			projection, err := values[0].(*Table).StringMap()

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
			if err == nil && projection["key"] != int64(1) {
				t.Fatalf("projection = %#v", projection)
			}
		})
	}
}

func TestErrorsRemainClosed(t *testing.T) {
	_, err := New([]byte{'X'}, unlimitedBudget()).ReadTopLevel()
	if err == nil || !strings.Contains(err.Error(), "unknown type") {
		t.Fatalf("want closed unknown-type error, got %v", err)
	}
}
