package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

type accounting struct {
	UserTime, KernelTime, PeriodUserTime, PeriodKernelTime           int64
	PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses uint32
}

type processEntry struct {
	Size, Usage, ProcessID      uint32
	DefaultHeapID               uintptr
	ModuleID, Threads, ParentID uint32
	Priority                    int32
	Flags                       uint32
	ExeFile                     [260]uint16
}

type job struct {
	Name      string  `json:"name"`
	State     string  `json:"state"`
	Processes *uint32 `json:"processes"`
}

type request struct {
	Names []string      `json:"names"`
	Owned *ownedRequest `json:"owned,omitempty"`
}

type ownedRequest struct {
	Name          string `json:"name"`
	ProcessID     int    `json:"processId"`
	BrokerID      int    `json:"brokerId"`
	Created       string `json:"created"`
	BrokerCreated string `json:"brokerCreated"`
}

var roles = map[string]bool{"core": true, "publication": true, "provider": true, "watcher": true,
	"metadata": true, "startupMetadata": true, "startupCoreReply": true, "startupMutation": true}
var orderedRoles = []string{"core", "publication", "provider", "watcher", "metadata", "startupMetadata", "startupCoreReply", "startupMutation"}
var kernel = syscall.NewLazyDLL("kernel32.dll")
var openJob = kernel.NewProc("OpenJobObjectW")
var queryJob = kernel.NewProc("QueryInformationJobObject")
var closeHandle = kernel.NewProc("CloseHandle")
var openProcess = kernel.NewProc("OpenProcess")
var processTimes = kernel.NewProc("GetProcessTimes")
var processImage = kernel.NewProc("QueryFullProcessImageNameW")
var systemDirectory = kernel.NewProc("GetSystemDirectoryW")
var snapshot = kernel.NewProc("CreateToolhelp32Snapshot")
var firstProcess = kernel.NewProc("Process32FirstW")
var nextProcess = kernel.NewProc("Process32NextW")

func strictObject(input []byte, fields map[string]bool) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(input))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, syscall.EINVAL
	}
	values := make(map[string]json.RawMessage, len(fields))
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, valid := keyToken.(string)
		if err != nil || !valid || !fields[key] {
			return nil, syscall.EINVAL
		}
		if _, repeated := values[key]; repeated {
			return nil, syscall.EINVAL
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		values[key] = value
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') || len(values) == 0 {
		return nil, syscall.EINVAL
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, syscall.EINVAL
	}
	return values, nil
}

func decodeRequest(input []byte) (request, error) {
	fields, err := strictObject(input, map[string]bool{"names": true, "owned": true})
	if err != nil {
		return request{}, err
	}
	var spec request
	if err := json.Unmarshal(fields["names"], &spec.Names); err != nil || spec.Names == nil {
		return request{}, syscall.EINVAL
	}
	if raw, supplied := fields["owned"]; supplied {
		ownedFields, err := strictObject(raw, map[string]bool{"name": true, "processId": true, "brokerId": true,
			"created": true, "brokerCreated": true})
		if err != nil || len(ownedFields) != 5 {
			return request{}, syscall.EINVAL
		}
		if err := json.Unmarshal(raw, &spec.Owned); err != nil || spec.Owned == nil {
			return request{}, syscall.EINVAL
		}
	}
	return spec, nil
}

func validName(name string) bool {
	prefix := "Global" + string(rune(92)) + "game-companion-process-"
	if !strings.HasPrefix(name, prefix) {
		return false
	}
	tail := strings.TrimPrefix(name, prefix)
	if len(tail) < 34 || tail[32] != '-' || !roles[tail[33:]] {
		return false
	}
	for index := 0; index < 32; index++ {
		value := tail[index]
		if !((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f')) {
			return false
		}
	}
	return true
}

func observe(name string) (job, error) {
	wide, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return job{}, err
	}
	handle, _, callErr := openJob.Call(4, 0, uintptr(unsafe.Pointer(wide)))
	if handle == 0 {
		if callErr == syscall.ERROR_FILE_NOT_FOUND {
			return job{Name: name, State: "absent"}, nil
		}
		return job{}, callErr
	}
	defer closeHandle.Call(handle)
	var detail accounting
	var bytes uint32
	size := uint32(unsafe.Sizeof(detail))
	result, _, callErr := queryJob.Call(handle, 1, uintptr(unsafe.Pointer(&detail)), uintptr(size), uintptr(unsafe.Pointer(&bytes)))
	if result == 0 || bytes != size {
		return job{}, callErr
	}
	count := detail.ActiveProcesses
	return job{Name: name, State: "present", Processes: &count}, nil
}

func members(name string) ([]uint32, error) {
	wide, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	handle, _, callErr := openJob.Call(4, 0, uintptr(unsafe.Pointer(wide)))
	if handle == 0 {
		return nil, callErr
	}
	defer closeHandle.Call(handle)
	const maximum = 64
	buffer := make([]byte, 8+maximum*int(unsafe.Sizeof(uintptr(0))))
	var returned uint32
	result, _, callErr := queryJob.Call(handle, 3, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), uintptr(unsafe.Pointer(&returned)))
	if result == 0 {
		return nil, callErr
	}
	assigned := *(*uint32)(unsafe.Pointer(&buffer[0]))
	listed := *(*uint32)(unsafe.Pointer(&buffer[4]))
	width := int(unsafe.Sizeof(uintptr(0)))
	if assigned != listed || listed > maximum || returned < uint32(8+int(listed)*width) || returned > uint32(len(buffer)) {
		return nil, syscall.EINVAL
	}
	resultIDs := make([]uint32, listed)
	for index := range resultIDs {
		value := *(*uintptr)(unsafe.Pointer(&buffer[8+index*width]))
		if value < 1 || value > 2147483647 {
			return nil, syscall.EINVAL
		}
		resultIDs[index] = uint32(value)
	}
	sort.Slice(resultIDs, func(a, b int) bool { return resultIDs[a] < resultIDs[b] })
	for index := 1; index < len(resultIDs); index++ {
		if resultIDs[index] == resultIDs[index-1] {
			return nil, syscall.EINVAL
		}
	}
	return resultIDs, nil
}

func openIdentity(pid uint32) (uintptr, string, error) {
	handle, _, err := openProcess.Call(0x1000, 0, uintptr(pid))
	if handle == 0 {
		return 0, "", err
	}
	var created, exited, kernelTime, userTime syscall.Filetime
	result, _, err := processTimes.Call(handle, uintptr(unsafe.Pointer(&created)), uintptr(unsafe.Pointer(&exited)), uintptr(unsafe.Pointer(&kernelTime)), uintptr(unsafe.Pointer(&userTime)))
	if result == 0 {
		closeHandle.Call(handle)
		return 0, "", err
	}
	value := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	return handle, strconv.FormatUint(value, 10), nil
}

func conhostParentAndImage(pid uint32) (uintptr, uint32, string, error) {
	handle, _, err := openIdentity(pid)
	if handle == 0 {
		return 0, 0, "", err
	}
	image := make([]uint16, 32768)
	size := uint32(len(image))
	result, _, err := processImage.Call(handle, 0, uintptr(unsafe.Pointer(&image[0])), uintptr(unsafe.Pointer(&size)))
	if result == 0 || size == 0 || size >= uint32(len(image)) {
		closeHandle.Call(handle)
		return 0, 0, "", err
	}
	processList, _, err := snapshot.Call(2, 0)
	if processList == ^uintptr(0) {
		closeHandle.Call(handle)
		return 0, 0, "", err
	}
	defer closeHandle.Call(processList)
	var entry processEntry
	entry.Size = uint32(unsafe.Sizeof(entry))
	found, _, err := firstProcess.Call(processList, uintptr(unsafe.Pointer(&entry)))
	for found != 0 {
		if entry.ProcessID == pid {
			return handle, entry.ParentID, syscall.UTF16ToString(image[:size]), nil
		}
		found, _, err = nextProcess.Call(processList, uintptr(unsafe.Pointer(&entry)))
	}
	closeHandle.Call(handle)
	return 0, 0, "", err
}

func systemConhost() (string, error) {
	buffer := make([]uint16, 32768)
	length, _, err := systemDirectory.Call(uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if length == 0 || length >= uintptr(len(buffer)) {
		return "", err
	}
	return syscall.UTF16ToString(buffer[:length]) + string(rune(92)) + "conhost.exe", nil
}

func sameMembers(left, right []uint32) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func validCreationToken(token string) bool {
	value, err := strconv.ParseUint(token, 10, 64)
	return err == nil && value != 0 && strconv.FormatUint(value, 10) == token
}

func proveOwned(spec *request, jobs []job) (bool, error) {
	owned := spec.Owned
	if owned == nil {
		return false, nil
	}
	if owned.ProcessID < 1 || owned.ProcessID > 2147483647 || owned.BrokerID < 1 || owned.BrokerID > 2147483647 || owned.ProcessID == owned.BrokerID {
		return false, syscall.EINVAL
	}
	for _, token := range []string{owned.Created, owned.BrokerCreated} {
		if !validCreationToken(token) {
			return false, syscall.EINVAL
		}
	}
	index := -1
	for current, name := range spec.Names {
		if name == owned.Name {
			index = current
		}
	}
	if index < 0 || !strings.HasSuffix(owned.Name, "-startupMetadata") {
		return false, syscall.EINVAL
	}
	first, err := members(owned.Name)
	if err != nil {
		return false, err
	}
	if len(first) < 2 || len(first) > 3 {
		return false, nil
	}
	child, broker := uint32(owned.ProcessID), uint32(owned.BrokerID)
	contains := func(id uint32) bool {
		for _, value := range first {
			if value == id {
				return true
			}
		}
		return false
	}
	if !contains(child) || !contains(broker) {
		return false, nil
	}
	childHandle, creation, err := openIdentity(child)
	if err != nil {
		return false, nil
	}
	defer closeHandle.Call(childHandle)
	brokerHandle, brokerCreation, err := openIdentity(broker)
	if err != nil {
		return false, nil
	}
	defer closeHandle.Call(brokerHandle)
	verified := creation == owned.Created && brokerCreation == owned.BrokerCreated
	if len(first) == 3 {
		var console uint32
		for _, value := range first {
			if value != child && value != broker {
				console = value
			}
		}
		consoleHandle, parent, image, err := conhostParentAndImage(console)
		if err != nil {
			return false, nil
		}
		defer closeHandle.Call(consoleHandle)
		expected, err := systemConhost()
		if err != nil {
			return false, err
		}
		verified = verified && parent == child && strings.EqualFold(image, expected)
	}
	if os.Getenv("PRIVATE_JOB_TEST_PAUSE") == "1" {
		if _, err := os.Stderr.WriteString("first-members-observed\n"); err != nil {
			return false, err
		}
		var signal [1]byte
		if _, err := os.Stdin.Read(signal[:]); err != nil {
			return false, err
		}
	}
	second, err := members(owned.Name)
	if err != nil {
		return false, err
	}
	after, err := observe(owned.Name)
	if err != nil {
		return false, err
	}
	return verified && sameMembers(first, second) && after.State == "present" && after.Processes != nil && int(*after.Processes) == len(first) && jobs[index].State == "present", nil
}

func run() error {
	if len(os.Args) != 2 || len(os.Args[1]) > 8192 {
		return syscall.EINVAL
	}
	request, err := decodeRequest([]byte(os.Args[1]))
	if err != nil {
		return err
	}
	if len(request.Names) != 8 {
		return syscall.EINVAL
	}
	seen := make(map[string]bool)
	jobs := make([]job, 0, 8)
	var scopePrefix string
	for index, name := range request.Names {
		if !validName(name) || seen[name] || !strings.HasSuffix(name, "-"+orderedRoles[index]) {
			return syscall.EINVAL
		}
		prefix := name[:len(name)-len(orderedRoles[index])]
		if index == 0 {
			scopePrefix = prefix
		} else if prefix != scopePrefix {
			return syscall.EINVAL
		}
		seen[name] = true
		observed, err := observe(name)
		if err != nil {
			return err
		}
		jobs = append(jobs, observed)
	}
	result := struct {
		Jobs  []job `json:"jobs"`
		Owned *bool `json:"owned,omitempty"`
	}{Jobs: jobs}
	if request.Owned != nil {
		verified, err := proveOwned(&request, jobs)
		if err != nil {
			return err
		}
		result.Owned = &verified
	}
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded) > 65536 {
		return syscall.EINVAL
	}
	_, err = os.Stdout.Write(encoded)
	return err
}

func main() {
	if run() != nil {
		os.Exit(1)
	}
}
