// Package inventory reproduces the runtime's resource inventory: bounded aggregate control metadata over one admitted
// runtime-data scope, the marker-only pass, event expansion admission and quarantine retention.
package inventory

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"companion-helper/internal/events"
	j "companion-helper/internal/jsondoc"
	"companion-helper/internal/nativefs"
)

// ErrUnavailable is the single failure class of every inventory mode.
var ErrUnavailable = errors.New("resource authority unavailable")

const quarantineFileLimit = 256

var (
	eventName      = regexp.MustCompile(`^[0-9]{16}[.]json$`)
	operationName  = regexp.MustCompile(`^(jr|rl|ho)-[0-9a-f]{32}[.]json$`)
	temporaryName  = regexp.MustCompile(`[.][0-9a-f]{32}[.](tmp|bak)$`)
	quarantineName = regexp.MustCompile(`^[A-Za-z0-9.-]+[.][0-9a-f]{32}[.]quarantined$`)
	fixedFiles     = map[string]bool{
		"scope.json": true, "runtime.json": true, "agent-session.json": true, "agent-session-index.json": true, "state-safety.json": true,
		"journal/journal.json": true, "journal/cursor-agent-session.json": true, "journal/recovery-event.json": true, "prepared-context.txt": true, "codec.json": true,
	}
	allowedDirectories = map[string]bool{"journal": true, "journal/events": true, "operations": true, "quarantine": true}
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFree    = kernel32.NewProc("GetDiskFreeSpaceExW")
)

type entry struct{ path, relative string }

// Read returns the Inventory or Marker reply for one scope. It streams the scope's entries, checking gate before each, so
// a request past its deadline stops before reading further, and an incomplete scan is unavailable, never partial capacity.
func Read(root, scopeSha256 string, markerOnly bool, companionRoot string, gate nativefs.Gate) ([]byte, error) {
	if err := verifyScope(root, scopeSha256); err != nil {
		return nil, err
	}
	handoffs := map[string]bool{}
	potential := map[string]bool{}
	journalSources := map[string]bool{}
	uncompacted, invalidEvents, invalidOperations, terminal, unfinished := 0, 0, 0, 0, 0
	residue := false
	scan := func(file entry) error {
		relative := file.relative
		if temporaryName.MatchString(relative) || relative == "codec.json" || relative == "prepared-context.txt" {
			residue = true
			return nil
		}
		if markerOnly || strings.HasPrefix(relative, "quarantine/") {
			return nil
		}
		if strings.HasPrefix(relative, "journal/events/") || relative == "journal/recovery-event.json" {
			eventFile := relative != "journal/recovery-event.json"
			valid, err := inspectEvent(file.path, eventFile)
			if err != nil {
				return ErrUnavailable
			}
			if valid == nil {
				if _, err := nativefs.ObserveRaw(file.path, 30*time.Second); err != nil {
					return ErrUnavailable
				}
				invalidEvents++
				if eventFile {
					uncompacted++
				}
				return nil
			}
			if eventFile {
				if valid.Get("compacted").Kind != j.True {
					uncompacted++
				}
				identity, err := identityOf(valid)
				if err != nil {
					return ErrUnavailable
				}
				potential[identity] = true
				record, _ := j.Hex(valid.Get("recordSha256"), 64)
				sequence, err := j.LogicalSequence(valid.Get("logicalOutboxId"))
				if err != nil {
					return ErrUnavailable
				}
				journalSources[record+":"+strconv.FormatInt(sequence, 10)] = true
			}
			return nil
		}
		if strings.HasPrefix(relative, "operations/") {
			if !operationName.MatchString(filepath.Base(file.path)) {
				return ErrUnavailable
			}
			result, err := inspectOperation(file.path)
			if err != nil {
				return ErrUnavailable
			}
			switch result.state {
			case operationUnfinished:
				unfinished++
			case operationTerminal:
				terminal++
			}
			if result.invalid {
				if _, err := nativefs.ObserveRaw(file.path, 30*time.Second); err != nil {
					return ErrUnavailable
				}
				invalidOperations++
			}
			identities := result.identities
			for _, identity := range identities {
				handoffs[identity] = true
				potential[identity] = true
			}
		}
		return nil
	}
	if err := walk(root, root, "", markerOnly, gate, scan); err != nil {
		return nil, err
	}
	if err := verifyScope(root, scopeSha256); err != nil {
		return nil, err
	}
	free, err := freeBytes(root)
	if err != nil {
		return nil, err
	}
	pending := 0
	if !markerOnly && companionRoot != "" {
		if pending, err = countOutbox(companionRoot, journalSources, gate); err != nil {
			return nil, err
		}
	}
	return j.NewObject().Int("uncompactedEvents", int64(uncompacted)).Int("retainedHandoffs", int64(len(handoffs))).
		String("retainedHandoffIdentitySha256", identitySetHash(handoffs)).Int("potentialHandoffs", int64(len(potential))).
		Int("fullTerminalOperations", int64(terminal)).Int("unfinishedOperations", int64(unfinished)).Int("invalidEvents", int64(invalidEvents)).
		Int("invalidOperations", int64(invalidOperations)).Int("pendingOutbox", int64(pending)).Bool("uncertainWorkspace", residue).
		String("freeBytes", strconv.FormatUint(free, 10)).Bytes(), nil
}

// inspectEvent returns the event description when the file is a valid event in its position, nil when it is invalid
// content, and an error when it cannot be read.
func inspectEvent(path string, eventFile bool) (*j.Value, error) {
	data, err := nativefs.ReadBounded(path, j.StateEvent.Bytes)
	if errors.Is(err, nativefs.ErrTooLarge) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	description, err := events.InspectFrozen(data, false, 0)
	if err != nil {
		if errors.Is(err, j.ErrInvalid) {
			return nil, nil
		}
		return nil, err
	}
	value, err := j.Parse(description, j.StateEvent)
	if err != nil {
		return nil, nil
	}
	if eventFile {
		name := filepath.Base(path)
		if !eventName.MatchString(name) {
			return nil, nil
		}
		sequence, err := strconv.ParseInt(strings.TrimSuffix(name, ".json"), 10, 64)
		position := value.Get("sequence")
		if err != nil || position == nil || position.Kind != j.Number || !j.IsCanonicalInteger(position.Raw) {
			return nil, nil
		}
		actual, err := strconv.ParseInt(string(position.Raw), 10, 64)
		if err != nil || actual != sequence {
			return nil, nil
		}
	}
	return value, nil
}

type operationState int

const (
	operationUncounted operationState = iota
	operationUnfinished
	operationTerminal
)

// operationResult mirrors the C# scan exactly: an operation is counted as unfinished or terminal before its handoffs
// are read, so a later handoff failure also counts it invalid and keeps the identities read before the failure.
type operationResult struct {
	state      operationState
	invalid    bool
	identities []string
}

func inspectOperation(path string) (operationResult, error) {
	invalid := operationResult{invalid: true}
	data, err := nativefs.ReadBounded(path, j.StateEvent.Bytes)
	if errors.Is(err, nativefs.ErrTooLarge) {
		return invalid, nil
	}
	if err != nil {
		return operationResult{}, err
	}
	value, err := j.Parse(data, j.StateEvent)
	if err != nil || value.Kind != j.Object {
		return invalid, nil
	}
	compacted := value.Get("compacted")
	if compacted == nil || compacted.Kind != j.True && compacted.Kind != j.False {
		return invalid, nil
	}
	if compacted.Kind == j.True {
		return operationResult{}, nil
	}
	completed := value.Get("completedAt")
	if completed == nil {
		return invalid, nil
	}
	result := operationResult{state: operationTerminal}
	if completed.Kind == j.Null {
		result.state = operationUnfinished
	}
	kind := value.Get("kind")
	if kind == nil || kind.Kind != j.String && kind.Kind != j.Null {
		result.invalid = true
		return result, nil
	}
	if kind.Kind != j.String || kind.Str != "repair" {
		return result, nil
	}
	plan := value.Get("plan")
	if plan == nil || plan.Kind != j.Object {
		result.invalid = true
		return result, nil
	}
	list := plan.Get("handoffs")
	if list == nil || list.Kind != j.Array {
		result.invalid = true
		return result, nil
	}
	for _, handoff := range list.Items {
		if handoff.Kind != j.Object {
			result.invalid = true
			return result, nil
		}
		identity, err := identityOf(handoff)
		if err != nil {
			result.invalid = true
			return result, nil
		}
		result.identities = append(result.identities, identity)
	}
	return result, nil
}

func identityOf(value *j.Value) (string, error) {
	logical, err := j.Text(value.Get("logicalOutboxId"))
	if err != nil {
		return "", err
	}
	hash, err := j.Hex(value.Get("recordSha256"), 64)
	if err != nil {
		return "", err
	}
	return logical + ":" + hash, nil
}

func identitySetHash(identities map[string]bool) string {
	ordered := make([]string, 0, len(identities))
	for identity := range identities {
		ordered = append(ordered, identity)
	}
	sort.Slice(ordered, func(a, b int) bool { return events.CompareOrdinal(ordered[a], ordered[b]) < 0 })
	return events.Sha256Hex([]byte(strings.Join(ordered, "\n")))
}

func verifyScope(root, expected string) error {
	binding, err := nativefs.AdmitWithin(root, filepath.Join(root, "scope.json"), false)
	if err != nil || binding.IsDirectory {
		return ErrUnavailable
	}
	data, err := nativefs.ReadBounded(binding.Path, j.Config.Bytes)
	if err != nil || events.Sha256Hex(data) != expected {
		return ErrUnavailable
	}
	return nil
}

// walk streams one admitted directory, admitting every entry as it is read and handing each file the mode cares about to
// visit, so no directory is held in memory whole. gate is checked before each entry. A failure of visit, a nested walk or
// gate is returned unchanged; any other enumeration failure is unavailable.
func walk(root, directory, prefix string, markerOnly bool, gate nativefs.Gate, visit func(entry) error) error {
	var stopped error
	err := nativefs.WalkDirectory(directory, func(name string) error {
		stopped = visitEntry(root, directory, prefix, name, markerOnly, gate, visit)
		return stopped
	})
	if stopped != nil {
		return stopped
	}
	if err != nil {
		return ErrUnavailable
	}
	return nil
}

func visitEntry(root, directory, prefix, name string, markerOnly bool, gate nativefs.Gate, visit func(entry) error) error {
	if err := gate(); err != nil {
		return err
	}
	path := filepath.Join(directory, name)
	relative := prefix + name
	admitted, err := nativefs.AdmitWithin(root, path, false)
	if err != nil {
		return ErrUnavailable
	}
	switch {
	case admitted.IsDirectory:
		if markerOnly {
			return nil
		}
		if !allowedDirectories[relative] {
			return ErrUnavailable
		}
		return walk(root, path, relative+"/", false, gate, visit)
	case markerOnly:
		if relative == "runtime.json" || strings.HasPrefix(relative, "runtime.json.") {
			return visit(entry{path, relative})
		}
		return nil
	default:
		if !fixedFiles[relative] && !temporaryName.MatchString(relative) && !strings.HasPrefix(relative, "journal/events/") &&
			!strings.HasPrefix(relative, "operations/") && !strings.HasPrefix(relative, "quarantine/") {
			return ErrUnavailable
		}
		return visit(entry{path, relative})
	}
}

func freeBytes(root string) (uint64, error) {
	volume, err := syscall.UTF16PtrFromString(filepath.VolumeName(root) + `\`)
	if err != nil {
		return 0, ErrUnavailable
	}
	var available, total, free uint64
	if ok, _, _ := procGetDiskFree.Call(uintptr(unsafe.Pointer(volume)), uintptr(unsafe.Pointer(&available)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&free))); ok == 0 {
		return 0, ErrUnavailable
	}
	return available, nil
}

// outboxEntryLimit bounds the outbox entries one inventory inspects, as the C# reference did; the walk stops at the first
// entry past it instead of reading the rest of the directory.
const outboxEntryLimit = 1032

func countOutbox(companionRoot string, journalSources map[string]bool, gate nativefs.Gate) (int, error) {
	directory, err := nativefs.AdmitWithin(companionRoot, filepath.Join(companionRoot, "state", "outbox"), true)
	if err != nil {
		return 0, ErrUnavailable
	}
	if !directory.Exists {
		return 0, nil
	}
	if !directory.IsDirectory {
		return 0, ErrUnavailable
	}
	count, inspected := 0, 0
	var stopped error
	walkErr := nativefs.WalkDirectory(directory.Path, func(name string) error {
		inspected++
		stopped = countOutboxEntry(companionRoot, directory.Path, name, inspected, journalSources, gate, &count)
		return stopped
	})
	if stopped != nil {
		return 0, stopped
	}
	if walkErr != nil {
		return 0, ErrUnavailable
	}
	return count, nil
}

func countOutboxEntry(companionRoot, directory, name string, inspected int, journalSources map[string]bool, gate nativefs.Gate, count *int) error {
	if err := gate(); err != nil {
		return err
	}
	if inspected > outboxEntryLimit {
		return ErrUnavailable
	}
	if !strings.HasPrefix(name, "event-") || !eventName.MatchString(name[6:]) {
		return nil
	}
	path := filepath.Join(directory, name)
	record, err := nativefs.AdmitWithin(companionRoot, path, false)
	if err != nil || record.IsDirectory {
		return ErrUnavailable
	}
	sequence, _ := strconv.ParseInt(name[6:22], 10, 64)
	if sequence < 1 || sequence > j.MaximumSequence {
		return nil
	}
	duplicate := false
	if len(journalSources) > 0 {
		size, err := fileSize(record.Path)
		if err != nil {
			return ErrUnavailable
		}
		if size <= int64(j.StateEvent.Bytes) {
			raw, err := nativefs.ObserveRaw(record.Path, 30*time.Second)
			if err != nil {
				return ErrUnavailable
			}
			duplicate = journalSources[raw.Sha256+":"+strconv.FormatInt(sequence, 10)]
		}
	}
	if !duplicate {
		*count++
	}
	return nil
}

func fileSize(path string) (int64, error) {
	info, err := os.Lstat(`\\?\` + path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// CheckEventExpansion admits an event's finalization expansion.
func CheckEventExpansion(data []byte) ([]byte, error) {
	if err := events.ValidateFinalizationBudget(data); err != nil {
		return nil, ErrUnavailable
	}
	return []byte(`{"admitted":true}`), nil
}

// TrimQuarantine removes the oldest unprotected quarantined files beyond the retention limit.
// gate is consulted before the first deletion, the trim's commit point; later deletions proceed regardless of time.
func TrimQuarantine(root, scopeSha256 string, protectedBytes []byte, gate nativefs.Gate) ([]byte, error) {
	if err := verifyScope(root, scopeSha256); err != nil {
		return nil, err
	}
	document, err := j.Parse(protectedBytes, j.Config)
	if err != nil || document.Kind != j.Array {
		return nil, ErrUnavailable
	}
	protected := map[string]bool{}
	for _, value := range document.Items {
		relative, err := j.Text(value)
		if err != nil || !strings.HasPrefix(relative, "quarantine/") || !quarantineName.MatchString(relative[11:]) {
			return nil, ErrUnavailable
		}
		protected[relative[11:]] = true
	}
	directory, err := nativefs.AdmitWithin(root, filepath.Join(root, "quarantine"), true)
	if err != nil {
		return nil, ErrUnavailable
	}
	if !directory.Exists {
		return []byte(`{"removed":0,"remaining":0}`), nil
	}
	if !directory.IsDirectory {
		return nil, ErrUnavailable
	}
	// Retention orders every quarantined file by age, so the whole listing is read; gate is checked per entry, before the
	// first deletion commits anything.
	names, err := nativefs.ListDirectory(directory.Path)
	if err != nil {
		return nil, ErrUnavailable
	}
	type quarantined struct {
		path, name string
		written    int64
	}
	files := make([]quarantined, 0, len(names))
	for _, name := range names {
		if err := gate(); err != nil {
			return nil, err
		}
		path := filepath.Join(directory.Path, name)
		admitted, err := nativefs.AdmitWithin(root, path, false)
		if err != nil || admitted.IsDirectory || !quarantineName.MatchString(name) {
			return nil, ErrUnavailable
		}
		info, err := os.Stat(`\\?\` + path)
		if err != nil {
			return nil, ErrUnavailable
		}
		files = append(files, quarantined{path, name, info.ModTime().UnixNano()})
	}
	sort.Slice(files, func(a, b int) bool {
		if files[a].written != files[b].written {
			return files[a].written < files[b].written
		}
		return events.CompareOrdinal(files[a].name, files[b].name) < 0
	})
	removed := 0
	for _, file := range files {
		if len(files)-removed <= quarantineFileLimit {
			break
		}
		if protected[file.name] {
			continue
		}
		if err := verifyScope(root, scopeSha256); err != nil {
			return nil, err
		}
		before, err := nativefs.AdmitWithin(root, file.path, false)
		if err != nil {
			return nil, ErrUnavailable
		}
		observed, err := nativefs.ObserveRaw(file.path, 30*time.Second)
		if err != nil {
			return nil, ErrUnavailable
		}
		after, err := nativefs.AdmitWithin(root, file.path, false)
		if err != nil {
			return nil, ErrUnavailable
		}
		again, err := nativefs.ObserveRaw(file.path, 30*time.Second)
		if err != nil || before.IsDirectory || after.IsDirectory || before.Volume != after.Volume || before.Identity != after.Identity || again.Sha256 != observed.Sha256 {
			return nil, ErrUnavailable
		}
		if removed == 0 {
			if err := gate(); err != nil {
				return nil, err
			}
		}
		if err := nativefs.DeleteFile(file.path); err != nil {
			return nil, ErrUnavailable
		}
		removed++
	}
	return j.NewObject().Int("removed", int64(removed)).Int("remaining", int64(len(files)-removed)).Bytes(), nil
}
