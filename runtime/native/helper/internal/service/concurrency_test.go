package service

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	j "companion-helper/internal/jsondoc"
)

// release unblocks the test-only waiting handlers; each test that uses them closes a fresh channel.
var release chan struct{}

// committed records whether the test-only mutating handler passed its commit gate.
var committed chan bool

func init() {
	handlers["testWait"] = handler{nil, false, func(*call, *j.Value) ([]byte, string) {
		<-release
		return []byte(`{"waited":true}`), ""
	}}
	handlers["testSleep"] = handler{nil, false, func(*call, *j.Value) ([]byte, string) {
		time.Sleep(50 * time.Millisecond)
		return []byte(`{"slept":true}`), ""
	}}
	handlers["testCommit"] = handler{nil, true, func(c *call, _ *j.Value) ([]byte, string) {
		time.Sleep(50 * time.Millisecond)
		if err := c.gate()(); err != nil {
			committed <- false
			return nil, failure(err, "publicationFailed")
		}
		committed <- true
		return []byte(`{"committed":true}`), ""
	}}
}

func TestServiceAnswersAFastRequestWhileASlowOneWaits(t *testing.T) {
	// Arrange
	release = make(chan struct{})
	s := start(t)

	// Act
	s.send(`{"version":1,"seq":1,"op":"testWait","deadlineMs":30000}`)
	s.send(`{"version":1,"seq":2,"op":"principal","deadlineMs":30000}`)
	first := s.read()
	close(release)
	second := s.read()

	// Assert
	if first["seq"] != float64(2) || first["status"] != "ok" {
		t.Fatalf("the fast request did not answer first: %v", first)
	}
	if second["seq"] != float64(1) || second["status"] != "ok" {
		t.Fatalf("the slow request answered %v", second)
	}
	if code := s.exitCode(); code != exitClean {
		t.Fatalf("exit %d", code)
	}
}

func TestServiceFailsClosedBeyondSixteenRequestsInFlight(t *testing.T) {
	// Arrange
	release = make(chan struct{})
	defer close(release)
	s := start(t)

	// Act
	for seq := 1; seq <= MaximumInFlight+1; seq++ {
		s.send(fmt.Sprintf(`{"version":1,"seq":%d,"op":"testWait","deadlineMs":30000}`, seq))
	}

	// Assert
	select {
	case code := <-s.done:
		if code != exitProtocol {
			t.Fatalf("seventeenth request exited %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the seventeenth request in flight was accepted")
	}
}

func TestServiceRefusesARequestThatOutlivesItsDeadline(t *testing.T) {
	// Arrange
	s := start(t)

	// Act
	s.send(`{"version":1,"seq":1,"op":"testSleep","deadlineMs":5}`)
	reply := s.read()

	// Assert
	if reply["status"] != "error" || reply["code"] != "deadlineExceeded" {
		t.Fatalf("a late read-only request answered %v", reply)
	}
	if code := s.exitCode(); code != exitClean {
		t.Fatalf("exit %d", code)
	}
}

// commitWithin serves the test mutation on a bound state with the given deadline.
func commitWithin(t *testing.T, deadlineMs int) map[string]any {
	t.Helper()
	committed = make(chan bool, 1)
	current := &state{bound: true, dataRoot: `C:\`}
	work := &call{state: current, deadline: time.Now().Add(time.Duration(deadlineMs) * time.Millisecond)}
	request, err := j.Parse([]byte(`{}`), frameBudget)
	if err != nil {
		t.Fatal(err)
	}
	var reply map[string]any
	if err := json.Unmarshal(serve(work, handlers["testCommit"], request, 1, "testCommit"), &reply); err != nil {
		t.Fatal(err)
	}
	return reply
}

func TestServiceStopsAMutationAtItsCommitGateAfterTheDeadline(t *testing.T) {
	// Arrange
	deadlineMs := 5

	// Act
	reply := commitWithin(t, deadlineMs)

	// Assert
	if reply["status"] != "error" || reply["code"] != "deadlineExceeded" || <-committed {
		t.Fatalf("a mutation past its deadline answered %v", reply)
	}
}

func TestServiceCompletesAMutationWithinItsDeadline(t *testing.T) {
	// Arrange
	deadlineMs := 30000

	// Act
	reply := commitWithin(t, deadlineMs)

	// Assert
	if reply["status"] != "ok" || !<-committed {
		t.Fatalf("a timely mutation answered %v", reply)
	}
}
