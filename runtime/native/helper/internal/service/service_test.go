package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	j "companion-helper/internal/jsondoc"
	"companion-helper/internal/nativefs"
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
	return startIn(t, companionFor(t))
}

// companionFor gives a test its own companion root under its canonical temporary folder.
func companionFor(t *testing.T) string {
	t.Helper()
	admitted, err := nativefs.Admit(t.TempDir(), false)
	if err != nil {
		t.Fatalf("temporary companion root is not admitted: %v", err)
	}
	return admitted.Path
}

func startIn(t *testing.T, companionRoot string) *session {
	t.Helper()
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	done := make(chan int, 1)
	go func() {
		code := Run(nonce, companionRoot, inputReader, outputWriter)
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

func TestQuarantineTrimIsAMutatingRequest(t *testing.T) {
	// Arrange
	s := start(t)
	fields := `"root":"C:/x","scopeSha256":"` + strings.Repeat("0", 64) + `","companionRoot":"C:/x","inputBase64":null,"inputFile":null,"inputSha256":null`
	inventory, inventoryErr := j.Parse([]byte(`{"op":"inventory","mode":"Inventory",`+fields+`}`), frameBudget)
	trim, trimErr := j.Parse([]byte(`{"op":"inventory","mode":"Quarantine",`+fields+`}`), frameBudget)

	// Act
	s.send(`{"version":1,"seq":1,"op":"inventory","deadlineMs":1000,"mode":"Quarantine",` + fields + `}`)
	reply := s.read()

	// Assert: a trim deletes files, so it needs a bound scope and keeps its result past its commit point.
	if inventoryErr != nil || trimErr != nil || mutating(handlers["inventory"], "inventory", inventory) || !mutating(handlers["inventory"], "inventory", trim) {
		t.Fatalf("inventory mode classification is wrong: %v %v", inventoryErr, trimErr)
	}
	if reply["status"] != "error" || reply["code"] != "scopeUnbound" {
		t.Fatalf("unbound trim answered %v", reply)
	}
	if code := s.exitCode(); code != exitClean {
		t.Fatalf("exit %d", code)
	}
}

func TestBindingPastItsCommitPointKeepsItsResult(t *testing.T) {
	// Arrange: a handler that succeeds only after its request's deadline has passed.
	slow := handler{run: func(*call, *j.Value) ([]byte, string) {
		time.Sleep(80 * time.Millisecond)
		return []byte(`{"bound":true}`), ""
	}}
	request, err := j.Parse([]byte(`{"op":"x"}`), frameBudget)
	if err != nil {
		t.Fatal(err)
	}
	reply := func(op string) map[string]any {
		work := &call{state: &state{}, deadline: time.Now().Add(20 * time.Millisecond)}
		var value map[string]any
		if json.Unmarshal(serve(work, slow, request, 1, op), &value) != nil {
			t.Fatalf("%s reply is not JSON", op)
		}
		return value
	}

	// Act
	bound := reply("bindScope")
	read := reply("admit")

	// Assert: a binding that created and joined its job replies normally; a read that ran out replies deadlineExceeded.
	if bound["status"] != "ok" {
		t.Fatalf("a binding past its commit point answered %v", bound)
	}
	if read["status"] != "error" || read["code"] != "deadlineExceeded" {
		t.Fatalf("an expired read answered %v", read)
	}
}

func TestBindingThatExpiresBeforeItsJobStaysUnbound(t *testing.T) {
	// Arrange: a binding whose deadline passed before it could create its job.
	shared := &state{}
	work := &call{state: shared, deadline: time.Now().Add(-time.Second)}
	request, err := j.Parse([]byte(`{"op":"bindScope","token":"`+strings.Repeat("0", 32)+`","companionRoot":"C:/x","dataRoot":"C:/x/data"}`), frameBudget)
	if err != nil {
		t.Fatal(err)
	}

	// Act
	var reply map[string]any
	if json.Unmarshal(serve(work, handlers["bindScope"], request, 1, "bindScope"), &reply) != nil {
		t.Fatal("the reply is not JSON")
	}

	// Assert
	if reply["status"] != "error" || reply["code"] != "deadlineExceeded" || shared.isBound() {
		t.Fatalf("an expired binding answered %v, bound %v", reply, shared.isBound())
	}
}

func TestReadsAndBindingAreConfinedToTheCompanionRoot(t *testing.T) {
	// Arrange: a companion root, and an ordinary directory outside it standing in for SaveGames.
	companion := companionFor(t)
	outside := companionFor(t)
	s := startIn(t, companion)
	admit := func(seq int, root string) map[string]any {
		encoded, _ := json.Marshal(root)
		s.send(fmt.Sprintf(`{"version":1,"seq":%d,"op":"admit","deadlineMs":5000,"root":%s,"targets":[%s],"allowMissing":true}`, seq, encoded, encoded))
		return s.read()
	}
	bind := func(seq int, root string) map[string]any {
		encoded, _ := json.Marshal(root)
		data, _ := json.Marshal(root + `/data`)
		s.send(fmt.Sprintf(`{"version":1,"seq":%d,"op":"bindScope","deadlineMs":5000,"token":"%s","companionRoot":%s,"dataRoot":%s}`, seq, strings.Repeat("a", 32), encoded, data))
		return s.read()
	}
	source := func(seq int, root, data string) map[string]any {
		encoded, _ := json.Marshal(root)
		dataRoot, _ := json.Marshal(data)
		sourceRoot, _ := json.Marshal(outside)
		s.send(fmt.Sprintf(`{"version":1,"seq":%d,"op":"coreReplySource","deadlineMs":5000,"companionRoot":%s,"dataRoot":%s,"sourceRoot":%s}`, seq, encoded, dataRoot, sourceRoot))
		return s.read()
	}

	// Act
	inside := admit(1, companion)
	refused := admit(2, outside)
	foreignBinding := bind(3, outside)
	insideSource := source(4, companion, companion+`/data`)
	foreignSource := source(5, outside, outside+`/data`)
	foreignData := source(6, companion, outside+`/data`)

	// Assert
	if inside["status"] != "ok" {
		t.Fatalf("a read inside the companion root answered %v", inside)
	}
	if refused["status"] != "error" || refused["code"] != "admissionUnavailable" {
		t.Fatalf("a read outside the companion root answered %v", refused)
	}
	if foreignBinding["status"] != "error" || foreignBinding["code"] != "jobUnavailable" {
		t.Fatalf("a binding of another companion root answered %v", foreignBinding)
	}
	if insideSource["status"] != "ok" {
		t.Fatalf("a core-reply source inside the companion root answered %v", insideSource)
	}
	for _, reply := range []map[string]any{foreignSource, foreignData} {
		if reply["status"] != "error" || reply["code"] != "sourceUnavailable" {
			t.Fatalf("a core-reply source outside the companion root answered %v", reply)
		}
	}
	if code := s.exitCode(); code != exitClean {
		t.Fatalf("exit %d", code)
	}
}

func TestServiceRefusesToStartForAnInvalidCompanionRoot(t *testing.T) {
	// Arrange
	missing := companionFor(t) + `/absent`

	// Act
	code := Run(nonce, missing, strings.NewReader(""), io.Discard)

	// Assert
	if code != exitProtocol {
		t.Fatalf("exit %d", code)
	}
}
