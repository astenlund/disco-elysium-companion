// dedump: Disco Elysium save zip in, complete parsed state JSON out.
// Contract: spec section 5.1 of companion/.claude/specs/state-extraction.md.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"dedump/parser"
)

const variableProbeKey = "character.books_read_counter"

var lowerHex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

type parsedStates struct {
	areaStates map[string]map[string]any
	shownOrbs  map[string]map[string]any
}

type dumpSource struct {
	ZipName       string   `json:"zipName"`
	ByteLength    int64    `json:"byteLength"`
	ContentSHA256 string   `json:"contentSha256"`
	Entries       []string `json:"entries"`
}

type dumpStates struct {
	AreaStates map[string]map[string]any `json:"areaStates"`
	ShownOrbs  map[string]map[string]any `json:"shownOrbs"`
}

type dumpTLV struct {
	Variables map[string]any `json:"variables"`
	AllTables []any          `json:"allTables,omitempty"`
}

type dumpDocument struct {
	Source dumpSource      `json:"source"`
	Header json.RawMessage `json:"header"`
	World  json.RawMessage `json:"world"`
	States dumpStates      `json:"states"`
	TLV    dumpTLV         `json:"tlv"`
}

type commandOptions struct {
	zipPath       string
	outputPath    string
	variablesOnly bool
}

type commandFailure struct {
	stage  string
	reason string
	line   int
	cause  error
}

func (failure commandFailure) Error() string {
	if failure.stage == "states.lua" && failure.line > 0 {
		return fmt.Sprintf("%s: line %d: %s", failure.stage, failure.line, failure.reason)
	}

	return failure.stage + ": " + failure.reason
}

func (failure commandFailure) Unwrap() error {
	return failure.cause
}

type stateParseError struct {
	line   int
	reason string
}

func (failure stateParseError) Error() string {
	return fmt.Sprintf("line %d: %s", failure.line, failure.reason)
}

type jsonMemberAdmissionError struct {
	stage string
	cause error
}

func (failure jsonMemberAdmissionError) Error() string {
	return failure.stage + ": " + failure.cause.Error()
}

func (failure jsonMemberAdmissionError) Unwrap() error {
	return failure.cause
}

var publicDiagnosticRegistry = map[string][]string{
	"arguments": {"usage", "invalid-output-option", "duplicate-variables-only", "unexpected-argument"},
	"archive":   {"invalid-archive"},
	"header":    {"invalid-json-member"},
	"world":     {"invalid-json-member"},
	"tlv":       {"invalid-tlv", "materialization-budget-exceeded"},
	"output":    {"output-budget-exceeded", "stdout-write-failed", "destination-exists", "publication-failed"},
	"internal":  {"failure"},
}

var publicStateReasonRegistry = []string{"invalid-utf8", "invalid-record", "invalid-field", "invalid-value", "integer-out-of-range", "duplicate-record", "duplicate-field", "materialization-budget-exceeded"}

func containsReason(reasons []string, candidate string) bool {
	for _, reason := range reasons {
		if reason == candidate {
			return true
		}

	}

	return false
}

func formatPublicDiagnostic(failure commandFailure) string {
	if failure.stage == "states.lua" && failure.line > 0 && containsReason(publicStateReasonRegistry, failure.reason) {
		return fmt.Sprintf("dedump: states.lua: line %d: %s\n", failure.line, failure.reason)
	}
	if containsReason(publicDiagnosticRegistry[failure.stage], failure.reason) {
		return fmt.Sprintf("dedump: %s: %s\n", failure.stage, failure.reason)
	}

	return "dedump: internal: failure\n"
}

func translateTLVFailure(err error) commandFailure {
	reason := "invalid-tlv"
	if errors.Is(err, parser.ErrMaterializationBudgetExceeded) {
		reason = "materialization-budget-exceeded"
	}

	return commandFailure{stage: "tlv", reason: reason, cause: err}
}

func translateOutputFailure(err error) commandFailure {
	reason := "publication-failed"
	switch {
	case errors.Is(err, ErrOutputBudgetExceeded):
		reason = "output-budget-exceeded"
	case errors.Is(err, ErrDestinationExists):
		reason = "destination-exists"
	}

	return commandFailure{stage: "output", reason: reason, cause: err}
}

func parseArguments(arguments []string) (commandOptions, error) {
	var options commandOptions
	outputSeen := false
	for index := 0; index < len(arguments); index++ {
		switch arguments[index] {
		case "-o":
			if outputSeen || index+1 >= len(arguments) || arguments[index+1] == "" {
				return commandOptions{}, commandFailure{stage: "arguments", reason: "invalid-output-option"}
			}
			outputSeen = true
			index++
			options.outputPath = arguments[index]
		case "-variables-only":
			if options.variablesOnly {
				return commandOptions{}, commandFailure{stage: "arguments", reason: "duplicate-variables-only"}
			}
			options.variablesOnly = true
		default:
			if strings.HasPrefix(arguments[index], "-") || options.zipPath != "" {
				return commandOptions{}, commandFailure{stage: "arguments", reason: "unexpected-argument"}
			}
			options.zipPath = arguments[index]
		}
	}
	if options.zipPath == "" {
		return commandOptions{}, commandFailure{stage: "arguments", reason: "usage"}
	}

	return options, nil
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

// consumeJSONValue/consumeJSONObject walk a strict-JSON value stream to admit
// header/world members. They duplicate the duplicate-property rejection and
// container-depth budget that dumpJSONValidator.genericValue/object apply to the
// assembled output document; keep the two pipelines in sync. The depth sentinels
// differ by the document root: the admission walker is entered with parentDepth=1
// for the value already inside the root object, so its cap reads depth>63 where
// the output validator's containerDepth (which counts the root) reads depth>64.
func consumeJSONValue(decoder *json.Decoder, parentDepth int) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, container := token.(json.Delim)
	if !container {
		return nil
	}
	depth := parentDepth + 1
	if depth > maxStandaloneContainerDepth {
		return fmt.Errorf("container-depth-exceeded")
	}
	switch delimiter {
	case '{':
		return consumeJSONObject(decoder, depth)
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder, depth); err != nil {
				return err
			}
		}
		_, err := decoder.Token()

		return err
	default:
		return fmt.Errorf("unexpected-delimiter")
	}
}

func consumeJSONObject(decoder *json.Decoder, depth int) error {
	seen := make(map[string]struct{})
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		name, ok := token.(string)
		if !ok {
			return fmt.Errorf("invalid-property-name")
		}
		if _, duplicate := seen[name]; duplicate {
			return fmt.Errorf("duplicate-property-name")
		}
		seen[name] = struct{}{}
		if err := consumeJSONValue(decoder, depth); err != nil {
			return err
		}
	}
	_, err := decoder.Token()

	return err
}

func validateJSONMember(data []byte) (json.RawMessage, error) {
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("invalid-utf8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	root, err := decoder.Token()
	if err != nil {
		return nil, fmt.Errorf("invalid-json: %w", err)
	}
	if root != json.Delim('{') {
		return nil, fmt.Errorf("root-not-object")
	}
	if err := consumeJSONObject(decoder, 1); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("multiple-json-values")
		}

		return nil, fmt.Errorf("trailing-json: %w", err)
	}

	return json.RawMessage(append([]byte(nil), data...)), nil
}

func validateTopLevelTables(values []any) error {
	if len(values) != 5 {
		return fmt.Errorf("top-level-count-mismatch")
	}
	for _, value := range values {
		if _, ok := value.(*parser.Table); !ok {
			return fmt.Errorf("top-level-value-not-table")
		}
	}

	return nil
}

func findVariableStore(tables []any) (map[string]any, error) {
	var match map[string]any
	for _, value := range tables {
		table, ok := value.(*parser.Table)
		if !ok {
			continue
		}
		candidate, err := table.StringMap()
		if err != nil {
			continue
		}
		if _, ok := candidate[variableProbeKey].(int64); !ok {
			continue
		}
		taskCount := 0
		validTasks := true
		for key, candidateValue := range candidate {
			if !strings.HasPrefix(key, "TASK.") {
				continue
			}
			taskCount++
			if _, ok := candidateValue.(bool); !ok {
				validTasks = false
			}
		}
		if taskCount != expectedTaskVariableCount || !validTasks {
			continue
		}
		if match != nil {
			return nil, fmt.Errorf("multiple-variable-store-matches")
		}
		match = candidate
	}
	if match == nil {
		return nil, fmt.Errorf("no-variable-store-match")
	}

	return match, nil
}

func buildDumpDocument(zipName string, archive *archiveContents, states parsedStates, variables map[string]any, tables []any, variablesOnly bool) (dumpDocument, error) {
	header, err := validateJSONMember(archive.members.header)
	if err != nil {
		return dumpDocument{}, jsonMemberAdmissionError{stage: "header", cause: err}
	}
	world, err := validateJSONMember(archive.members.world)
	if err != nil {
		return dumpDocument{}, jsonMemberAdmissionError{stage: "world", cause: err}
	}
	document := dumpDocument{
		Source: dumpSource{ZipName: zipName, ByteLength: archive.byteLength, ContentSHA256: archive.contentSHA256, Entries: archive.entries},
		Header: header,
		World:  world,
		States: dumpStates{AreaStates: states.areaStates, ShownOrbs: states.shownOrbs},
		TLV:    dumpTLV{Variables: variables},
	}
	if !variablesOnly {
		document.TLV.AllTables = tables
	}

	return document, nil
}

type dumpJSONValidator struct {
	decoder *json.Decoder
}

func (validator *dumpJSONValidator) containerDepth(parentDepth int) (int, error) {
	// Counterpart of the depth>63 cap in consumeJSONValue (the admission walker);
	// keep the two synchronized. This path counts the document root, hence 64.
	depth := parentDepth + 1
	if depth > maxAssembledContainerDepth {
		return 0, fmt.Errorf("container-depth-exceeded")
	}

	return depth, nil
}

func (validator *dumpJSONValidator) object(parentDepth int, visit func(string, int) error) (int, error) {
	token, err := validator.decoder.Token()
	if err != nil || token != json.Delim('{') {
		return 0, fmt.Errorf("expected-object")
	}
	depth, err := validator.containerDepth(parentDepth)
	if err != nil {
		return 0, err
	}
	seen := make(map[string]struct{})
	count := 0
	for validator.decoder.More() {
		propertyToken, err := validator.decoder.Token()
		if err != nil {
			return 0, err
		}
		property, ok := propertyToken.(string)
		if !ok {
			return 0, fmt.Errorf("invalid-property-name")
		}
		if _, duplicate := seen[property]; duplicate {
			return 0, fmt.Errorf("duplicate-property-name")
		}
		seen[property] = struct{}{}
		count++
		if err := visit(property, depth); err != nil {
			return 0, err
		}
	}
	if token, err := validator.decoder.Token(); err != nil || token != json.Delim('}') {
		return 0, fmt.Errorf("unterminated-object")
	}

	return count, nil
}

func (validator *dumpJSONValidator) exactObject(parentDepth int, fields map[string]func(int) error) error {
	seen := make(map[string]struct{}, len(fields))
	count, err := validator.object(parentDepth, func(property string, depth int) error {
		validate, exists := fields[property]
		if !exists {
			return fmt.Errorf("unexpected-field")
		}
		seen[property] = struct{}{}

		return validate(depth)
	})
	if err != nil {
		return err
	}
	if count != len(fields) || len(seen) != len(fields) {
		return fmt.Errorf("missing-field")
	}

	return nil
}

func (validator *dumpJSONValidator) stringValue(nonempty bool) error {
	token, err := validator.decoder.Token()
	value, ok := token.(string)
	if err != nil || !ok || nonempty && value == "" {
		return fmt.Errorf("expected-string")
	}

	return nil
}

func (validator *dumpJSONValidator) source(parentDepth int) error {
	return validator.exactObject(parentDepth, map[string]func(int) error{
		"zipName": func(int) error { return validator.stringValue(true) },
		"byteLength": func(int) error {
			token, err := validator.decoder.Token()
			number, ok := token.(json.Number)
			if err != nil || !ok {
				return fmt.Errorf("invalid-byte-length")
			}
			value, err := strconv.ParseInt(number.String(), 10, 64)
			if err != nil || value <= 0 {
				return fmt.Errorf("invalid-byte-length")
			}

			return nil
		},
		"contentSha256": func(int) error {
			token, err := validator.decoder.Token()
			value, ok := token.(string)
			if err != nil || !ok || !lowerHex64.MatchString(value) {
				return fmt.Errorf("invalid-content-hash")
			}

			return nil
		},
		"entries": func(depth int) error {
			token, err := validator.decoder.Token()
			if err != nil || token != json.Delim('[') {
				return fmt.Errorf("invalid-entries")
			}
			if _, err := validator.containerDepth(depth); err != nil {
				return err
			}
			count := 0
			for validator.decoder.More() {
				if err := validator.stringValue(false); err != nil {
					return fmt.Errorf("invalid-entry")
				}
				count++
			}
			if token, err := validator.decoder.Token(); err != nil || token != json.Delim(']') || count == 0 {
				return fmt.Errorf("invalid-entries")
			}

			return nil
		},
	})
}

func (validator *dumpJSONValidator) genericValue(parentDepth int) error {
	token, err := validator.decoder.Token()
	if err != nil {
		return err
	}
	delimiter, container := token.(json.Delim)
	if !container {
		return nil
	}
	depth, err := validator.containerDepth(parentDepth)
	if err != nil {
		return err
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for validator.decoder.More() {
			propertyToken, err := validator.decoder.Token()
			if err != nil {
				return err
			}
			property, ok := propertyToken.(string)
			if !ok {
				return fmt.Errorf("invalid-property-name")
			}
			if _, duplicate := seen[property]; duplicate {
				return fmt.Errorf("duplicate-property-name")
			}
			seen[property] = struct{}{}
			if err := validator.genericValue(depth); err != nil {
				return err
			}
		}
		_, err := validator.decoder.Token()

		return err
	case '[':
		for validator.decoder.More() {
			if err := validator.genericValue(depth); err != nil {
				return err
			}
		}
		_, err := validator.decoder.Token()

		return err
	default:
		return fmt.Errorf("unexpected-delimiter")
	}
}

func (validator *dumpJSONValidator) genericObject(parentDepth int) error {
	_, err := validator.object(parentDepth, func(_ string, depth int) error { return validator.genericValue(depth) })

	return err
}

func (validator *dumpJSONValidator) stateRecord(parentDepth int) error {
	count, err := validator.object(parentDepth, func(_ string, _ int) error {
		token, err := validator.decoder.Token()
		if err != nil {
			return err
		}
		if _, ok := token.(bool); ok {
			return nil
		}
		number, ok := token.(json.Number)
		if !ok {
			return fmt.Errorf("invalid-state-value")
		}
		if _, err := strconv.ParseInt(number.String(), 10, 64); err != nil {
			return fmt.Errorf("invalid-state-value")
		}

		return nil
	})
	if err != nil {
		return err
	}
	if count == 0 {
		return fmt.Errorf("empty-state-record")
	}

	return nil
}

func (validator *dumpJSONValidator) stateNamespace(parentDepth int) error {
	_, err := validator.object(parentDepth, func(_ string, depth int) error { return validator.stateRecord(depth) })

	return err
}

func (validator *dumpJSONValidator) states(parentDepth int) error {
	return validator.exactObject(parentDepth, map[string]func(int) error{
		"areaStates": validator.stateNamespace,
		"shownOrbs":  validator.stateNamespace,
	})
}

func validProjectedTLVKey(key string) bool {
	if strings.HasPrefix(key, "s:") || key == "b:0" || key == "b:1" {
		return true
	}
	if len(key) != 18 || !strings.HasPrefix(key, "n:") {
		return false
	}
	for _, character := range key[2:] {
		if character < '0' || character > '9' && (character < 'a' || character > 'f') {
			return false
		}
	}
	bits, err := strconv.ParseUint(key[2:], 16, 64)
	if err != nil || bits == 1<<63 {
		return false
	}
	value := math.Float64frombits(bits)

	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func (validator *dumpJSONValidator) tlvValue(parentDepth int) error {
	token, err := validator.decoder.Token()
	if err != nil {
		return err
	}
	if token == nil {
		return nil
	}
	switch value := token.(type) {
	case bool, string:
		return nil
	case json.Number:
		number, err := strconv.ParseFloat(value.String(), 64)
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			return fmt.Errorf("invalid-tlv-number")
		}

		return nil
	case json.Delim:
		if value != '{' {
			return fmt.Errorf("invalid-tlv-container")
		}
		depth, err := validator.containerDepth(parentDepth)
		if err != nil {
			return err
		}
		seen := make(map[string]struct{})
		for validator.decoder.More() {
			propertyToken, err := validator.decoder.Token()
			if err != nil {
				return err
			}
			property, ok := propertyToken.(string)
			if !ok {
				return fmt.Errorf("invalid-property-name")
			}
			if !validProjectedTLVKey(property) {
				return fmt.Errorf("invalid-projected-key")
			}
			if _, duplicate := seen[property]; duplicate {
				return fmt.Errorf("duplicate-property-name")
			}
			seen[property] = struct{}{}
			if err := validator.tlvValue(depth); err != nil {
				return err
			}
		}
		_, err = validator.decoder.Token()

		return err
	default:
		return fmt.Errorf("invalid-tlv-value")
	}
}

func (validator *dumpJSONValidator) tlvObject(parentDepth int) error {
	_, err := validator.object(parentDepth, func(_ string, depth int) error { return validator.tlvValue(depth) })

	return err
}

func (validator *dumpJSONValidator) projectedTLVObject(parentDepth int) error {
	_, err := validator.object(parentDepth, func(property string, depth int) error {
		if !validProjectedTLVKey(property) {
			return fmt.Errorf("invalid-projected-key")
		}

		return validator.tlvValue(depth)
	})

	return err
}

func (validator *dumpJSONValidator) allTables(parentDepth int) error {
	token, err := validator.decoder.Token()
	if err != nil || token != json.Delim('[') {
		return fmt.Errorf("invalid-all-tables")
	}
	depth, err := validator.containerDepth(parentDepth)
	if err != nil {
		return err
	}
	count := 0
	for validator.decoder.More() {
		if err := validator.projectedTLVObject(depth); err != nil {
			return err
		}
		count++
	}
	if token, err := validator.decoder.Token(); err != nil || token != json.Delim(']') || count != 5 {
		return fmt.Errorf("invalid-all-tables")
	}

	return nil
}

func (validator *dumpJSONValidator) tlv(parentDepth int, variablesOnly bool) error {
	fields := map[string]func(int) error{"variables": validator.tlvObject}
	if !variablesOnly {
		fields["allTables"] = validator.allTables
	}

	return validator.exactObject(parentDepth, fields)
}

func validateDumpDocument(data []byte, variablesOnly bool) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	validator := &dumpJSONValidator{decoder: decoder}
	err := validator.exactObject(0, map[string]func(int) error{
		"source": validator.source,
		"header": validator.genericObject,
		"world":  validator.genericObject,
		"states": validator.states,
		"tlv":    func(depth int) error { return validator.tlv(depth, variablesOnly) },
	})
	if err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple-json-values")
		}

		return err
	}

	return nil
}

func run(arguments []string, stdout io.Writer) error {
	options, err := parseArguments(arguments)
	if err != nil {
		return err
	}
	archive, err := readArchive(options.zipPath)
	if err != nil {
		return commandFailure{stage: "archive", reason: "invalid-archive", cause: err}
	}
	budget := parser.NewMaterializationBudget(maxTLVDecodedValues, maxTLVProjectedEntries, maxTLVRetainedTextBytes)
	areas, orbs, err := parseStates(archive.members.states, budget)
	if err != nil {
		var stateFailure stateParseError
		if errors.As(err, &stateFailure) {
			return commandFailure{stage: "states.lua", line: stateFailure.line, reason: stateFailure.reason, cause: err}
		}

		return commandFailure{stage: "states.lua", line: 1, reason: "invalid-record", cause: err}
	}
	tables, err := parser.New(archive.members.tlv, budget, maxTLVDepth).ReadTopLevel()
	if err != nil {
		return translateTLVFailure(err)
	}
	if err := validateTopLevelTables(tables); err != nil {
		return translateTLVFailure(err)
	}
	variables, err := findVariableStore(tables)
	if err != nil {
		return translateTLVFailure(err)
	}
	document, err := buildDumpDocument(options.zipPath, archive, parsedStates{areaStates: areas, shownOrbs: orbs}, variables, tables, options.variablesOnly)
	if err != nil {
		var admissionFailure jsonMemberAdmissionError
		if errors.As(err, &admissionFailure) {
			return commandFailure{stage: admissionFailure.stage, reason: "invalid-json-member", cause: err}
		}

		return commandFailure{stage: "output", reason: "publication-failed", cause: err}
	}
	data, err := marshalDump(document, options.variablesOnly)
	if err != nil {
		return translateOutputFailure(err)
	}
	if options.outputPath == "" {
		if err := writeStdout(stdout, data); err != nil {
			return commandFailure{stage: "output", reason: "stdout-write-failed", cause: err}
		}

		return nil
	}
	if err := publishDestination(options.outputPath, data, defaultPublicationHooks()); err != nil {
		return translateOutputFailure(err)
	}

	return nil
}

func executeCommand(arguments []string, stdout io.Writer, stderr io.Writer) int {
	if err := run(arguments, stdout); err != nil {
		var failure commandFailure
		if !errors.As(err, &failure) {
			failure = commandFailure{stage: "internal", reason: "failure", cause: err}
		}
		_, _ = io.WriteString(stderr, formatPublicDiagnostic(failure))

		return 1
	}

	return 0
}

func main() {
	if executeCommand(os.Args[1:], os.Stdout, os.Stderr) != 0 {
		os.Exit(1)
	}
}
