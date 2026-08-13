// dedump: Disco Elysium save zip in, complete parsed state JSON out.
// Contract: spec section 5.1 of companion/.claude/specs/state-extraction.md.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"dedump/parser"
)

const variableProbeKey = "character.books_read_counter"

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

func validateTopLevelTables(values []any) error {
	if len(values) != expectedTopLevelTableCount {
		return fmt.Errorf("top-level-count-mismatch")
	}
	for _, value := range values {
		if _, ok := value.(*parser.Table); !ok {
			return fmt.Errorf("top-level-value-not-table")
		}
	}

	return nil
}

func isVariableStore(table *parser.Table) bool {
	probe, exists := table.StringEntry(variableProbeKey)
	if !exists {
		return false
	}
	if _, ok := probe.(int64); !ok {
		return false
	}
	taskCount := 0
	validTasks := true
	table.EachStringEntry(func(key string, value any) bool {
		if !strings.HasPrefix(key, "TASK.") {
			return true
		}
		taskCount++
		if _, ok := value.(bool); !ok {
			validTasks = false
		}

		return true
	})

	return taskCount == expectedTaskVariableCount && validTasks
}

func findVariableStore(tables []any) (map[string]any, error) {
	var match *parser.Table
	for _, value := range tables {
		table, ok := value.(*parser.Table)
		if !ok || !isVariableStore(table) {
			continue
		}
		if match != nil {
			return nil, fmt.Errorf("multiple-variable-store-matches")
		}
		match = table
	}
	if match == nil {
		return nil, fmt.Errorf("no-variable-store-match")
	}

	return match.StringMap()
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
