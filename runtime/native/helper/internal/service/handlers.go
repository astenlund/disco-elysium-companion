package service

import (
	"encoding/base64"
	"errors"

	ctx "companion-helper/internal/context"
	"companion-helper/internal/events"
	"companion-helper/internal/inventory"
	j "companion-helper/internal/jsondoc"
	"companion-helper/internal/nativefs"
	"companion-helper/internal/sources"
	"companion-helper/internal/winproc"
)

type handler struct {
	fields   []string
	mutating bool
	run      func(*call, *j.Value) ([]byte, string)
}

var handlers = map[string]handler{
	"admit":              {[]string{"root", "targets", "allowMissing"}, false, admit},
	"hash":               {[]string{"root", "inputBase64", "scopeSha256"}, false, hash},
	"inventory":          {[]string{"root", "scopeSha256", "companionRoot", "mode", "inputBase64"}, false, resourceInventory},
	"eventMetadata":      {[]string{"root", "requestsJson", "source"}, false, eventMetadata},
	"eventBatch":         {[]string{"root", "inputBase64"}, false, eventBatch},
	"publish":            {[]string{"root", "target", "inputFile", "inputSha256", "profile", "createOnly"}, true, publish},
	"codec":              {[]string{"root", "target", "inputFile", "inputSha256", "controlFile", "controlSha256", "verifyOnly", "preview"}, true, codec},
	"contextPreparation": {[]string{"root", "inputFile", "inputSha256", "mode"}, true, contextPreparation},
	"fileAction":         {[]string{"root", "action", "source", "sha256", "target"}, true, fileAction},
	"principal":          {nil, false, principal},
	"processIdentity":    {[]string{"pid"}, false, processIdentity},
	"jobStates":          {[]string{"names", "owner"}, false, jobStates},
	"ownedProcessLive":   {[]string{"jobName", "pid", "created"}, false, ownedProcessLive},
	"stopOrphanWatcher":  {[]string{"pid", "created", "jobName"}, true, stopOrphanWatcher},
	"coreReplySource":    {[]string{"companionRoot", "dataRoot", "sourceRoot"}, false, coreReplySource},
	"bindScope":          {[]string{"token", "companionRoot", "dataRoot"}, false, bindScope},
}

func text(request *j.Value, name string) (string, bool) {
	value, err := j.Text(request.Get(name))
	return value, err == nil
}

func nullableText(request *j.Value, name string) (*string, bool) {
	value := request.Get(name)
	if value.Kind == j.Null {
		return nil, true
	}
	if value.Kind != j.String {
		return nil, false
	}
	return &value.Str, true
}

func flag(request *j.Value, name string) (bool, bool) {
	value, err := j.Boolean(request.Get(name))
	return value, err == nil
}

func decoded(request *j.Value, name string, maximum int) ([]byte, bool) {
	value, ok := text(request, name)
	if !ok {
		return nil, false
	}
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(data) < 1 || len(data) > maximum || base64.StdEncoding.EncodeToString(data) != value {
		return nil, false
	}
	return data, true
}

// failure maps a mutating primitive's error: a refusal at the commit gate is deadlineExceeded, anything else code.
func failure(err error, code string) string {
	if errors.Is(err, nativefs.ErrDeadline) {
		return "deadlineExceeded"
	}
	return code
}

func pid(request *j.Value, name string) (int, bool) {
	value, err := j.Integer(request.Get(name), 1, 2147483647)
	return int(value), err == nil
}

func admit(c *call, request *j.Value) ([]byte, string) {
	const code = "admissionUnavailable"
	root, ok := text(request, "root")
	allowMissing, okMissing := flag(request, "allowMissing")
	targets := request.Get("targets")
	if !ok || !okMissing || !c.state.withinCompanion(root) || targets.Kind != j.Array || len(targets.Items) < 1 || len(targets.Items) > 64 || len(targets.Raw) > 65536 {
		return nil, code
	}
	list := j.NewArray()
	for _, target := range targets.Items {
		if target.Kind != j.String {
			return nil, code
		}
		admission, err := nativefs.AdmitWithin(root, target.Str, allowMissing)
		if err != nil {
			return nil, code
		}
		list.Raw(describeAdmission(admission))
	}
	return j.NewObject().Raw("paths", list.Bytes()).Bytes(), ""
}

func describeAdmission(admission nativefs.Admission) []byte {
	out := j.NewObject().String("path", admission.Path).Bool("exists", admission.Exists)
	if !admission.Exists {
		out.Null("kind").Null("links").Null("volume").Null("identity")
	} else {
		kind := "file"
		if admission.IsDirectory {
			kind = "directory"
		}
		out.String("kind", kind).Int("links", int64(admission.Links)).String("volume", admission.Volume).String("identity", admission.Identity)
	}
	missing := j.NewArray()
	for _, part := range admission.Missing {
		missing.String(part)
	}
	return out.Raw("missing", missing.Bytes()).Bytes()
}

func hash(c *call, request *j.Value) ([]byte, string) {
	const code = "observationUnavailable"
	root, ok := text(request, "root")
	input, okInput := decoded(request, "inputBase64", j.Config.Bytes)
	scope, okScope := nullableText(request, "scopeSha256")
	if !ok || !okInput || !okScope || !c.state.withinCompanion(root) {
		return nil, code
	}
	result, err := nativefs.ReadHashes(root, input, scope)
	if err != nil {
		return nil, code
	}
	return result, ""
}

func resourceInventory(c *call, request *j.Value) ([]byte, string) {
	const code = "inventoryUnavailable"
	root, ok := text(request, "root")
	scope, okScope := text(request, "scopeSha256")
	companion, okCompanion := nullableText(request, "companionRoot")
	mode, okMode := text(request, "mode")
	if !ok || !okScope || !okCompanion || !okMode || !c.state.withinCompanion(root) || companion != nil && !c.state.withinCompanion(*companion) {
		return nil, code
	}
	var result []byte
	var err error
	switch mode {
	case "Inventory", "Marker":
		if request.Get("inputBase64").Kind != j.Null {
			return nil, code
		}
		companionRoot := ""
		if companion != nil {
			companionRoot = *companion
		}
		result, err = inventory.Read(root, scope, mode == "Marker", companionRoot)
	case "Event":
		input, okInput := decoded(request, "inputBase64", j.StateEvent.Bytes)
		if !okInput {
			return nil, code
		}
		result, err = inventory.CheckEventExpansion(input)
	case "Quarantine":
		if !c.state.withinBound(root) {
			return nil, "scopeUnbound"
		}
		input, okInput := decoded(request, "inputBase64", j.Config.Bytes)
		if !okInput {
			return nil, code
		}
		result, err = inventory.TrimQuarantine(root, scope, input, c.gate())
	default:
		return nil, code
	}
	if err != nil {
		return nil, failure(err, code)
	}
	return result, ""
}

func eventMetadata(c *call, request *j.Value) ([]byte, string) {
	const code = "inspectionUnavailable"
	root, ok := text(request, "root")
	requests, okRequests := text(request, "requestsJson")
	source, okSource := flag(request, "source")
	if !ok || !okRequests || !okSource || !c.state.withinCompanion(root) {
		return nil, code
	}
	result, err := events.ReadRequests(root, []byte(requests), source)
	if err != nil {
		return nil, code
	}
	return result, ""
}

func eventBatch(c *call, request *j.Value) ([]byte, string) {
	const code = "inspectionUnavailable"
	root, ok := text(request, "root")
	input, okInput := decoded(request, "inputBase64", j.Config.Bytes)
	if !ok || !okInput || !c.state.withinCompanion(root) {
		return nil, code
	}
	result, err := events.ReadBatch(root, input)
	if err != nil {
		return nil, code
	}
	return result, ""
}

func publish(c *call, request *j.Value) ([]byte, string) {
	const code = "publicationFailed"
	root, ok := text(request, "root")
	target, okTarget := text(request, "target")
	input, okInput := text(request, "inputFile")
	hashText, okHash := text(request, "inputSha256")
	profile, okProfile := text(request, "profile")
	createOnly, okCreate := flag(request, "createOnly")
	budget, knownProfile := j.ProfileBudget(profile)
	if !ok || !okTarget || !okInput || !okHash || !okProfile || !okCreate || !knownProfile || !c.state.withinBound(root) {
		return nil, code
	}
	destination, err := nativefs.AdmitWithin(root, target, true)
	if err != nil {
		return nil, code
	}
	source, err := nativefs.AdmitWithin(root, input, false)
	if err != nil || destination.IsDirectory || source.IsDirectory || len(destination.Missing) > 1 || !j.IsHex(hashText, 64) {
		return nil, code
	}
	if !nativefs.IsOwnedSibling(destination.Path, source.Path) || createOnly && destination.Exists {
		return nil, code
	}
	data, err := nativefs.ReadBounded(source.Path, budget.Bytes)
	if err != nil || j.Validate(data, budget) != nil || events.Sha256Hex(data) != hashText {
		return nil, code
	}
	result, err := nativefs.PublishValidated(root, destination.Path, data, func(value []byte) error { return j.Validate(value, budget) }, createOnly, c.gate())
	if err != nil {
		return nil, failure(err, code)
	}
	retained := j.NewArray()
	for _, sibling := range result.RetainedSiblings {
		retained.String(sibling)
	}
	return j.NewObject().Bool("published", true).String("sha256", result.Sha256).Bool("cleanupComplete", len(result.RetainedSiblings) == 0).
		Raw("retainedSiblings", retained.Bytes()).Bytes(), ""
}

func codec(c *call, request *j.Value) ([]byte, string) {
	var values [6]string
	for index, name := range []string{"root", "target", "inputFile", "inputSha256", "controlFile", "controlSha256"} {
		value, ok := text(request, name)
		if !ok {
			return nil, "codecUnavailable"
		}
		values[index] = value
	}
	verifyOnly, okVerify := flag(request, "verifyOnly")
	preview, okPreview := flag(request, "preview")
	if !okVerify || !okPreview || !c.state.withinBound(values[0]) {
		return nil, "codecUnavailable"
	}
	result, err := events.ExecuteCodec(events.CodecRequest{Root: values[0], Target: values[1], Input: values[2], InputSha256: values[3],
		Control: values[4], ControlSha256: values[5], VerifyOnly: verifyOnly, Preview: preview, Gate: c.gate()})
	if err != nil {
		if errors.Is(err, j.ErrInvalid) {
			return nil, "documentInvalid"
		}
		return nil, failure(err, "codecUnavailable")
	}
	return result, ""
}

func contextPreparation(c *call, request *j.Value) ([]byte, string) {
	const code = "contextUnavailable"
	root, ok := text(request, "root")
	input, okInput := text(request, "inputFile")
	hashText, okHash := text(request, "inputSha256")
	mode, okMode := text(request, "mode")
	if !ok || !okInput || !okHash || !okMode || !c.state.withinBound(root) {
		return nil, code
	}
	result, err := ctx.Execute(root, input, hashText, mode, c.gate())
	if err != nil {
		return nil, failure(err, code)
	}
	return result, ""
}

func fileAction(c *call, request *j.Value) ([]byte, string) {
	const code = "fileActionFailed"
	root, ok := text(request, "root")
	action, okAction := text(request, "action")
	source, okSource := text(request, "source")
	hashText, okHash := text(request, "sha256")
	target, okTarget := nullableText(request, "target")
	if !ok || !okAction || !okSource || !okHash || !okTarget || !c.state.withinBound(root) {
		return nil, code
	}
	destination := ""
	switch {
	case action == "Move" && target != nil && *target != "":
		destination = *target
	case action == "Remove" && target == nil:
	default:
		return nil, code
	}
	if err := nativefs.FileAction(root, action, source, destination, hashText, c.gate()); err != nil {
		return nil, failure(err, code)
	}
	return []byte(`{"completed":true}`), ""
}

func principal(_ *call, _ *j.Value) ([]byte, string) {
	sid, err := winproc.CurrentPrincipal()
	if err != nil {
		return nil, "principalUnavailable"
	}
	return j.NewObject().String("sid", sid).Bytes(), ""
}

func processIdentity(_ *call, request *j.Value) ([]byte, string) {
	const code = "processIdentityUnavailable"
	processID, ok := pid(request, "pid")
	if !ok {
		return nil, code
	}
	identity, err := winproc.ReadIdentity(processID)
	if err != nil {
		return nil, code
	}
	if identity == nil {
		return j.NewObject().Bool("exists", false).Int("pid", int64(processID)).Null("created").Bytes(), ""
	}
	return j.NewObject().Bool("exists", true).Int("pid", int64(identity.PID)).String("created", identity.Created).Bytes(), ""
}

// jobStates observes named jobs. With an owner, it also reports whether the owner's job holds exactly that one
// process, the proof later startup gates use for the runtime's own bound helper service.
func jobStates(_ *call, request *j.Value) ([]byte, string) {
	const code = "jobUnavailable"
	names := request.Get("names")
	if names.Kind != j.Array || len(names.Items) < 1 || len(names.Items) > 16 {
		return nil, code
	}
	owner := request.Get("owner")
	var ownerName, ownerCreated string
	var ownerPID int
	if owner.Kind != j.Null {
		if j.Fields(owner, "name", "pid", "created") != nil {
			return nil, code
		}
		var ok, okPID, okCreated bool
		ownerName, ok = text(owner, "name")
		ownerPID, okPID = pid(owner, "pid")
		ownerCreated, okCreated = text(owner, "created")
		if !ok || !okPID || !okCreated || !winproc.ValidCreationToken(ownerCreated) {
			return nil, code
		}
	}
	seen := map[string]bool{}
	list := j.NewArray()
	for _, name := range names.Items {
		if name.Kind != j.String || name.Str == "" || seen[name.Str] {
			return nil, code
		}
		seen[name.Str] = true
		count, err := winproc.ObserveJob(name.Str)
		if err != nil {
			return nil, code
		}
		entry := j.NewObject().String("name", name.Str)
		if count == nil {
			entry.String("state", "absent").Null("processes")
		} else {
			entry.String("state", "present").Int("processes", int64(*count))
		}
		list.Raw(entry.Bytes())
	}
	reply := j.NewObject().Raw("jobs", list.Bytes())
	if owner.Kind != j.Null {
		if !seen[ownerName] {
			return nil, code
		}
		owned, err := winproc.SoleMember(ownerName, ownerPID, ownerCreated)
		if err != nil {
			return nil, code
		}
		reply.Bool("owned", owned)
	}
	return reply.Bytes(), ""
}

func ownedProcessLive(_ *call, request *j.Value) ([]byte, string) {
	const code = "ownedProcessLiveUnavailable"
	name, ok := text(request, "jobName")
	processID, okPID := pid(request, "pid")
	created, okCreated := text(request, "created")
	if !ok || !okPID || !okCreated {
		return nil, code
	}
	live, err := winproc.OwnedProcessLive(name, processID, created)
	if err != nil {
		return nil, code
	}
	return j.NewObject().Bool("live", live).Bytes(), ""
}

func stopOrphanWatcher(c *call, request *j.Value) ([]byte, string) {
	const code = "orphanWatcherUnavailable"
	processID, ok := pid(request, "pid")
	created, okCreated := text(request, "created")
	name, okName := text(request, "jobName")
	if !ok || !okCreated || !okName {
		return nil, code
	}
	result, err := winproc.StopOrphanWatcher(processID, created, name, c.gate())
	if err != nil {
		return nil, failure(err, code)
	}
	return j.NewObject().String("state", result).Int("pid", int64(processID)).String("created", created).Bytes(), ""
}

// coreReplySource reads its companion and data roots only inside the service's companion root; its installation-root
// bundle under sourceRoot is the one exemption from the admitted-root rule.
func coreReplySource(c *call, request *j.Value) ([]byte, string) {
	const code = "sourceUnavailable"
	companionRoot, ok := text(request, "companionRoot")
	dataRoot, okData := text(request, "dataRoot")
	sourceRoot, okSource := text(request, "sourceRoot")
	if !ok || !okData || !okSource || !c.state.withinCompanion(companionRoot) || !c.state.withinCompanion(dataRoot) {
		return nil, code
	}
	result, err := sources.CoreReplySource(companionRoot, dataRoot, sourceRoot)
	if err != nil {
		return nil, code
	}
	return result, ""
}

// bindScope runs only while no other request is in flight, which the runtime guarantees; the write lock keeps the
// binding consistent even so.
func bindScope(c *call, request *j.Value) ([]byte, string) {
	const code = "jobUnavailable"
	token, ok := text(request, "token")
	companionRoot, okCompanion := text(request, "companionRoot")
	dataRoot, okData := text(request, "dataRoot")
	s := c.state
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if !ok || !okCompanion || !okData || !j.IsHex(token, 32) || s.bound {
		return nil, code
	}
	companion, err := nativefs.Admit(companionRoot, false)
	if err != nil || !companion.IsDirectory || !nativefs.EqualOrdinalIgnoreCase(companion.Path, s.companion) {
		return nil, code
	}
	// A first start binds before scope initialization creates the data root, so only its location is admitted here;
	// every mutating request admits its own paths again.
	data, err := nativefs.AdmitWithin(companionRoot, dataRoot, true)
	if err != nil || data.Exists && !data.IsDirectory {
		return nil, code
	}
	if err := c.gate()(); err != nil {
		return nil, failure(err, code)
	}
	if winproc.JoinScopeJob(`Global\game-companion-process-`+token+`-helper`) != nil {
		return nil, code
	}
	s.bound, s.companionRoot, s.dataRoot = true, companion.Path, data.Path
	return j.NewObject().Bool("bound", true).Bytes(), ""
}
