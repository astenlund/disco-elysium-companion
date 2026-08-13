// Streaming JSON validation for dedump: header/world member admission and
// the assembled-output document validator. Split from main.go; keep the
// admission walker and dumpJSONValidator pipelines in sync as documented.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"unicode/utf8"

	"dedump/parser"
)

var lowerHex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

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

	// The archive member bytes are immutable once read, so the admitted member
	// aliases them instead of copying.
	return json.RawMessage(data), nil
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
			if !parser.ValidProjectedKey(property) {
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
		if !parser.ValidProjectedKey(property) {
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
	if token, err := validator.decoder.Token(); err != nil || token != json.Delim(']') || count != expectedTopLevelTableCount {
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
