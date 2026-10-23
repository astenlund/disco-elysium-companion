package service

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
	"unsafe"

	j "companion-helper/internal/jsondoc"
	"companion-helper/internal/nativefs"
	"companion-helper/internal/winproc"
)

// Exit codes: 0 after a clean end of input, 125 for any protocol, identity or parent failure.
const (
	exitClean    = 0
	exitProtocol = 125
	// MaximumSequence is the largest request sequence; the runtime renews the service before exceeding it.
	MaximumSequence = 9007199254740991
	// MaximumInFlight bounds the requests the runtime may have outstanding; a further request is a protocol failure.
	MaximumInFlight = 16
)

// frameBudget admits request frames, which can carry a base64 copy of a one-megabyte document.
var frameBudget = j.Budget{Bytes: MaximumFrame, Tokens: 262144, TextBytes: MaximumFrame}

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procCreateFileW      = kernel32.NewProc("CreateFileW")
	procGetInformation   = kernel32.NewProc("GetFileInformationByHandle")
	procOpenProcess      = kernel32.NewProc("OpenProcess")
	procWaitForSingle    = kernel32.NewProc("WaitForSingleObject")
	procGetProcessTimes  = kernel32.NewProc("GetProcessTimes")
	procGetCurrentProces = kernel32.NewProc("GetCurrentProcess")
)

// heldImage keeps the service's own executable open, denying writes, replacement and deletion while the service runs.
var heldImage syscall.Handle

// state is the only mutable state requests share: the scope binding.
type state struct {
	mutex         sync.RWMutex
	bound         bool
	companionRoot string
	dataRoot      string
}

// call is one request's context: the shared state and the request's own deadline.
type call struct {
	state    *state
	deadline time.Time
}

func (c *call) expired() bool { return !time.Now().Before(c.deadline) }

// gate refuses a commit once the request's deadline has passed.
func (c *call) gate() nativefs.Gate { return nativefs.Until(c.deadline) }

// writer serializes reply frames from concurrent requests so each frame is written whole. Once Run has returned, the
// writer is stopped and a reply that finishes later is dropped, since the service is ending.
type writer struct {
	mutex   sync.Mutex
	output  io.Writer
	stopped bool
}

func (w *writer) write(body []byte) error {
	w.mutex.Lock()
	defer w.mutex.Unlock()
	if w.stopped {
		return nil
	}
	return WriteFrame(w.output, body)
}

func (w *writer) stop() {
	w.mutex.Lock()
	defer w.mutex.Unlock()
	w.stopped = true
}

// Run serves requests until its input ends. nonce is the runtime's fresh handshake challenge. Each request runs on its
// own goroutine, so a slow or hung request never delays another; replies carry their request's seq.
func Run(nonce string, input io.Reader, output io.Writer) int {
	if !j.IsHex(nonce, 32) {
		return exitProtocol
	}
	hello, err := handshake(nonce)
	if err != nil {
		return exitProtocol
	}
	if err := watchParent(); err != nil {
		return exitProtocol
	}
	replies := &writer{output: output}
	defer replies.stop()
	if replies.write(hello) != nil {
		return exitProtocol
	}
	current := &state{}
	slots := make(chan struct{}, MaximumInFlight)
	var running sync.WaitGroup
	var expected int64 = 1
	for {
		frame, err := ReadFrame(input)
		if err == io.EOF {
			running.Wait()
			return exitClean
		}
		if err != nil {
			return exitProtocol
		}
		request, err := j.Parse(frame, frameBudget)
		if err != nil || request.Kind != j.Object {
			return exitProtocol
		}
		version, versionErr := j.AnyInteger(request.Get("version"))
		seq, seqErr := j.Integer(request.Get("seq"), 1, MaximumSequence)
		op, opErr := j.Text(request.Get("op"))
		deadlineMs, deadlineErr := j.Integer(request.Get("deadlineMs"), 1, 3600000)
		if versionErr != nil || version != 1 || seqErr != nil || seq != expected || opErr != nil || deadlineErr != nil {
			return exitProtocol
		}
		handler, known := handlers[op]
		if !known {
			return exitProtocol
		}
		fields := append([]string{"version", "seq", "op", "deadlineMs"}, handler.fields...)
		if j.Fields(request, fields...) != nil {
			return exitProtocol
		}
		select {
		case slots <- struct{}{}:
		default:
			return exitProtocol
		}
		expected++
		work := &call{state: current, deadline: time.Now().Add(time.Duration(deadlineMs) * time.Millisecond)}
		running.Add(1)
		go func() {
			defer running.Done()
			reply := serve(work, handler, request, seq, op)
			<-slots
			if replies.write(reply) != nil {
				os.Exit(exitProtocol)
			}
		}()
	}
}

// serve runs one request and builds its reply. A request that runs out of time before its commit point replies
// deadlineExceeded; a mutating request already past its commit point completes and replies normally.
func serve(work *call, handler handler, request *j.Value, seq int64, op string) []byte {
	reply := j.NewObject().Int("version", 1).Int("seq", seq).String("op", op)
	var result []byte
	code := ""
	changes := mutating(handler, op, request)
	switch {
	case changes && !work.state.isBound():
		code = "scopeUnbound"
	case work.expired():
		code = "deadlineExceeded"
	default:
		result, code = handler.run(work, request)
		if code == "" && !changes && work.expired() {
			code = "deadlineExceeded"
		}
	}
	if code != "" {
		return reply.String("status", "error").String("code", code).Bytes()
	}
	return reply.String("status", "ok").Raw("result", result).Bytes()
}

// mutating reports whether a request may change files: a mutating operation, or the Quarantine trim mode of inventory.
// Such a request needs a bound scope and, once past its commit point, completes and replies normally after its deadline.
func mutating(handler handler, op string, request *j.Value) bool {
	if handler.mutating {
		return true
	}
	mode, err := j.Text(request.Get("mode"))

	return op == "inventory" && err == nil && mode == "Quarantine"
}

// handshake opens the running executable with read sharing only, hashes that held handle and describes its identity.
func handshake(nonce string) ([]byte, error) {
	image, err := os.Executable()
	if err != nil {
		return nil, err
	}
	name, err := syscall.UTF16PtrFromString(image)
	if err != nil {
		return nil, err
	}
	const genericRead, shareRead, openExisting, normal = 0x80000000, 1, 3, 0x80
	raw, _, callError := procCreateFileW.Call(uintptr(unsafe.Pointer(name)), genericRead, shareRead, 0, openExisting, normal, 0)
	if syscall.Handle(raw) == syscall.InvalidHandle {
		return nil, callError
	}
	heldImage = syscall.Handle(raw)
	digest := sha256.New()
	buffer := make([]byte, 1<<16)
	for {
		var count uint32
		if err := syscall.ReadFile(heldImage, buffer, &count, nil); err != nil {
			return nil, err
		}
		if count == 0 {
			break
		}
		digest.Write(buffer[:count])
	}
	var information struct {
		Attributes                 uint32
		Created, Accessed, Written syscall.Filetime
		Volume, SizeHigh, SizeLow  uint32
		Links, IndexHigh, IndexLow uint32
	}
	if ok, _, callError := procGetInformation.Call(uintptr(heldImage), uintptr(unsafe.Pointer(&information))); ok == 0 {
		return nil, callError
	}
	identity, err := winproc.ReadIdentity(os.Getpid())
	if err != nil || identity == nil {
		return nil, errors.New("service identity unavailable")
	}
	index := uint64(information.IndexHigh)<<32 | uint64(information.IndexLow)
	return j.NewObject().Int("version", 1).String("nonce", nonce).Int("pid", int64(identity.PID)).String("created", identity.Created).
		String("imageSha256", hex.EncodeToString(digest.Sum(nil))).String("imageVolume", strconv.FormatUint(uint64(information.Volume), 10)).
		String("imageFileId", strconv.FormatUint(index, 10)).Bytes(), nil
}

// watchParent exits the service when the process that started it ends. A parent created after this process is a
// reused identifier and counts as ended.
func watchParent() error {
	parent := os.Getppid()
	const synchronize, queryLimited = 0x00100000, 0x1000
	handle, _, _ := procOpenProcess.Call(synchronize|queryLimited, 0, uintptr(parent))
	if handle == 0 {
		return errors.New("parent unavailable")
	}
	parentCreated, err := processCreated(handle)
	if err != nil {
		return err
	}
	self, _, _ := procGetCurrentProces.Call()
	ownCreated, err := processCreated(self)
	if err != nil || parentCreated > ownCreated {
		return errors.New("parent identity reused")
	}
	go func() {
		procWaitForSingle.Call(handle, 0xffffffff)
		os.Exit(exitProtocol)
	}()
	return nil
}

func processCreated(handle uintptr) (uint64, error) {
	var created, exited, kernelTime, userTime syscall.Filetime
	if ok, _, _ := procGetProcessTimes.Call(handle, uintptr(unsafe.Pointer(&created)), uintptr(unsafe.Pointer(&exited)),
		uintptr(unsafe.Pointer(&kernelTime)), uintptr(unsafe.Pointer(&userTime))); ok == 0 {
		return 0, errors.New("process times unavailable")
	}
	return uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime), nil
}

func (s *state) isBound() bool {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	return s.bound
}

// withinBound reports whether the service is bound and path lies inside the bound data root.
func (s *state) withinBound(path string) bool {
	s.mutex.RLock()
	bound, root := s.bound, s.dataRoot
	s.mutex.RUnlock()
	if !bound {
		return false
	}
	normalized, err := nativefs.NormalizePath(path)
	if err != nil {
		return false
	}
	if nativefs.EqualOrdinalIgnoreCase(normalized, root) {
		return true
	}
	prefix := root
	if prefix[len(prefix)-1] != filepath.Separator {
		prefix += string(filepath.Separator)
	}
	return len(normalized) > len(prefix) && nativefs.EqualOrdinalIgnoreCase(normalized[:len(prefix)], prefix)
}
