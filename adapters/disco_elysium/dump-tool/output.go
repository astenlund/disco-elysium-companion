package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

var (
	ErrDestinationExists    = errors.New("destination-exists")
	ErrOutputBudgetExceeded = errors.New("output-budget-exceeded")
)

type dumpOutputBudget struct {
	bytes     int64
	tokens    int64
	textBytes int64
}

var productionDumpOutputBudget = dumpOutputBudget{
	bytes:     maxDumpOutputBytes,
	tokens:    maxDumpOutputTokens,
	textBytes: maxDumpOutputTextBytes,
}

func validateSerializedOutput(data []byte, budget dumpOutputBudget) error {
	if int64(len(data)) > budget.bytes {
		return ErrOutputBudgetExceeded
	}
	// One streaming pass covers what previously took three decoder passes: a full
	// discarded json.RawMessage decode (a second full read, up to the whole
	// document size, confirming well-formedness that validateDumpDocument already
	// re-checks) plus its trailing re-read. Counting tokens and text bytes while
	// scanning also detects multiple documents through the top-level value count.
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var tokens int64
	var textBytes int64
	var depth int
	values := 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			if depth != 0 {
				return fmt.Errorf("invalid-output-json: %w", io.ErrUnexpectedEOF)
			}

			return nil
		}
		if err != nil {
			return fmt.Errorf("invalid-output-json: %w", err)
		}
		tokens++
		if text, ok := token.(string); ok {
			textBytes += int64(len(text))
		}
		if tokens > budget.tokens {
			return ErrOutputBudgetExceeded
		}
		if textBytes > budget.textBytes {
			return ErrOutputBudgetExceeded
		}
		delimiter, container := token.(json.Delim)
		switch {
		case !container:
			if depth == 0 {
				values++
			}
		case delimiter == '{' || delimiter == '[':
			depth++
		case depth == 0:
			return fmt.Errorf("invalid-output-json: %v", token)
		default:
			depth--
			if depth == 0 {
				values++
			}
		}
		if values > 1 {
			return fmt.Errorf("multiple-output-documents")
		}
	}
}

func marshalDump(document dumpDocument, variablesOnly bool) ([]byte, error) {
	data, err := json.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("marshal-json: %w", err)
	}
	if err := validateSerializedOutput(data, productionDumpOutputBudget); err != nil {
		return nil, err
	}
	if err := validateDumpDocument(data, variablesOnly); err != nil {
		return nil, fmt.Errorf("invalid-output-document: %w", err)
	}

	return data, nil
}

func writeStdout(writer io.Writer, data []byte) error {
	written, err := writer.Write(data)
	if err != nil {
		return fmt.Errorf("stdout-write-failed: %w", err)
	}
	if written != len(data) {
		return fmt.Errorf("stdout-short-write")
	}

	return nil
}

type publicationFile interface {
	io.Writer
	Sync() error
	Close() error
}

type publicationHooks struct {
	create  func(string) (publicationFile, error)
	publish func(string, string) error
	remove  func(string) error
	suffix  func() (string, error)
}

func randomPublicationSuffix() (string, error) {
	var random [16]byte
	if _, err := io.ReadFull(rand.Reader, random[:]); err != nil {
		return "", err
	}

	return hex.EncodeToString(random[:]), nil
}

func defaultPublicationHooks() publicationHooks {
	return publicationHooks{
		create: func(path string) (publicationFile, error) {
			return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		},
		publish: os.Link,
		remove:  os.Remove,
		suffix:  randomPublicationSuffix,
	}
}

func writePublicationFile(file publicationFile, data []byte) error {
	remaining := data
	for len(remaining) > 0 {
		written, err := file.Write(remaining)
		if err != nil {
			return fmt.Errorf("write-failed: %w", err)
		}
		if written <= 0 || written > len(remaining) {
			return fmt.Errorf("write-failed: %w", io.ErrShortWrite)
		}
		remaining = remaining[written:]
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("flush-failed: %w", err)
	}

	return nil
}

func publishDestination(destination string, data []byte, hooks publicationHooks) error {
	if _, err := os.Lstat(destination); err == nil {
		return ErrDestinationExists
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("destination-check-failed: %w", err)
	}
	suffix, err := hooks.suffix()
	if err != nil {
		return fmt.Errorf("temporary-name-failed: %w", err)
	}
	if len(suffix) != 32 {
		return fmt.Errorf("temporary-name-invalid")
	}
	temporaryPath := destination + "." + suffix + ".tmp"
	file, err := hooks.create(temporaryPath)
	if err != nil {
		return fmt.Errorf("destination-create-failed: %w", err)
	}
	ownedPath := temporaryPath
	cleanup := true
	defer func() {
		if cleanup {
			_ = hooks.remove(ownedPath)
		}
	}()
	if err := writePublicationFile(file, data); err != nil {
		_ = file.Close()

		return err
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close-failed: %w", err)
	}
	if err := hooks.publish(ownedPath, destination); err != nil {
		return fmt.Errorf("publication-failed: %w", err)
	}
	_ = hooks.remove(ownedPath)
	cleanup = false

	return nil
}
