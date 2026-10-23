package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
)

const nonce = "0123456789abcdef0123456789abcdef"

type session struct {
	t      *testing.T
	input  *io.PipeWriter
	output *io.PipeReader
	done   chan int
}

func start(t *testing.T) *session {
	t.Helper()
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	done := make(chan int, 1)
	go func() {
		code := Run(nonce, inputReader, outputWriter)
		outputWriter.Close()
		done <- code
	}()
	s := &session{t, inputWriter, outputReader, done}
	hello := s.read()
	if hello["nonce"] != nonce || hello["version"] != float64(1) {
		t.Fatalf("unexpected hello %v", hello)
	}
	return s
}

func (s *session) read() map[string]any {
	s.t.Helper()
	frame, err := ReadFrame(s.output)
	if err != nil {
		s.t.Fatalf("read frame: %v", err)
	}
	var value map[string]any
	if err := json.Unmarshal(frame, &value); err != nil {
		s.t.Fatal(err)
	}
	return value
}

func (s *session) send(body string) {
	s.t.Helper()
	if err := WriteFrame(s.input, []byte(body)); err != nil {
		s.t.Fatal(err)
	}
}

func (s *session) exitCode() int {
	s.input.Close()
	io.Copy(io.Discard, s.output)
	return <-s.done
}

func TestServiceServesMoreThanTheWorkerIdentifierBound(t *testing.T) {
	// Arrange
	s := start(t)

	// Act
	for seq := 1; seq <= 8300; seq++ {
		s.send(fmt.Sprintf(`{"version":1,"seq":%d,"op":"principal","deadlineMs":30000}`, seq))
		reply := s.read()

		// Assert
		if reply["seq"] != float64(seq) || reply["status"] != "ok" {
			t.Fatalf("request %d failed: %v", seq, reply)
		}
	}
	if code := s.exitCode(); code != exitClean {
		t.Fatalf("clean end exited %d", code)
	}
}

func TestServiceFailsClosedOnSequenceViolations(t *testing.T) {
	// Arrange
	frames := map[string][]string{
		"repeated":      {`{"version":1,"seq":1,"op":"principal","deadlineMs":1}`, `{"version":1,"seq":1,"op":"principal","deadlineMs":1}`},
		"skipped":       {`{"version":1,"seq":2,"op":"principal","deadlineMs":1}`},
		"zero":          {`{"version":1,"seq":0,"op":"principal","deadlineMs":1}`},
		"unknown op":    {`{"version":1,"seq":1,"op":"shell","deadlineMs":1}`},
		"extra field":   {`{"version":1,"seq":1,"op":"principal","deadlineMs":1,"x":1}`},
		"bad version":   {`{"version":2,"seq":1,"op":"principal","deadlineMs":1}`},
		"not an object": {`[1]`},
	}
	for name, sequence := range frames {
		s := start(t)
		// Act
		for index, frame := range sequence {
			s.send(frame)
			if index < len(sequence)-1 {
				s.read()
			}
		}

		// Assert
		code := s.exitCode()
		if code != exitProtocol {
			t.Fatalf("%s exited %d", name, code)
		}
	}
}

func TestServiceRefusesMutationBeforeBinding(t *testing.T) {
	// Arrange
	s := start(t)
	request := `{"version":1,"seq":1,"op":"fileAction","deadlineMs":1,"root":"C:\\x","action":"Remove","source":"C:\\x\\y","sha256":"` + strings.Repeat("0", 64) + `","target":null}`

	// Act
	s.send(request)
	reply := s.read()

	// Assert
	if reply["status"] != "error" || reply["code"] != "scopeUnbound" {
		t.Fatalf("unbound mutation answered %v", reply)
	}
	if code := s.exitCode(); code != exitClean {
		t.Fatalf("exit %d", code)
	}
}

func TestFramesRejectOversizeAndTruncation(t *testing.T) {
	// Arrange
	oversize := []byte{0x00, 0x20, 0x00, 0x01}
	truncated := []byte{0x00, 0x00, 0x00, 0x05, '{'}

	// Act
	_, oversizeErr := ReadFrame(bytes.NewReader(oversize))
	_, truncatedErr := ReadFrame(bytes.NewReader(truncated))
	_, emptyErr := ReadFrame(bytes.NewReader(nil))

	// Assert
	if oversizeErr == nil || truncatedErr == nil || emptyErr != io.EOF {
		t.Fatalf("frame errors: %v %v %v", oversizeErr, truncatedErr, emptyErr)
	}
}
