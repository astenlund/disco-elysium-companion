package events

import (
	"crypto/sha256"
	"encoding/hex"

	j "companion-helper/internal/jsondoc"
)

// Sha256Hex returns the lowercase hex SHA-256 of data.
func Sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func parseEvent(data []byte) (*j.Value, error) {
	return j.Parse(data, j.StateEvent)
}

// ValidateFinalizationBudget requires that a pending record still fits the state-event budget after its acceptance and
// acknowledgement controls are filled with their largest values.
func ValidateFinalizationBudget(data []byte) error {
	if _, err := Verify(data); err != nil {
		return err
	}
	root, err := parseEvent(data)
	if err != nil {
		return err
	}
	out := j.NewObject()
	for _, member := range root.Members {
		switch {
		case member.Name == "acknowledgedAt" && member.Value.Kind == j.Null:
			out.String(member.Name, "9999-12-31T23:59:59.9999999Z")
		case member.Name == "acceptance" && member.Value.Kind == j.Null:
			acceptance := j.NewObject().String("journalId", root.Get("journalId").Str).String("eventId", root.Get("eventId").Str).
				String("generation", "ffffffffffffffffffffffffffffffff")
			out.Raw(member.Name, acceptance.Bytes())
		case member.Name == "settlement":
			out.String(member.Name, "accepted")
		default:
			out.Raw(member.Name, member.Value.Raw)
		}
	}
	return j.Validate(out.Bytes(), j.StateEvent)
}

// CreateEvent builds a pending event from a frozen outbox record and its creation metadata.
func CreateEvent(frozenSource, metadata []byte) ([]byte, error) {
	source, err := parseEvent(frozenSource)
	if err != nil {
		return nil, err
	}
	if err := ValidateOutbox(source, 0); err != nil {
		return nil, err
	}
	control, err := parseEvent(metadata)
	if err != nil {
		return nil, err
	}
	if err := ValidateMetadata(control, false); err != nil {
		return nil, err
	}
	if err := CorrelateSource(source, control); err != nil {
		return nil, err
	}
	sourceHash := Sha256Hex(frozenSource)
	payload := j.NewObject()
	for _, field := range PayloadFields {
		payload.Raw(field, source.Get(field).Raw)
	}
	payloadBytes := payload.Bytes()
	binding, err := Binding(sourceHash, payloadBytes)
	if err != nil {
		return nil, err
	}
	return writeEvent(metadata, sourceHash, binding, payloadBytes, false)
}

// Verify checks a stored event and returns its payload binding.
func Verify(eventBytes []byte) (string, error) {
	root, err := parseEvent(eventBytes)
	if err != nil {
		return "", err
	}
	if err := ValidateMetadata(root, true); err != nil {
		return "", err
	}
	sourceHash, err := j.Hex(root.Get("recordSha256"), 64)
	if err != nil {
		return "", err
	}
	binding, err := j.Hex(root.Get("payloadBindingSha256"), 64)
	if err != nil {
		return "", err
	}
	if root.Get("compacted").Kind != j.True {
		expected, err := Binding(sourceHash, root.Get("payload").Raw)
		if err != nil {
			return "", err
		}
		if expected != binding {
			return "", j.ErrInvalid
		}
	}
	return binding, nil
}

// RewriteEvent replaces an event's metadata, optionally compacting its payload away.
func RewriteEvent(eventBytes, metadata []byte, compact bool) ([]byte, error) {
	binding, err := Verify(eventBytes)
	if err != nil {
		return nil, err
	}
	root, err := parseEvent(eventBytes)
	if err != nil {
		return nil, err
	}
	control, err := parseEvent(metadata)
	if err != nil {
		return nil, err
	}
	if err := ValidateMetadata(control, false); err != nil {
		return nil, err
	}
	if err := CorrelateRewrite(root, control); err != nil {
		return nil, err
	}
	if root.Get("compacted").Kind == j.True && !compact {
		return nil, j.ErrInvalid
	}
	var payload []byte
	if !compact {
		payload = root.Get("payload").Raw
	}
	sourceHash, err := j.Hex(root.Get("recordSha256"), 64)
	if err != nil {
		return nil, err
	}
	return writeEvent(metadata, sourceHash, binding, payload, compact)
}

// ReconstructEvent rebuilds a retained event from its recovered source and must reproduce the original binding.
func ReconstructEvent(frozenSource, metadata []byte, expectedBinding string) ([]byte, error) {
	control, err := parseEvent(metadata)
	if err != nil {
		return nil, err
	}
	if err := ValidateMetadata(control, false); err != nil {
		return nil, err
	}
	if control.Get("compacted").Kind == j.True {
		return nil, j.ErrInvalid
	}
	initial := j.NewObject()
	for _, field := range MetadataFields {
		switch field {
		case "acceptance", "acknowledgedAt":
			initial.Null(field)
		case "settlement":
			initial.String(field, "pending")
		default:
			initial.Raw(field, control.Get(field).Raw)
		}
	}
	created, err := CreateEvent(frozenSource, initial.Bytes())
	if err != nil {
		return nil, err
	}
	binding, err := Verify(created)
	if err != nil {
		return nil, err
	}
	if binding != expectedBinding {
		return nil, j.ErrInvalid
	}
	return RewriteEvent(created, metadata, false)
}

// Binding is the payload binding digest over the source hash and the exact payload bytes.
func Binding(sourceHash string, payload []byte) (string, error) {
	if !j.IsHex(sourceHash, 64) {
		return "", j.ErrInvalid
	}
	hash := sha256.New()
	hash.Write([]byte("companion-core-payload-v1\n"))
	hash.Write([]byte(sourceHash))
	hash.Write([]byte{10})
	hash.Write(payload)
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func writeEvent(metadata []byte, sourceHash, binding string, payload []byte, compact bool) ([]byte, error) {
	root, err := parseEvent(metadata)
	if err != nil {
		return nil, err
	}
	if err := ValidateMetadata(root, false); err != nil {
		return nil, err
	}
	record, err := j.Hex(root.Get("recordSha256"), 64)
	if err != nil || record != sourceHash {
		return nil, j.ErrInvalid
	}
	wantKind := j.False
	if compact {
		wantKind = j.True
	}
	if root.Get("compacted").Kind != wantKind {
		return nil, j.ErrInvalid
	}
	out := j.NewObject()
	for _, field := range MetadataFields {
		out.Raw(field, root.Get(field).Raw)
	}
	out.String("payloadBindingSha256", binding)
	if payload != nil {
		out.Raw("payload", payload)
	}
	result := out.Bytes()
	if _, err := Verify(result); err != nil {
		return nil, err
	}
	return result, nil
}

// TargetHash is the identity digest of a state's target save.
func TargetHash(state *j.Value) (string, error) {
	source := state.Get("source")
	generated := state.Get("generatedAt")
	if source == nil || generated == nil || generated.Kind != j.String {
		return "", j.ErrInvalid
	}
	out := j.NewObject().String("generatedAt", generated.Str)
	for _, field := range []string{"domainId", "saveFile", "savedAt", "contentSha256"} {
		value := source.Get(field)
		if value == nil || value.Kind != j.String {
			return "", j.ErrInvalid
		}
		out.String(field, value.Str)
	}
	length, err := j.Integer(source.Get("byteLength"), 1, 1<<63-1)
	if err != nil {
		return "", err
	}
	out.Int("byteLength", length)
	return Sha256Hex(out.Bytes()), nil
}
