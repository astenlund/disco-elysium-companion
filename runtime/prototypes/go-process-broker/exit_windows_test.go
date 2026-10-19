package broker

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"testing"
)

const (
	testRoleVariable = "COMPANION_BROKER_TEST_ROLE"
	testExitVariable = "COMPANION_BROKER_TEST_EXIT"
)

// TestMain lets the test binary stand in for both the broker command and the brokered child.
func TestMain(m *testing.M) {
	switch os.Getenv(testRoleVariable) {
	case "broker":
		code, err := Run(os.Stdin, os.Stdout, os.Stderr)
		if err != nil {
			os.Exit(125)
		}
		os.Exit(code)
	case "child":
		code, err := strconv.Atoi(os.Getenv(testExitVariable))
		if err != nil {
			os.Exit(126)
		}
		os.Exit(code)
	}
	os.Exit(m.Run())
}

func TestBrokerExitsWithTheChildExitCode(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	directory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	process, _, _ := currentProcess.Call()
	created, err := processCreation(process)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []int{0, 1, 7} {
		token := make([]byte, 16)
		if _, err := rand.Read(token); err != nil {
			t.Fatal(err)
		}
		frame, err := json.Marshal(map[string]any{
			"command":               executable,
			"args":                  []string{},
			"cwd":                   directory,
			"jobName":               "Global" + string(rune(92)) + "game-companion-process-" + hex.EncodeToString(token) + "-core",
			"parentPid":             os.Getpid(),
			"parentCreated":         created,
			"brokerProtocolVersion": 2,
			"childEnvironment":      map[string]string{testRoleVariable: "child", testExitVariable: strconv.Itoa(expected)},
		})
		if err != nil {
			t.Fatal(err)
		}
		broker := exec.Command(executable)
		broker.Env = append(os.Environ(), testRoleVariable+"=broker")
		broker.Stdin = bytes.NewReader(append(frame, byte(10)))
		var output bytes.Buffer
		broker.Stdout = &output
		err = broker.Run()
		var exit *exec.ExitError
		if err != nil && !errors.As(err, &exit) {
			t.Fatal(err)
		}
		if code := broker.ProcessState.ExitCode(); code != expected {
			t.Fatalf("child exit %d reported as broker exit %d", expected, code)
		}
		if !bytes.HasPrefix(output.Bytes(), []byte(`{"ownedProcessVersion":1,`)) {
			t.Fatalf("broker did not report the owned header for child exit %d", expected)
		}
	}
}
