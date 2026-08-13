// states.lua text-line lexing and record materialization for dedump.
// Split from main.go; the grammar is spec section 5.1 states rules.
package main

import (
	"bytes"
	"fmt"
	"math"
	"unicode"
	"unicode/utf8"

	"dedump/parser"
)

type stateParseError struct {
	line   int
	reason string
}

func (failure stateParseError) Error() string {
	return fmt.Sprintf("line %d: %s", failure.line, failure.reason)
}

func invalidUTF8Line(data []byte) int {
	for offset := 0; offset < len(data); {
		character, size := utf8.DecodeRune(data[offset:])
		if character == utf8.RuneError && size == 1 {
			return bytes.Count(data[:offset], []byte{'\n'}) + 1
		}
		offset += size
	}

	return 1
}

func validRecordName(name []byte) bool {
	if len(name) == 0 {
		return false
	}
	for len(name) > 0 {
		character, size := utf8.DecodeRune(name)
		if character <= 0x1f || character >= 0x7f && character <= 0x9f || character == '"' || character == '\\' {
			return false
		}
		name = name[size:]
	}

	return true
}

type stateLineAnalysis struct {
	namespace    string
	recordName   []byte
	fieldBody    []byte
	fieldCount   int64
	retainedText int64
}

type stateValue struct {
	integer int64
	boolean bool
	isBool  bool
}

func isBlankStateLine(line []byte) bool {
	for len(line) > 0 {
		character, size := utf8.DecodeRune(line)
		if !unicode.IsSpace(character) {
			return false
		}
		line = line[size:]
	}

	return true
}

func validStateFieldName(name []byte) bool {
	if len(name) == 0 || !(name[0] >= 'A' && name[0] <= 'Z' || name[0] >= 'a' && name[0] <= 'z' || name[0] == '_') {
		return false
	}
	for _, character := range name[1:] {
		if !(character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '_') {
			return false
		}

	}

	return true
}

func parseStateValue(data []byte) (stateValue, string) {
	if bytes.Equal(data, []byte("true")) {
		return stateValue{boolean: true, isBool: true}, ""
	}
	if bytes.Equal(data, []byte("false")) {
		return stateValue{isBool: true}, ""
	}
	if len(data) == 0 {
		return stateValue{}, "invalid-value"
	}
	negative := false
	position := 0
	if data[0] == '+' || data[0] == '-' {
		negative = data[0] == '-'
		position++
	}
	if position == len(data) {
		return stateValue{}, "invalid-value"
	}
	limit := uint64(math.MaxInt64)
	if negative {
		limit++
	}
	var magnitude uint64
	for ; position < len(data); position++ {
		character := data[position]
		if character < '0' || character > '9' {
			return stateValue{}, "invalid-value"
		}
		digit := uint64(character - '0')
		if magnitude > (limit-digit)/10 {
			return stateValue{}, "integer-out-of-range"
		}
		magnitude = magnitude*10 + digit
	}
	if negative {
		if magnitude == uint64(math.MaxInt64)+1 {
			return stateValue{integer: math.MinInt64}, ""
		}

		return stateValue{integer: -int64(magnitude)}, ""
	}

	return stateValue{integer: int64(magnitude)}, ""
}

// forEachStateField splits a state-field body (a comma-separated list of
// name=value pairs) and invokes visit for each pair, stopping early when visit
// returns false or the body ends. value is nil and name holds the whole token
// when a token lacks '='; callers that receive a pre-validated body never see
// that malformed form.
func forEachStateField(body []byte, visit func(name, value []byte) bool) {
	for position := 0; position <= len(body); {
		relativeEnd := bytes.IndexByte(body[position:], ',')
		end := len(body)
		if relativeEnd >= 0 {
			end = position + relativeEnd
		}
		token := body[position:end]
		equals := bytes.IndexByte(token, '=')
		name := token
		var value []byte
		if equals > 0 {
			name = token[:equals]
			value = token[equals+1:]
		}
		if !visit(name, value) || relativeEnd < 0 {
			break
		}
		position = end + 1
	}
}

func analyzeStateFields(body []byte) (int64, int64, string) {
	var fieldCount int64
	var retainedText int64
	var reason string
	forEachStateField(body, func(name, value []byte) bool {
		if value == nil || len(name) == 0 || bytes.IndexByte(value, '=') >= 0 || !validStateFieldName(name) {
			reason = "invalid-field"
			return false
		}
		if _, r := parseStateValue(value); r != "" {
			reason = r
			return false
		}
		fieldCount++
		retainedText += int64(len(name))

		return true
	})
	if reason != "" {
		return 0, 0, reason
	}

	return fieldCount, retainedText, ""
}

type stateFieldSet interface {
	Add([]byte) bool
}

type ordinalStateFieldSet struct {
	seen map[string]struct{}
}

func (set *ordinalStateFieldSet) Add(name []byte) bool {
	key := string(name)
	if _, exists := set.seen[key]; exists {
		return false
	}
	set.seen[key] = struct{}{}

	return true
}

type stateFieldSetFactory func(int) stateFieldSet

func newOrdinalStateFieldSet(capacity int) stateFieldSet {
	return &ordinalStateFieldSet{seen: make(map[string]struct{}, capacity)}
}

func stateFieldsAreUnique(body []byte, fields stateFieldSet) bool {
	unique := true
	forEachStateField(body, func(name, _ []byte) bool {
		if !fields.Add(name) {
			unique = false
			return false
		}

		return true
	})

	return unique
}

func analyzeStateLine(line []byte) (stateLineAnalysis, string) {
	var namespace string
	var remainder []byte
	switch {
	case bytes.HasPrefix(line, []byte(`AreaState["`)):
		namespace = "AreaState"
		remainder = line[len(`AreaState["`):]
	case bytes.HasPrefix(line, []byte(`ShownOrbs["`)):
		namespace = "ShownOrbs"
		remainder = line[len(`ShownOrbs["`):]
	default:
		return stateLineAnalysis{}, "invalid-record"
	}
	separator := bytes.Index(remainder, []byte(`"]={`))
	if separator < 0 || !bytes.HasSuffix(remainder, []byte("};")) {
		return stateLineAnalysis{}, "invalid-record"
	}
	recordName := remainder[:separator]
	if !validRecordName(recordName) {
		return stateLineAnalysis{}, "invalid-record"
	}
	fieldStart := separator + len(`"]={`)
	if fieldStart > len(remainder)-2 {
		return stateLineAnalysis{}, "invalid-record"
	}
	fieldBody := remainder[fieldStart : len(remainder)-2]
	fieldCount, fieldText, reason := analyzeStateFields(fieldBody)
	if reason != "" {
		return stateLineAnalysis{}, reason
	}

	return stateLineAnalysis{namespace: namespace, recordName: recordName, fieldBody: fieldBody, fieldCount: fieldCount, retainedText: int64(len(recordName)) + fieldText}, ""
}

type stateRecordLookup func(map[string]map[string]any, string) bool

func directStateRecordLookup(namespace map[string]map[string]any, recordName string) bool {
	_, exists := namespace[recordName]

	return exists
}

func materializeStateFields(body []byte, fieldCount int64) map[string]any {
	record := make(map[string]any, int(fieldCount))
	forEachStateField(body, func(name, value []byte) bool {
		parsed, _ := parseStateValue(value)
		if parsed.isBool {
			record[string(name)] = parsed.boolean
		} else {
			record[string(name)] = parsed.integer
		}

		return true
	})

	return record
}

func parseStatesWithSeams(data []byte, budget *parser.MaterializationBudget, fieldSets stateFieldSetFactory, recordLookup stateRecordLookup) (map[string]map[string]any, map[string]map[string]any, error) {
	if !utf8.Valid(data) {
		return nil, nil, stateParseError{line: invalidUTF8Line(data), reason: "invalid-utf8"}
	}
	areas := make(map[string]map[string]any)
	orbs := make(map[string]map[string]any)
	lineNumber := 1
	for position := 0; position <= len(data); lineNumber++ {
		relativeEnd := bytes.IndexByte(data[position:], '\n')
		end := len(data)
		if relativeEnd >= 0 {
			end = position + relativeEnd
		}
		line := data[position:end]
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		if !isBlankStateLine(line) {
			analysis, reason := analyzeStateLine(line)
			if reason != "" {
				return nil, nil, stateParseError{line: lineNumber, reason: reason}
			}
			if !budget.CanReserve(analysis.fieldCount, analysis.fieldCount+1, analysis.retainedText) {
				return nil, nil, stateParseError{line: lineNumber, reason: "materialization-budget-exceeded"}
			}
			if !stateFieldsAreUnique(analysis.fieldBody, fieldSets(int(analysis.fieldCount))) {
				return nil, nil, stateParseError{line: lineNumber, reason: "duplicate-field"}
			}
			target := areas
			if analysis.namespace == "ShownOrbs" {
				target = orbs
			}
			recordName := string(analysis.recordName)
			if recordLookup(target, recordName) {
				return nil, nil, stateParseError{line: lineNumber, reason: "duplicate-record"}
			}
			if err := budget.Reserve(analysis.fieldCount, analysis.fieldCount+1, analysis.retainedText); err != nil {
				return nil, nil, stateParseError{line: lineNumber, reason: "materialization-budget-exceeded"}
			}
			target[recordName] = materializeStateFields(analysis.fieldBody, analysis.fieldCount)
		}
		if relativeEnd < 0 {
			break
		}
		position = end + 1
	}

	return areas, orbs, nil
}

func parseStatesWithFieldSetFactory(data []byte, budget *parser.MaterializationBudget, fieldSets stateFieldSetFactory) (map[string]map[string]any, map[string]map[string]any, error) {
	return parseStatesWithSeams(data, budget, fieldSets, directStateRecordLookup)
}

func parseStatesWithRecordLookup(data []byte, budget *parser.MaterializationBudget, recordLookup stateRecordLookup) (map[string]map[string]any, map[string]map[string]any, error) {
	return parseStatesWithSeams(data, budget, newOrdinalStateFieldSet, recordLookup)
}

func parseStates(data []byte, budget *parser.MaterializationBudget) (map[string]map[string]any, map[string]map[string]any, error) {
	return parseStatesWithSeams(data, budget, newOrdinalStateFieldSet, directStateRecordLookup)
}
