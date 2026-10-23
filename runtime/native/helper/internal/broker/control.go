package broker

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	maxControlBytes     = 1_048_576
	maxControlTokens    = 65_536
	maxControlTextBytes = 524_288
)

var errControl = errors.New("invalid broker control")

type control struct {
	command          string
	args             []string
	cwd              string
	jobName          string
	parentPID        int32
	parentCreated    string
	childEnvironment map[string]string
}

func readControlFrame(reader *bufio.Reader) ([]byte, error) {
	frame := make([]byte, 0, 4096)
	for len(frame) <= maxControlBytes {
		value, err := reader.ReadByte()
		if err != nil {
			return nil, errControl
		}
		if value == byte(10) {
			if len(frame) == 0 || !utf8.Valid(frame) {
				return nil, errControl
			}
			return frame, nil
		}
		frame = append(frame, value)
	}
	return nil, errControl
}

func parseObject(data []byte, allowed map[string]bool, required int) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, errControl
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok || allowed != nil && !allowed[name] {
			return nil, errControl
		}
		if _, exists := fields[name]; exists {
			return nil, errControl
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, errControl
		}
		fields[name] = value
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') || required >= 0 && len(fields) != required {
		return nil, errControl
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errControl
	}
	return fields, nil
}

func parseString(data json.RawMessage, allowEmpty bool) (string, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) < 2 || trimmed[0] != byte(34) {
		return "", errControl
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil || !allowEmpty && value == "" {
		return "", errControl
	}
	return value, nil
}

func parseInt32(data json.RawMessage) (int32, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return 0, errControl
	}
	value, err := strconv.ParseInt(string(trimmed), 10, 32)
	if err != nil {
		return 0, errControl
	}
	return int32(value), nil
}

func parseStrings(data json.RawMessage) ([]string, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != byte(91) {
		return nil, errControl
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(trimmed, &raw); err != nil || raw == nil {
		return nil, errControl
	}
	values := make([]string, len(raw))
	for index, item := range raw {
		value, err := parseString(item, true)
		if err != nil {
			return nil, err
		}
		values[index] = value
	}
	return values, nil
}

func parseEnvironment(data json.RawMessage) (map[string]string, error) {
	fields, err := parseObject(data, nil, -1)
	if err != nil {
		return nil, err
	}
	values := make(map[string]string, len(fields))
	folded := make(map[string]bool, len(fields))
	for name, raw := range fields {
		value, err := parseString(raw, true)
		if err != nil || name == "" || strings.ContainsRune(name, '=') || strings.ContainsRune(name, rune(0)) || strings.ContainsRune(value, rune(0)) {
			return nil, errControl
		}
		key := strings.ToUpper(name)
		if folded[key] {
			return nil, errControl
		}
		folded[key] = true
		values[name] = value
	}
	return values, nil
}

func parseControl(frame []byte) (control, error) {
	if !utf8.Valid(frame) || len(frame) > maxControlBytes {
		return control{}, errControl
	}
	allowed := map[string]bool{
		"command": true, "args": true, "cwd": true, "jobName": true,
		"parentPid": true, "parentCreated": true, "brokerProtocolVersion": true, "childEnvironment": true,
	}
	fields, err := parseObject(frame, allowed, len(allowed))
	if err != nil {
		return control{}, err
	}
	version, err := parseInt32(fields["brokerProtocolVersion"])
	if err != nil || version != 2 {
		return control{}, errControl
	}
	parentPID, err := parseInt32(fields["parentPid"])
	if err != nil || parentPID < 1 {
		return control{}, errControl
	}
	command, err := parseString(fields["command"], false)
	if err != nil {
		return control{}, err
	}
	args, err := parseStrings(fields["args"])
	if err != nil {
		return control{}, err
	}
	cwd, err := parseString(fields["cwd"], false)
	if err != nil {
		return control{}, err
	}
	jobName, err := parseString(fields["jobName"], false)
	if err != nil {
		return control{}, err
	}
	parentCreated, err := parseString(fields["parentCreated"], false)
	if err != nil {
		return control{}, err
	}
	environment, err := parseEnvironment(fields["childEnvironment"])
	if err != nil {
		return control{}, err
	}
	tokens := 20 + len(args) + 2*len(environment)
	textBytes := len(command) + len(cwd) + len(jobName) + len(parentCreated)
	for name := range fields {
		textBytes += len(name)
	}
	for _, argument := range args {
		textBytes += len(argument)
	}
	for name, value := range environment {
		textBytes += len(name) + len(value)
	}
	if tokens > maxControlTokens || textBytes > maxControlTextBytes {
		return control{}, errControl
	}
	return control{command, args, cwd, jobName, parentPID, parentCreated, environment}, nil
}
