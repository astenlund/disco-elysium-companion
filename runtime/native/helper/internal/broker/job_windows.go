package broker

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	killOnJobClose      = 0x2000
	extendedLimitsClass = 9
	parentAccess        = 0x00100000 | 0x1000
	waitTimeout         = 0x102
	parentPollMs        = 100
)

var errOwnership = errors.New("native process ownership unavailable")

var jobKernel = syscall.NewLazyDLL("kernel32.dll")
var createJobObject = jobKernel.NewProc("CreateJobObjectW")
var setJobInformation = jobKernel.NewProc("SetInformationJobObject")
var assignProcessToJob = jobKernel.NewProc("AssignProcessToJobObject")
var closeJobHandle = jobKernel.NewProc("CloseHandle")
var currentProcess = jobKernel.NewProc("GetCurrentProcess")
var openParentProcess = jobKernel.NewProc("OpenProcess")
var queryProcessTimes = jobKernel.NewProc("GetProcessTimes")
var waitForProcess = jobKernel.NewProc("WaitForSingleObject")

type basicJobLimits struct {
	processTime       int64
	jobTime           int64
	flags             uint32
	minimumWorkingSet uintptr
	maximumWorkingSet uintptr
	activeLimit       uint32
	affinity          uintptr
	priority          uint32
	scheduling        uint32
}

type jobIOCounters struct {
	readOperations  uint64
	writeOperations uint64
	otherOperations uint64
	readBytes       uint64
	writeBytes      uint64
	otherBytes      uint64
}

type extendedJobLimits struct {
	basic             basicJobLimits
	io                jobIOCounters
	processMemory     uintptr
	jobMemory         uintptr
	peakProcessMemory uintptr
	peakJobMemory     uintptr
}

type ownedJob struct {
	handle uintptr
}

type parentGuard struct {
	mu       sync.Mutex
	stopOnce sync.Once
	handle   uintptr
	stop     chan struct{}
	done     chan struct{}
}

var processRoles = map[string]bool{
	"core": true, "provider": true, "watcher": true, "metadata": true, "startupCoreReply": true,
}

func validJobName(name string) bool {
	prefix := "Global" + string(rune(92)) + "game-companion-process-"
	if !strings.HasPrefix(name, prefix) {
		return false
	}
	tail := strings.TrimPrefix(name, prefix)
	if len(tail) < 34 || tail[32] != '-' || !processRoles[tail[33:]] {
		return false
	}
	for index := range 32 {
		digit := tail[index]
		if digit < '0' || digit > '9' && (digit < 'a' || digit > 'f') {
			return false
		}
	}
	return true
}

func claimCurrentJob(name string) (*ownedJob, error) {
	if !validJobName(name) {
		return nil, errOwnership
	}
	wide, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return nil, errOwnership
	}
	handle, _, createError := createJobObject.Call(0, uintptr(unsafe.Pointer(wide)))
	if handle == 0 {
		return nil, errOwnership
	}
	claimed := false
	defer func() {
		if !claimed {
			closeJobHandle.Call(handle)
		}
	}()
	if createError == syscall.Errno(183) {
		return nil, errOwnership
	}
	limits := extendedJobLimits{basic: basicJobLimits{flags: killOnJobClose}}
	ok, _, _ := setJobInformation.Call(handle, extendedLimitsClass, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		return nil, errOwnership
	}
	process, _, _ := currentProcess.Call()
	if process == 0 {
		return nil, errOwnership
	}
	ok, _, _ = assignProcessToJob.Call(handle, process)
	if ok == 0 {
		return nil, errOwnership
	}
	claimed = true
	return &ownedJob{handle: handle}, nil
}

func processCreation(handle uintptr) (string, error) {
	var created, exited, kernelTime, userTime syscall.Filetime
	ok, _, _ := queryProcessTimes.Call(handle, uintptr(unsafe.Pointer(&created)), uintptr(unsafe.Pointer(&exited)),
		uintptr(unsafe.Pointer(&kernelTime)), uintptr(unsafe.Pointer(&userTime)))
	if ok == 0 {
		return "", errOwnership
	}
	value := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	if value == 0 {
		return "", errOwnership
	}
	return strconv.FormatUint(value, 10), nil
}

func admitParent(pid int32, expectedCreated string) (*parentGuard, error) {
	if pid < 1 || pid == int32(os.Getpid()) || expectedCreated == "" {
		return nil, errOwnership
	}
	handle, _, _ := openParentProcess.Call(parentAccess, 0, uintptr(pid))
	if handle == 0 {
		return nil, errOwnership
	}
	created, err := processCreation(handle)
	if err == nil && created == expectedCreated {
		state, _, _ := waitForProcess.Call(handle, 0)
		if state == waitTimeout {
			guard := &parentGuard{handle: handle, stop: make(chan struct{}), done: make(chan struct{})}
			go guard.monitor()
			return guard, nil
		}
	}
	closeJobHandle.Call(handle)
	return nil, errOwnership
}

func (parent *parentGuard) monitor() {
	defer close(parent.done)
	for {
		select {
		case <-parent.stop:
			return
		default:
		}
		state, _, _ := waitForProcess.Call(parent.handle, parentPollMs)
		if state == waitTimeout {
			continue
		}
		select {
		case <-parent.stop:
			return
		default:
			os.Exit(125)
		}
	}
}

func (parent *parentGuard) Alive() bool {
	if parent == nil {
		return false
	}
	parent.mu.Lock()
	defer parent.mu.Unlock()
	if parent.handle == 0 {
		return false
	}
	state, _, _ := waitForProcess.Call(parent.handle, 0)
	return state == waitTimeout
}

func (parent *parentGuard) Close() error {
	if parent == nil {
		return errOwnership
	}
	parent.stopOnce.Do(func() { close(parent.stop) })
	<-parent.done
	parent.mu.Lock()
	defer parent.mu.Unlock()
	if parent.handle == 0 {
		return nil
	}
	ok, _, _ := closeJobHandle.Call(parent.handle)
	if ok == 0 {
		return errOwnership
	}
	parent.handle = 0
	return nil
}
