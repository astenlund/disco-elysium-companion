// Package parser reads Disco Elysium's binary-serialized Lua tables (TLV).
//
// Vendored from https://github.com/ig4e/disco-elysium-editor
// (scraper/parser/lua_parser.go at commit ef1b126), GPL upstream.
// Deliberate deviations from the reference, per spec section 5.2:
//  1. Table headers contain an array count and values followed by a hash count and pairs.
//  2. ReadTopLevel preserves ordered top-level values instead of flattening tables.
//  3. All parse errors and projected-key collisions fail instead of returning partial data.
//  4. String lengths use a bounded five-byte 7-bit decoder with remaining-input checks.
//  5. Table recursion is capped at 61 table objects.
//  6. Only finite integral numbers in [-2^63, 2^63) convert to Int64.
//  7. Every decoded string must be valid UTF-8.
//  8. One mutable budget bounds decoded values, projected entries, and retained text.
package parser

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"unicode/utf8"
)

// ErrMaterializationBudgetExceeded identifies an atomic budget rejection.
var ErrMaterializationBudgetExceeded = errors.New("materialization-budget-exceeded")

const (
	TypeString  byte = 'S'
	TypeNumber  byte = 'N'
	TypeBoolean byte = 'B'
	TypeTable   byte = 'T'

	maxTableDepth = 61
)

// MaterializationBudget is shared by TLV and states.lua parsing.
type MaterializationBudget struct {
	decodedValues     int64
	projectedEntries  int64
	retainedTextBytes int64
}

// NewMaterializationBudget creates an inclusive, invocation-wide budget.
func NewMaterializationBudget(decodedValues int64, projectedEntries int64, retainedTextBytes int64) *MaterializationBudget {
	return &MaterializationBudget{
		decodedValues:     decodedValues,
		projectedEntries:  projectedEntries,
		retainedTextBytes: retainedTextBytes,
	}
}

// Reserve atomically charges the requested resources or leaves the budget unchanged.
func (b *MaterializationBudget) Reserve(decodedValues int64, projectedEntries int64, retainedTextBytes int64) error {
	if !b.CanReserve(decodedValues, projectedEntries, retainedTextBytes) {
		return ErrMaterializationBudgetExceeded
	}
	b.decodedValues -= decodedValues
	b.projectedEntries -= projectedEntries
	b.retainedTextBytes -= retainedTextBytes

	return nil
}

// CanReserve reports whether a charge fits without mutating the budget.
func (b *MaterializationBudget) CanReserve(decodedValues int64, projectedEntries int64, retainedTextBytes int64) bool {
	return b != nil && decodedValues >= 0 && projectedEntries >= 0 && retainedTextBytes >= 0 && decodedValues <= b.decodedValues && projectedEntries <= b.projectedEntries && retainedTextBytes <= b.retainedTextBytes
}

// Table is the type-preserving JSON object projection of a Lua table.
type Table struct {
	Entries       map[string]any
	arrayCount    int
	stringEntries map[string]any
	stringOnly    bool
}

// MarshalJSON emits the projected Lua table as one JSON object.
func (t *Table) MarshalJSON() ([]byte, error) {
	return json.Marshal(t.Entries)
}

// StringMap returns the semantic untagged projection required by tlv.variables.
func (t *Table) StringMap() (map[string]any, error) {
	if t.arrayCount != 0 || !t.stringOnly {
		return nil, fmt.Errorf("table is not hash-only with string keys")
	}
	result := make(map[string]any, len(t.stringEntries))
	for key, value := range t.stringEntries {
		result[key] = value
	}

	return result, nil
}

// LuaParser owns one TLV input cursor and its shared materialization budget.
type LuaParser struct {
	R             *bytes.Reader
	budget        *MaterializationBudget
	maxTableDepth int
	projector     keyProjector
}

type keyProjector struct {
	stringKey  func(string) string
	numericKey func(float64) string
	booleanKey func(bool) string
	arrayKey   func(int) string
}

// New constructs a strict parser over data.
func New(data []byte, budget *MaterializationBudget, depthLimit ...int) *LuaParser {
	limit := maxTableDepth
	if len(depthLimit) == 1 {
		limit = depthLimit[0]
	}

	return &LuaParser{
		R:             bytes.NewReader(data),
		budget:        budget,
		maxTableDepth: limit,
		projector: keyProjector{
			stringKey:  func(value string) string { return "s:" + value },
			numericKey: numericKey,
			booleanKey: func(value bool) string {
				if value {
					return "b:1"
				}

				return "b:0"
			},
			arrayKey: func(index int) string { return numericKey(float64(index)) },
		},
	}
}

func (p *LuaParser) read7BitInt() (uint32, error) {
	var result uint32
	for index := uint(0); index < 5; index++ {
		value, err := p.R.ReadByte()
		if err != nil {
			return 0, err
		}
		if index == 4 {
			if value&0x80 != 0 || value&0x7f > 0x0f {
				return 0, fmt.Errorf("invalid five-byte string length")
			}
		}
		result |= uint32(value&0x7f) << (index * 7)
		if value&0x80 == 0 {
			return result, nil
		}
	}

	return 0, fmt.Errorf("invalid string length")
}

func (p *LuaParser) readString() (string, error) {
	length, err := p.read7BitInt()
	if err != nil {
		return "", fmt.Errorf("string length: %w", err)
	}
	if uint64(length) > uint64(p.R.Len()) {
		return "", fmt.Errorf("string length %d exceeds remaining input (%d bytes)", length, p.R.Len())
	}
	if err := p.budget.Reserve(0, 0, int64(length)); err != nil {
		return "", err
	}
	body := make([]byte, int(length))
	if _, err := io.ReadFull(p.R, body); err != nil {
		return "", fmt.Errorf("string body: %w", err)
	}
	if !utf8.Valid(body) {
		return "", fmt.Errorf("invalid UTF-8 string")
	}

	return string(body), nil
}

func (p *LuaParser) readStringKey() (string, string, error) {
	length, err := p.read7BitInt()
	if err != nil {
		return "", "", fmt.Errorf("string length: %w", err)
	}
	if uint64(length) > uint64(p.R.Len()) {
		return "", "", fmt.Errorf("string length %d exceeds remaining input (%d bytes)", length, p.R.Len())
	}
	retainedBytes := int64(length)*2 + 2
	if err := p.budget.Reserve(0, 0, retainedBytes); err != nil {
		return "", "", err
	}
	body := make([]byte, int(length))
	if _, err := io.ReadFull(p.R, body); err != nil {
		return "", "", fmt.Errorf("string body: %w", err)
	}
	if !utf8.Valid(body) {
		return "", "", fmt.Errorf("invalid UTF-8 string")
	}
	value := string(body)

	return p.projector.stringKey(value), value, nil
}

func (p *LuaParser) readNumber() (float64, error) {
	var value float64
	if err := binary.Read(p.R, binary.LittleEndian, &value); err != nil {
		return 0, fmt.Errorf("number: %w", err)
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, fmt.Errorf("nonfinite number")
	}

	return value, nil
}

func (p *LuaParser) readBoolean() (bool, error) {
	value, err := p.R.ReadByte()
	if err != nil {
		return false, fmt.Errorf("boolean: %w", err)
	}

	return value != 0, nil
}

func numberValue(value float64) any {
	if value == math.Trunc(value) && value >= -9_223_372_036_854_775_808.0 && value < 9_223_372_036_854_775_808.0 {
		return int64(value)
	}

	return value
}

func numericKey(value float64) string {
	if value == 0 {
		value = 0
	}

	return fmt.Sprintf("n:%016x", math.Float64bits(value))
}

func (p *LuaParser) readKey() (string, string, bool, error) {
	if err := p.budget.Reserve(1, 0, 0); err != nil {
		return "", "", false, err
	}
	typeByte, err := p.R.ReadByte()
	if err != nil {
		return "", "", false, err
	}
	switch typeByte {
	case TypeString:
		projected, value, err := p.readStringKey()
		if err != nil {
			return "", "", false, err
		}

		return projected, value, true, nil
	case TypeNumber:
		value, err := p.readNumber()
		if err != nil {
			return "", "", false, err
		}
		if err := p.budget.Reserve(0, 0, 18); err != nil {
			return "", "", false, err
		}

		return p.projector.numericKey(value), "", false, nil
	case TypeBoolean:
		value, err := p.readBoolean()
		if err != nil {
			return "", "", false, err
		}
		if err := p.budget.Reserve(0, 0, 3); err != nil {
			return "", "", false, err
		}

		return p.projector.booleanKey(value), "", false, nil
	default:
		return "", "", false, fmt.Errorf("invalid table key type 0x%02X", typeByte)
	}
}

// ReadValue decodes one top-level value.
func (p *LuaParser) ReadValue() (any, error) {
	return p.readValue(0)
}

func (p *LuaParser) readValue(tableDepth int) (any, error) {
	if err := p.budget.Reserve(1, 0, 0); err != nil {
		return nil, err
	}
	typeByte, err := p.R.ReadByte()
	if err != nil {
		return nil, err
	}
	switch typeByte {
	case TypeString:
		return p.readString()
	case TypeNumber:
		value, err := p.readNumber()
		if err != nil {
			return nil, err
		}

		return numberValue(value), nil
	case TypeBoolean:
		return p.readBoolean()
	case TypeTable:
		if tableDepth >= p.maxTableDepth {
			return nil, fmt.Errorf("table depth exceeds %d", p.maxTableDepth)
		}

		return p.readTable(tableDepth + 1)
	default:
		offset := p.R.Size() - int64(p.R.Len()) - 1

		return nil, fmt.Errorf("unknown type byte 0x%02X at offset %d", typeByte, offset)
	}
}

func (p *LuaParser) readTable(tableDepth int) (*Table, error) {
	var arrayCount int32
	if err := binary.Read(p.R, binary.LittleEndian, &arrayCount); err != nil {
		return nil, fmt.Errorf("table array count: %w", err)
	}
	if arrayCount < 0 || int64(arrayCount) > int64(p.R.Len()) {
		return nil, fmt.Errorf("invalid table array count %d", arrayCount)
	}
	if err := p.budget.Reserve(0, int64(arrayCount), 0); err != nil {
		return nil, err
	}
	table := &Table{
		Entries:       make(map[string]any, int(arrayCount)),
		arrayCount:    int(arrayCount),
		stringEntries: make(map[string]any),
		stringOnly:    arrayCount == 0,
	}
	for index := 1; index <= int(arrayCount); index++ {
		value, err := p.readValue(tableDepth)
		if err != nil {
			return nil, fmt.Errorf("table array value %d: %w", index-1, err)
		}
		if err := p.budget.Reserve(0, 0, 18); err != nil {
			return nil, err
		}
		key := p.projector.arrayKey(index)
		table.Entries[key] = value
	}

	var hashCount int32
	if err := binary.Read(p.R, binary.LittleEndian, &hashCount); err != nil {
		return nil, fmt.Errorf("table hash count: %w", err)
	}
	if hashCount < 0 || int64(hashCount) > int64(p.R.Len()) {
		return nil, fmt.Errorf("invalid table hash count %d", hashCount)
	}
	if err := p.budget.Reserve(0, int64(hashCount), 0); err != nil {
		return nil, err
	}
	for index := 0; index < int(hashCount); index++ {
		key, rawStringKey, stringKey, err := p.readKey()
		if err != nil {
			return nil, fmt.Errorf("table key %d: %w", index, err)
		}
		value, err := p.readValue(tableDepth)
		if err != nil {
			return nil, fmt.Errorf("table value %d: %w", index, err)
		}
		if _, exists := table.Entries[key]; exists {
			return nil, fmt.Errorf("table key collision on %q", key)
		}
		table.Entries[key] = value
		if stringKey && table.stringOnly {
			table.stringEntries[rawStringKey] = value
		} else {
			table.stringOnly = false
		}
	}

	return table, nil
}

// ReadTopLevel reads every top-level value in order and propagates every failure.
func (p *LuaParser) ReadTopLevel() ([]any, error) {
	var values []any
	for p.R.Len() > 0 {
		value, err := p.ReadValue()
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	if p.Remaining() != 0 {
		return nil, fmt.Errorf("%d bytes remaining after final value", p.Remaining())
	}

	return values, nil
}

// Remaining reports unread bytes.
func (p *LuaParser) Remaining() int {
	return p.R.Len()
}
