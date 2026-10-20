package broker

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"unsafe"
)

var isProcessInJob = jobKernel.NewProc("IsProcessInJob")
var getSystemDirectory = jobKernel.NewProc("GetSystemDirectoryW")
var getWindowsDirectory = jobKernel.NewProc("GetWindowsDirectoryW")

const createNoWindow = 0x08000000

// retainedJob keeps the claimed job handle reachable for the life of the broker process.
var retainedJob *ownedJob

type ownedHeader struct {
	OwnedProcessVersion int    `json:"ownedProcessVersion"`
	JobName             string `json:"jobName"`
	PID                 int    `json:"pid"`
	Created             string `json:"created"`
	BrokerPID           int    `json:"brokerPid"`
	BrokerCreated       string `json:"brokerCreated"`
}

type childProcess struct {
	mu     sync.Mutex
	handle uintptr
	exited bool
}

func (child *childProcess) Exited() bool {
	child.mu.Lock()
	defer child.mu.Unlock()
	if child.exited {
		return true
	}
	if child.handle == 0 {
		return false
	}
	state, _, _ := waitForProcess.Call(child.handle, 0)
	return state == 0
}

func (child *childProcess) Wait() (int, error) {
	state, _, _ := waitForProcess.Call(child.handle, 0xffffffff)
	if state != 0 {
		return 125, errOwnership
	}
	child.mu.Lock()
	child.exited = true
	child.mu.Unlock()
	var exitCode uint32
	if err := syscall.GetExitCodeProcess(syscall.Handle(child.handle), &exitCode); err != nil {
		return 125, err
	}
	return int(exitCode), nil
}

func (child *childProcess) Close() error {
	child.mu.Lock()
	defer child.mu.Unlock()
	if child.handle == 0 {
		return nil
	}
	ok, _, _ := closeJobHandle.Call(child.handle)
	if ok == 0 {
		return errOwnership
	}
	child.handle = 0
	return nil
}

func environmentPairs(values map[string]string) []string {
	pairs := make([]string, 0, len(values))
	for name, value := range values {
		pairs = append(pairs, name+"="+value)
	}
	sort.Strings(pairs)
	return pairs
}

// executablePath resolves a command like CreateProcess does for the PowerShell broker's Process.Start: a name without an
// extension gets only ".exe", never another PATHEXT extension such as ".cmd", and a bare name is searched in the system
// directories before PATH. Unlike CreateProcess it skips the application, current and 16-bit system directories.
func executablePath(command string) (string, error) {
	name := command
	if filepath.Ext(name) == "" {
		name += ".exe"
	}
	if filepath.IsAbs(name) || filepath.Base(name) != name {
		return launchableFile(name)
	}
	for _, directory := range append(systemDirectories(), filepath.SplitList(os.Getenv("PATH"))...) {
		if directory == "" || !filepath.IsAbs(directory) {
			continue
		}
		if path, err := launchableFile(filepath.Join(directory, name)); err == nil {
			return path, nil
		}
	}
	return "", exec.ErrNotFound
}

// launchableFile refuses only a directory, as exec.LookPath does: app execution aliases are reparse points that os.Stat
// reports as irregular files, and CreateProcess launches them.
func launchableFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", exec.ErrNotFound
	}
	return path, nil
}

func systemDirectories() []string {
	var directories []string
	for _, proc := range []*syscall.LazyProc{getSystemDirectory, getWindowsDirectory} {
		buffer := make([]uint16, syscall.MAX_PATH)
		length, _, _ := proc.Call(uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if length > 0 && int(length) < len(buffer) {
			directories = append(directories, syscall.UTF16ToString(buffer[:length]))
		}
	}
	return directories
}

// childAttributes gives the child its own hidden console, as the PowerShell broker's CreateNoWindow does, so a console
// control event inside the child's tree cannot reach the broker and end the whole owned job.
func childAttributes() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

func inspectChild(handle uintptr, job uintptr) (string, error) {
	if handle == 0 {
		return "", errOwnership
	}
	created, err := processCreation(handle)
	if err != nil {
		return "", err
	}
	var member uint32
	ok, _, _ := isProcessInJob.Call(handle, job, uintptr(unsafe.Pointer(&member)))
	if ok == 0 || member != 1 {
		return "", errOwnership
	}
	return created, nil
}

func readControl(input io.Reader) (control, *bufio.Reader, error) {
	reader := bufio.NewReaderSize(input, 65536)
	frame, err := readControlFrame(reader)
	if err != nil {
		return control{}, nil, err
	}
	value, err := parseControl(frame)
	if err != nil {
		return control{}, nil, err
	}
	return value, reader, nil
}

func run(input io.Reader, output, errorOutput io.Writer) (code int, err error) {
	spec, reader, err := readControl(input)
	if err != nil {
		return 125, err
	}
	parent, err := admitParent(spec.parentPID, spec.parentCreated)
	if err != nil {
		return 125, err
	}
	defer func() {
		if closeError := parent.Close(); closeError != nil && err == nil {
			err = closeError
			code = 125
		}
	}()
	job, err := claimCurrentJob(spec.jobName)
	if err != nil {
		return 125, err
	}
	// The broker belongs to its own kill-on-close job, so closing the last job handle would end the broker with exit
	// code 0 before it reports the child's code. Process exit closes the handle and the job with it.
	retainedJob = job
	path, err := executablePath(spec.command)
	if err != nil {
		return 125, err
	}
	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		return 125, err
	}
	defer stdinRead.Close()
	defer stdinWrite.Close()
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		return 125, err
	}
	defer stdoutRead.Close()
	defer stdoutWrite.Close()
	stderrRead, stderrWrite, err := os.Pipe()
	if err != nil {
		return 125, err
	}
	defer stderrRead.Close()
	defer stderrWrite.Close()
	if !parent.Alive() {
		return 125, errOwnership
	}
	arguments := append([]string{spec.command}, spec.args...)
	pid, handle, err := syscall.StartProcess(path, arguments, &syscall.ProcAttr{
		Dir: spec.cwd, Env: environmentPairs(spec.childEnvironment),
		Files: []uintptr{stdinRead.Fd(), stdoutWrite.Fd(), stderrWrite.Fd()},
		Sys:   childAttributes(),
	})
	if err != nil {
		return 125, err
	}
	child := &childProcess{handle: handle}
	defer func() {
		if closeError := child.Close(); closeError != nil && err == nil {
			err = closeError
			code = 125
		}
	}()
	if closeError := stdinRead.Close(); closeError != nil {
		return 125, closeError
	}
	if closeError := stdoutWrite.Close(); closeError != nil {
		return 125, closeError
	}
	if closeError := stderrWrite.Close(); closeError != nil {
		return 125, closeError
	}
	created, err := inspectChild(handle, job.handle)
	if err != nil || !parent.Alive() {
		return 125, errOwnership
	}
	brokerHandle, _, _ := currentProcess.Call()
	if brokerHandle == 0 {
		return 125, errOwnership
	}
	brokerCreated, err := processCreation(brokerHandle)
	if err != nil {
		return 125, err
	}
	header, err := json.Marshal(ownedHeader{1, spec.jobName, pid, created, os.Getpid(), brokerCreated})
	if err != nil {
		return 125, err
	}
	header = append(header, byte(10))
	if written, writeError := output.Write(header); writeError != nil || written != len(header) {
		if writeError == nil {
			writeError = io.ErrShortWrite
		}
		return 125, writeError
	}
	go func() {
		_, copyError := io.Copy(stdinWrite, reader)
		closeError := stdinWrite.Close()
		if (copyError != nil || closeError != nil) && !child.Exited() {
			os.Exit(125)
		}
	}()
	outputDone := make(chan struct{}, 2)
	for _, stream := range []struct {
		source *os.File
		target io.Writer
	}{{stdoutRead, output}, {stderrRead, errorOutput}} {
		go func(source *os.File, target io.Writer) {
			if _, copyError := io.Copy(target, source); copyError != nil {
				os.Exit(125)
			}
			outputDone <- struct{}{}
		}(stream.source, stream.target)
	}
	exitCode, err := child.Wait()
	if err != nil {
		return 125, err
	}
	<-outputDone
	<-outputDone
	if exitCode < 0 {
		return 125, errOwnership
	}
	return exitCode, nil
}

func Run(input io.Reader, output, errorOutput io.Writer) (int, error) {
	return run(input, output, errorOutput)
}
