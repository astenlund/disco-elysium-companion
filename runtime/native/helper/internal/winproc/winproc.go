// Package winproc holds the helper's Windows process and job operations: process identity, job observation and
// membership, owned-process liveness, orphaned watcher termination, the current principal and scope job binding.
package winproc

import (
	"errors"
	"regexp"
	"strconv"
	"syscall"
	"time"
	"unsafe"
)

// ErrUnavailable marks an observation or action that could not be completed.
var ErrUnavailable = errors.New("native process operation unavailable")

const (
	jobQuery              = 0x0004
	jobTerminate          = 0x0008
	jobAssign             = 0x0001
	processQueryLimited   = 0x1000
	processSynchronize    = 0x00100000
	accountingClass       = 1
	processListClass      = 3
	extendedLimitsClass   = 9
	killOnJobClose        = 0x2000
	waitTimeout           = 0x102
	stillActive           = 259
	errorAlreadyExists    = 183
	errorInvalidParameter = 87
)

var (
	kernel32              = syscall.NewLazyDLL("kernel32.dll")
	procOpenJobObjectW    = kernel32.NewProc("OpenJobObjectW")
	procCreateJobObjectW  = kernel32.NewProc("CreateJobObjectW")
	procQueryJob          = kernel32.NewProc("QueryInformationJobObject")
	procSetJob            = kernel32.NewProc("SetInformationJobObject")
	procAssignProcess     = kernel32.NewProc("AssignProcessToJobObject")
	procTerminateJob      = kernel32.NewProc("TerminateJobObject")
	procIsProcessInJob    = kernel32.NewProc("IsProcessInJob")
	procOpenProcess       = kernel32.NewProc("OpenProcess")
	procGetProcessTimes   = kernel32.NewProc("GetProcessTimes")
	procGetExitCode       = kernel32.NewProc("GetExitCodeProcess")
	procWaitForSingle     = kernel32.NewProc("WaitForSingleObject")
	procGetCurrentProcess = kernel32.NewProc("GetCurrentProcess")
	jobName               = regexp.MustCompile(`^Global\\game-companion-process-[a-f0-9]{32}-(core|publication|provider|watcher|metadata|startupMetadata|startupCoreReply|startupMutation|helper)$`)
	watcherJob            = regexp.MustCompile(`^Global\\game-companion-process-[a-f0-9]{32}-watcher$`)
	creationToken         = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
)

type accounting struct {
	UserTime, KernelTime, PeriodUserTime, PeriodKernelTime           int64
	PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses uint32
}

type basicLimits struct {
	processTime, jobTime int64
	flags                uint32
	minimumWorkingSet    uintptr
	maximumWorkingSet    uintptr
	activeLimit          uint32
	affinity             uintptr
	priority             uint32
	scheduling           uint32
}

type extendedLimits struct {
	basic                                          basicLimits
	io                                             [6]uint64
	processMemory, jobMemory, peakProcess, peakJob uintptr
}

// ValidJobName reports a runtime role job name, current or retired.
func ValidJobName(name string) bool { return jobName.MatchString(name) }

// ValidCreationToken reports the decimal FILETIME grammar of a process creation identity.
func ValidCreationToken(token string) bool {
	if !creationToken.MatchString(token) {
		return false
	}
	_, err := strconv.ParseInt(token, 10, 64)
	return err == nil
}

func openJob(name string, access uint32) (syscall.Handle, bool, error) {
	wide, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, false, ErrUnavailable
	}
	handle, _, callError := procOpenJobObjectW.Call(uintptr(access), 0, uintptr(unsafe.Pointer(wide)))
	if handle == 0 {
		if callError == syscall.ERROR_FILE_NOT_FOUND {
			return 0, false, nil
		}
		return 0, false, ErrUnavailable
	}
	return syscall.Handle(handle), true, nil
}

func activeProcesses(job syscall.Handle) (uint32, error) {
	var detail accounting
	var returned uint32
	ok, _, _ := procQueryJob.Call(uintptr(job), accountingClass, uintptr(unsafe.Pointer(&detail)), unsafe.Sizeof(detail), uintptr(unsafe.Pointer(&returned)))
	if ok == 0 || returned != uint32(unsafe.Sizeof(detail)) {
		return 0, ErrUnavailable
	}
	return detail.ActiveProcesses, nil
}

// ObserveJob returns the active process count of a named job, or nil when the job is absent.
func ObserveJob(name string) (*uint32, error) {
	if !ValidJobName(name) {
		return nil, ErrUnavailable
	}
	job, found, err := openJob(name, jobQuery)
	if err != nil || !found {
		return nil, err
	}
	defer syscall.CloseHandle(job)
	count, err := activeProcesses(job)
	if err != nil {
		return nil, err
	}
	return &count, nil
}

// Members lists the process identifiers of a named job; an absent job has none.
func Members(name string) ([]int, error) {
	if !ValidJobName(name) {
		return nil, ErrUnavailable
	}
	job, found, err := openJob(name, jobQuery)
	if err != nil {
		return nil, err
	}
	if !found {
		return []int{}, nil
	}
	defer syscall.CloseHandle(job)
	const maximum = 64
	width := int(unsafe.Sizeof(uintptr(0)))
	buffer := make([]byte, 8+maximum*width)
	var returned uint32
	if ok, _, _ := procQueryJob.Call(uintptr(job), processListClass, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), uintptr(unsafe.Pointer(&returned))); ok == 0 {
		return nil, ErrUnavailable
	}
	assigned := int32(*(*uint32)(unsafe.Pointer(&buffer[0])))
	count := int32(*(*uint32)(unsafe.Pointer(&buffer[4])))
	if assigned != count || count < 0 || count > maximum || int(returned) < 8+int(count)*width || int(returned) > len(buffer) {
		return nil, ErrUnavailable
	}
	members := make([]int, count)
	for index := range members {
		value := *(*uintptr)(unsafe.Pointer(&buffer[8+index*width]))
		if value < 1 || value > 2147483647 {
			return nil, ErrUnavailable
		}
		members[index] = int(value)
	}
	return members, nil
}

// Identity is a process identifier with its creation time as a decimal FILETIME.
type Identity struct {
	PID     int
	Created string
}

// pin opens a running process. A nil handle with no error means the process positively does not run.
func pin(pid int) (syscall.Handle, string, error) {
	if pid < 1 || pid > 2147483647 {
		return 0, "", ErrUnavailable
	}
	handle, _, callError := procOpenProcess.Call(processQueryLimited|processSynchronize, 0, uintptr(pid))
	if handle == 0 {
		if callError == syscall.Errno(errorInvalidParameter) {
			return 0, "", nil
		}
		return 0, "", ErrUnavailable
	}
	var code uint32
	if ok, _, _ := procGetExitCode.Call(handle, uintptr(unsafe.Pointer(&code))); ok == 0 {
		syscall.CloseHandle(syscall.Handle(handle))
		return 0, "", ErrUnavailable
	}
	if code != stillActive {
		// An exited process whose object survives through another handle is not running.
		syscall.CloseHandle(syscall.Handle(handle))
		return 0, "", nil
	}
	created, err := creation(syscall.Handle(handle))
	if err != nil {
		syscall.CloseHandle(syscall.Handle(handle))
		return 0, "", err
	}
	return syscall.Handle(handle), created, nil
}

func creation(handle syscall.Handle) (string, error) {
	var created, exited, kernelTime, userTime syscall.Filetime
	if ok, _, _ := procGetProcessTimes.Call(uintptr(handle), uintptr(unsafe.Pointer(&created)), uintptr(unsafe.Pointer(&exited)),
		uintptr(unsafe.Pointer(&kernelTime)), uintptr(unsafe.Pointer(&userTime))); ok == 0 {
		return "", ErrUnavailable
	}
	value := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	if value == 0 {
		return "", ErrUnavailable
	}
	return strconv.FormatUint(value, 10), nil
}

// ReadIdentity returns a running process's identity, or nil when it does not run.
func ReadIdentity(pid int) (*Identity, error) {
	handle, created, err := pin(pid)
	if err != nil || handle == 0 {
		return nil, err
	}
	syscall.CloseHandle(handle)
	return &Identity{PID: pid, Created: created}, nil
}

// OwnedProcessLive reports whether the identified process runs inside the named job.
func OwnedProcessLive(name string, pid int, created string) (bool, error) {
	if name == "" || !ValidCreationToken(created) {
		return false, ErrUnavailable
	}
	members, err := Members(name)
	if err != nil {
		return false, err
	}
	identity, err := ReadIdentity(pid)
	if err != nil {
		return false, err
	}
	if identity == nil || identity.Created != created {
		return false, nil
	}
	for _, member := range members {
		if member == pid {
			return true, nil
		}
	}
	return false, nil
}

// SoleMember reports whether the named job holds exactly one process and that process is the identified one, read twice
// so a membership that changes during the observation does not pass.
func SoleMember(name string, pid int, created string) (bool, error) {
	if !ValidCreationToken(created) {
		return false, ErrUnavailable
	}
	first, err := Members(name)
	if err != nil {
		return false, err
	}
	identity, err := ReadIdentity(pid)
	if err != nil {
		return false, err
	}
	second, err := Members(name)
	if err != nil {
		return false, err
	}
	count, err := ObserveJob(name)
	if err != nil {
		return false, err
	}
	return len(first) == 1 && first[0] == pid && len(second) == 1 && second[0] == pid && count != nil && *count == 1 &&
		identity != nil && identity.Created == created, nil
}

// StopOrphanWatcher ends a recorded watcher's job when the recorded process still runs inside it. It returns absent,
// reused or terminated. gate is consulted immediately before termination, the stop's commit point.
func StopOrphanWatcher(pid int, created, name string, gate func() error) (string, error) {
	if pid < 1 || !ValidCreationToken(created) || !watcherJob.MatchString(name) {
		return "", ErrUnavailable
	}
	handle, actual, err := pin(pid)
	if err != nil {
		return "", err
	}
	if handle == 0 {
		return "absent", nil
	}
	defer syscall.CloseHandle(handle)
	if actual != created {
		return "reused", nil
	}
	job, found, err := openJob(name, jobQuery|jobTerminate)
	if err != nil {
		return "", err
	}
	if !found {
		if exited, _ := processExited(handle); exited {
			return "absent", nil
		}
		return "", ErrUnavailable
	}
	defer syscall.CloseHandle(job)
	var member int32
	if ok, _, _ := procIsProcessInJob.Call(uintptr(handle), uintptr(job), uintptr(unsafe.Pointer(&member))); ok == 0 {
		return "", ErrUnavailable
	}
	if member == 0 {
		return "", ErrUnavailable
	}
	if err := gate(); err != nil {
		return "", err
	}
	if ok, _, _ := procTerminateJob.Call(uintptr(job), 1); ok == 0 {
		return "", ErrUnavailable
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		count, err := activeProcesses(job)
		if err != nil {
			return "", err
		}
		if count == 0 {
			return "terminated", nil
		}
		if time.Now().After(deadline) {
			return "", ErrUnavailable
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func processExited(handle syscall.Handle) (bool, error) {
	state, _, _ := procWaitForSingle.Call(uintptr(handle), 0)
	switch state {
	case 0:
		return true, nil
	case waitTimeout:
		return false, nil
	}
	return false, ErrUnavailable
}

// CurrentPrincipal returns the current process token's user SID.
func CurrentPrincipal() (string, error) {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return "", ErrUnavailable
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", ErrUnavailable
	}
	sid, err := user.User.Sid.String()
	if err != nil || sid == "" {
		return "", ErrUnavailable
	}
	return sid, nil
}

// boundJob keeps the scope job handle reachable for the life of the service.
var boundJob syscall.Handle

// JoinScopeJob creates the named helper job exclusively and assigns the current process to it. The job closes when the
// service exits; a job that already exists belongs to a predecessor and fails closed.
func JoinScopeJob(name string) error {
	if !ValidJobName(name) || boundJob != 0 {
		return ErrUnavailable
	}
	wide, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return ErrUnavailable
	}
	handle, _, callError := procCreateJobObjectW.Call(0, uintptr(unsafe.Pointer(wide)))
	if handle == 0 {
		return ErrUnavailable
	}
	job := syscall.Handle(handle)
	if callError == syscall.Errno(errorAlreadyExists) {
		syscall.CloseHandle(job)
		return ErrUnavailable
	}
	limits := extendedLimits{basic: basicLimits{flags: killOnJobClose}}
	if ok, _, _ := procSetJob.Call(uintptr(job), extendedLimitsClass, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits)); ok == 0 {
		syscall.CloseHandle(job)
		return ErrUnavailable
	}
	process, _, _ := procGetCurrentProcess.Call()
	if ok, _, _ := procAssignProcess.Call(uintptr(job), process); ok == 0 {
		syscall.CloseHandle(job)
		return ErrUnavailable
	}
	boundJob = job
	return nil
}
