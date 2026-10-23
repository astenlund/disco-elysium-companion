package events

import (
	"bytes"
	"errors"

	j "companion-helper/internal/jsondoc"
	"companion-helper/internal/nativefs"
)

// ErrCodecUnavailable marks a codec failure that is not a document defect, such as an inadmissible path or a failed
// publication. Document defects return jsondoc.ErrInvalid.
var ErrCodecUnavailable = errors.New("codec unavailable")

// CodecRequest is one serialized codec request.
type CodecRequest struct {
	Root, Target, Input, InputSha256, Control, ControlSha256 string
	VerifyOnly, Preview                                      bool
	// Gate is consulted immediately before publication; a nil Gate never refuses.
	Gate nativefs.Gate
}

func classify(err error) error {
	if errors.Is(err, j.ErrInvalid) || errors.Is(err, nativefs.ErrTooLarge) {
		return j.ErrInvalid
	}
	if errors.Is(err, nativefs.ErrDeadline) {
		return nativefs.ErrDeadline
	}
	return ErrCodecUnavailable
}

// ExecuteCodec runs one codec request and returns its reply bytes.
func ExecuteCodec(request CodecRequest) ([]byte, error) {
	destination, err := nativefs.AdmitWithin(request.Root, request.Target, true)
	if err != nil {
		return nil, ErrCodecUnavailable
	}
	if destination.IsDirectory || len(destination.Missing) > 1 {
		return nil, ErrCodecUnavailable
	}
	target := destination.Path
	frozen, err := readStaged(request.Root, target, request.Input, request.InputSha256, j.StateEvent)
	if err != nil {
		return nil, err
	}
	controlBytes, err := readStaged(request.Root, target, request.Control, request.ControlSha256, j.Config)
	if err != nil {
		return nil, err
	}
	if nativefs.EqualOrdinalIgnoreCase(request.Input, request.Control) {
		return nil, ErrCodecUnavailable
	}
	control, err := j.Parse(controlBytes, j.Config)
	if err != nil {
		return nil, j.ErrInvalid
	}
	c := &checker{}
	c.fields(control, "mode", "metadata", "compact", "expectedSequence", "createOnly", "binding")
	mode := c.text(c.property(control, "mode"))
	compact := c.boolean(c.property(control, "compact"))
	createOnly := c.boolean(c.property(control, "createOnly"))
	expectedSequence := c.integer(c.property(control, "expectedSequence"), 0, j.MaximumSequence)
	if c.err != nil {
		return nil, j.ErrInvalid
	}
	metadata := control.Get("metadata")
	mutation := mode == "create" || mode == "rewrite" || mode == "reconstruct"
	binding := control.Get("binding")
	if mode == "reconstruct" && binding.Kind != j.String || mode != "reconstruct" && binding.Kind != j.Null {
		return nil, j.ErrInvalid
	}
	sourceMode := mode == "source" || mode == "create" || mode == "reconstruct"
	if !mutation && (metadata.Kind != j.Null || compact || createOnly || request.Preview) || !sourceMode && expectedSequence != 0 {
		return nil, j.ErrInvalid
	}
	var result []byte
	switch {
	case sourceMode:
		source, err := j.Parse(frozen, j.StateEvent)
		if err != nil {
			return nil, j.ErrInvalid
		}
		if err := ValidateOutbox(source, expectedSequence); err != nil {
			return nil, j.ErrInvalid
		}
		switch mode {
		case "source":
			result = frozen
		case "create":
			result, err = CreateEvent(frozen, metadata.Raw)
		default:
			var expected string
			expected, err = j.Hex(binding, 64)
			if err == nil {
				result, err = ReconstructEvent(frozen, metadata.Raw, expected)
			}
		}
		if err != nil {
			return nil, classify(err)
		}
	case mode == "event" || mode == "rewrite":
		if _, err := Verify(frozen); err != nil {
			return nil, classify(err)
		}
		if mode == "event" {
			result = frozen
		} else if result, err = RewriteEvent(frozen, metadata.Raw, compact); err != nil {
			return nil, classify(err)
		}
	default:
		return nil, j.ErrInvalid
	}
	if mutation {
		if err := ValidateFinalizationBudget(result); err != nil {
			return nil, classify(err)
		}
	}
	resultHash := Sha256Hex(result)
	description, err := describe(result, mode == "source")
	if err != nil {
		return nil, classify(err)
	}
	if len(reply(resultHash, description, false, false)) > 65000 {
		return nil, j.ErrInvalid
	}
	matches, cleanupComplete := false, true
	if mutation && !request.VerifyOnly && !request.Preview {
		gate := request.Gate
		if gate == nil {
			gate = nativefs.NoDeadline
		}
		publication, err := nativefs.PublishValidated(request.Root, target, result, func(data []byte) error {
			return j.Validate(data, j.StateEvent)
		}, createOnly, gate)
		if err != nil {
			return nil, classify(err)
		}
		cleanupComplete = len(publication.RetainedSiblings) == 0
	}
	if mutation && !request.Preview {
		observed, err := nativefs.AdmitWithin(request.Root, target, true)
		if err != nil {
			return nil, ErrCodecUnavailable
		}
		if observed.Exists {
			if observed.IsDirectory {
				return nil, ErrCodecUnavailable
			}
			actual, err := nativefs.ReadBounded(observed.Path, j.StateEvent.Bytes)
			if err != nil {
				return nil, classify(err)
			}
			matches = bytes.Equal(actual, result)
		}
	}
	return reply(resultHash, description, mutation && matches, cleanupComplete), nil
}

func readStaged(root, target, input, expectedHash string, budget j.Budget) ([]byte, error) {
	source, err := nativefs.AdmitWithin(root, input, false)
	if err != nil || source.IsDirectory || !j.IsHex(expectedHash, 64) || !nativefs.IsOwnedSibling(target, source.Path) {
		return nil, ErrCodecUnavailable
	}
	data, err := nativefs.ReadBounded(source.Path, budget.Bytes)
	if err != nil {
		return nil, classify(err)
	}
	if Sha256Hex(data) != expectedHash {
		return nil, ErrCodecUnavailable
	}
	if err := j.Validate(data, budget); err != nil {
		return nil, j.ErrInvalid
	}
	return data, nil
}

func describe(data []byte, source bool) ([]byte, error) {
	root, err := j.Parse(data, j.StateEvent)
	if err != nil {
		return nil, err
	}
	fields := append(append([]string{}, MetadataFields...), "payloadBindingSha256")
	if source {
		fields = []string{"stateEventVersion", "logicalOutboxId", "incarnationId", "sequence", "kind", "createdAt", "principal", "repairOperationId", "adapterVersion", "game"}
	}
	out := j.NewObject()
	for _, field := range fields {
		value := root.Get(field)
		if value == nil {
			return nil, j.ErrInvalid
		}
		out.Raw(field, value.Raw)
	}
	hasState := source || root.Get("compacted").Kind != j.True
	var state *j.Value
	if hasState {
		holder := root
		if !source {
			holder = root.Get("payload")
		}
		state = holder.Get("state")
		if state == nil {
			return nil, j.ErrInvalid
		}
	}
	if source {
		schema, err := j.AnyInteger(state.Get("schemaVersion"))
		if err != nil {
			return nil, err
		}
		out.Int("schemaVersion", schema)
	}
	if hasState {
		target, err := TargetHash(state)
		if err != nil {
			return nil, err
		}
		generated := state.Get("generatedAt")
		if generated == nil || generated.Kind != j.String {
			return nil, j.ErrInvalid
		}
		out.String("targetIdentitySha256", target).String("stateGeneratedAt", generated.Str)
	} else {
		out.Null("targetIdentitySha256").Null("stateGeneratedAt")
	}
	return out.Bytes(), nil
}

// InspectFrozen validates complete event or source bytes and returns their description.
func InspectFrozen(data []byte, source bool, expectedSequence int64) ([]byte, error) {
	if err := j.Validate(data, j.StateEvent); err != nil {
		return nil, err
	}
	if source {
		root, err := j.Parse(data, j.StateEvent)
		if err != nil {
			return nil, err
		}
		if err := ValidateOutbox(root, expectedSequence); err != nil {
			return nil, err
		}
	} else if _, err := Verify(data); err != nil {
		return nil, err
	}
	return describe(data, source)
}

func reply(sha256 string, description []byte, published, cleanupComplete bool) []byte {
	return j.NewObject().Int("codecVersion", 1).String("sha256", sha256).Bool("published", published).
		Bool("cleanupComplete", cleanupComplete).Raw("metadata", description).Bytes()
}
