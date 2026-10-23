package context

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"

	j "companion-helper/internal/jsondoc"
	"companion-helper/internal/nativefs"
)

const maximumReplyBytes = 65536

var (
	requestFields = []string{"contextRequestVersion", "scopeSha256", "safetySha256", "generation", "journalId", "game", "principal", "template", "events", "state",
		"stateWanted", "shape", "failedBlockBytes", "instructionsSha256", "providerFingerprint", "disclosure"}
	requestName = regexp.MustCompile(`^prepared-context\.txt\.[a-f0-9]{32}\.tmp$`)
)

type reference struct {
	sequence   int64
	sha256     string
	redelivery bool
}

type candidate struct {
	shape            int
	value            *Rendering
	redelivery       *Redelivered
	sha256           string
	redeliverySha256 string
}

// Execute runs one context preparation request in Preview, Publish or Verify mode. Every failure has one class.
func Execute(root, inputPath, inputSha256, mode string, gate nativefs.Gate) ([]byte, error) {
	result, err := execute(root, inputPath, inputSha256, mode, gate)
	if errors.Is(err, nativefs.ErrDeadline) {
		return nil, err
	}
	if err != nil {
		return nil, ErrUnavailable
	}
	return result, nil
}

func execute(root, inputPath, inputSha256, mode string, gate nativefs.Gate) ([]byte, error) {
	if mode != "Preview" && mode != "Publish" && mode != "Verify" {
		return nil, j.ErrInvalid
	}
	input, err := nativefs.AdmitWithin(root, inputPath, false)
	if err != nil {
		return nil, err
	}
	normalizedRoot, err := nativefs.NormalizePath(root)
	if err != nil {
		return nil, err
	}
	if input.IsDirectory || !nativefs.EqualOrdinalIgnoreCase(filepath.Dir(input.Path), normalizedRoot) || !requestName.MatchString(filepath.Base(input.Path)) {
		return nil, ErrUnavailable
	}
	requestBytes, err := readExact(root, input.Path, inputSha256, j.StateEvent)
	if err != nil {
		return nil, err
	}
	value, err := j.Parse(requestBytes, j.StateEvent)
	if err != nil {
		return nil, err
	}
	c := checker{}
	c.ok(j.Fields(value, requestFields...))
	if c.err != nil {
		return nil, c.err
	}
	version, err := j.AnyInteger(value.Get("contextRequestVersion"))
	c.ok(err)
	c.require(version == 1)
	scopeHash, err := j.Hex(value.Get("scopeSha256"), 64)
	c.ok(err)
	safetyHash, err := j.Hex(value.Get("safetySha256"), 64)
	c.ok(err)
	generation, err := j.Hex(value.Get("generation"), 32)
	c.ok(err)
	game, err := j.Token(value.Get("game"))
	c.ok(err)
	principal, err := j.Token(value.Get("principal"))
	c.ok(err)
	disclosure, err := j.Boolean(value.Get("disclosure"))
	c.ok(err)
	stateWanted, err := j.Boolean(value.Get("stateWanted"))
	c.ok(err)
	instructions, err := j.Hex(value.Get("instructionsSha256"), 64)
	c.ok(err)
	provider, err := j.Hex(value.Get("providerFingerprint"), 64)
	c.ok(err)
	if c.err != nil {
		return nil, c.err
	}
	var shape *int
	if shapeValue := value.Get("shape"); shapeValue.Kind != j.Null {
		number, err := j.Integer(shapeValue, 1, 4)
		if err != nil {
			return nil, err
		}
		converted := int(number)
		shape = &converted
	}
	var failedBytes *int
	if failedValue := value.Get("failedBlockBytes"); failedValue.Kind != j.Null {
		number, err := j.Integer(failedValue, 1, MaximumBlockBytes)
		if err != nil {
			return nil, err
		}
		converted := int(number)
		failedBytes = &converted
	}
	if mode != "Preview" && shape == nil {
		return nil, j.ErrInvalid
	}
	var journalID *string
	if journalValue := value.Get("journalId"); journalValue.Kind != j.Null {
		token, err := j.Token(journalValue)
		if err != nil {
			return nil, err
		}
		journalID = &token
	}
	if !disclosure && journalID == nil {
		return nil, j.ErrInvalid
	}
	scopeBytes, err := readExact(root, filepath.Join(root, "scope.json"), scopeHash, j.Config)
	if err != nil {
		return nil, err
	}
	scope, err := j.Parse(scopeBytes, j.Config)
	if err != nil || j.Fields(scope, "runtimeScopeVersion", "game", "principal") != nil {
		return nil, j.ErrInvalid
	}
	scopeVersion, err := j.AnyInteger(scope.Get("runtimeScopeVersion"))
	if err != nil || scopeVersion != 1 || !stringEquals(scope.Get("game"), game) || !stringEquals(scope.Get("principal"), principal) {
		return nil, j.ErrInvalid
	}
	safetyBytes, err := readExact(root, filepath.Join(root, "state-safety.json"), safetyHash, j.Config)
	if err != nil {
		return nil, err
	}
	safety, err := j.Parse(safetyBytes, j.Config)
	if err != nil {
		return nil, err
	}
	pending := safety.Get("pendingCheck")
	if !stringEquals(safety.Get("generation"), generation) || pending == nil || pending.Kind != j.Null {
		return nil, j.ErrInvalid
	}
	correction := safety.Get("correction")
	template := value.Get("template")
	presented := template.Get("correction")
	if correction == nil || presented == nil {
		return nil, j.ErrInvalid
	}
	if correction.Kind == j.Null {
		if presented.Kind != j.Null {
			return nil, j.ErrInvalid
		}
	} else {
		if j.Fields(presented, "correctionId", "reason") != nil {
			return nil, j.ErrInvalid
		}
		if !sameString(presented.Get("correctionId"), correction.Get("correctionId")) || !sameString(presented.Get("reason"), correction.Get("reason")) {
			return nil, j.ErrInvalid
		}
	}
	list := value.Get("events")
	if list.Kind != j.Array || len(list.Items) > MaximumEvents {
		return nil, j.ErrInvalid
	}
	references := []reference{}
	var previous int64
	for _, entry := range list.Items {
		if j.Fields(entry, "sequence", "sha256", "redelivery") != nil {
			return nil, j.ErrInvalid
		}
		redelivery, err := j.Boolean(entry.Get("redelivery"))
		if err != nil {
			return nil, err
		}
		parsed, err := parseReference(entry, redelivery)
		if err != nil {
			return nil, err
		}
		if parsed.sequence <= previous {
			return nil, j.ErrInvalid
		}
		previous = parsed.sequence
		references = append(references, parsed)
	}
	var stateReference *reference
	if stateValue := value.Get("state"); stateValue.Kind != j.Null {
		if j.Fields(stateValue, "sequence", "sha256") != nil {
			return nil, j.ErrInvalid
		}
		parsed, err := parseReference(stateValue, false)
		if err != nil {
			return nil, err
		}
		for _, carried := range references {
			if carried.sequence == parsed.sequence && carried.sha256 != parsed.sha256 {
				return nil, j.ErrInvalid
			}
		}
		stateReference = &parsed
	}
	if disclosure && !(len(references) == 0 && stateReference == nil && (shape == nil || *shape == 1)) {
		return nil, j.ErrInvalid
	}
	cache := map[int64]*Record{}
	load := func(ref reference) (*Record, error) {
		if record, ok := cache[ref.sequence]; ok {
			return record, nil
		}
		file := filepath.Join(root, "journal", "events", fmt.Sprintf("%016d.json", ref.sequence))
		data, err := readExact(root, file, ref.sha256, j.StateEvent)
		if err != nil {
			return nil, err
		}
		record, err := RecordFromFrozen(data, ref.sha256, generation, stateReference != nil && ref.sequence == stateReference.sequence)
		if err != nil {
			return nil, err
		}
		if record.Sequence != ref.sequence || journalID == nil || record.JournalID != *journalID || record.Game != game || record.Principal != principal {
			return nil, j.ErrInvalid
		}
		cache[ref.sequence] = record
		return record, nil
	}
	selections := func() EventSource {
		index := 0
		return func() (*Selection, error) {
			if index >= len(references) {
				return nil, nil
			}
			ref := references[index]
			index++
			record, err := load(ref)
			if err != nil {
				return nil, err
			}
			return &Selection{Record: record, Redelivery: ref.redelivery}, nil
		}
	}
	var state *Record
	if stateReference != nil {
		if state, err = load(*stateReference); err != nil {
			return nil, err
		}
	}
	shapes := []int{1, 2, 3, 4}
	if shape != nil {
		shapes = []int{*shape}
	}
	var candidates []candidate
	for _, candidateShape := range shapes {
		if disclosure && candidateShape != 1 {
			continue
		}
		var rendered *Rendering
		if disclosure {
			rendered, err = Render(template.Raw, []Selection{}, nil, generation, nil, false, false, instructions, provider, MaximumBlockBytes)
		} else {
			rendered, err = Select(candidateShape, template.Raw, selections(), state, stateWanted, generation, instructions, provider, failedBytes)
		}
		if err != nil {
			return nil, err
		}
		if rendered == nil {
			continue
		}
		redelivery, err := Redeliver(rendered, instructions, provider)
		if err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate{candidateShape, rendered, redelivery, sha(rendered.Bytes), sha(redelivery.Bytes)})
	}
	redeliveries := make([]*Redelivered, len(candidates))
	for index, value := range candidates {
		redeliveries[index] = value.redelivery
	}
	offsets, err := PackRedeliveryOffsets(redeliveries)
	if err != nil {
		return nil, err
	}
	if _, err := createReply(inputSha256, candidates, offsets, false, false); err != nil {
		return nil, err
	}
	published, cleanupComplete := false, true
	if mode != "Preview" && len(candidates) == 1 {
		rendered := candidates[0].value
		target, err := nativefs.AdmitWithin(root, filepath.Join(root, "prepared-context.txt"), true)
		if err != nil {
			return nil, err
		}
		if mode == "Verify" {
			if target.Exists && !target.IsDirectory {
				actual, err := nativefs.ReadBounded(target.Path, MaximumBlockBytes)
				if err != nil {
					return nil, err
				}
				published = bytes.Equal(actual, rendered.Bytes)
			}
			cleanupComplete = false
		} else {
			result, err := nativefs.PublishValidated(root, filepath.Join(root, "prepared-context.txt"), rendered.Bytes, validatePrepared, true, gate)
			if err != nil {
				return nil, err
			}
			published = result.Sha256 == sha(rendered.Bytes)
			cleanupComplete = len(result.RetainedSiblings) == 0
		}
	}
	return createReply(inputSha256, candidates, offsets, published, cleanupComplete)
}

func validatePrepared(value []byte) error {
	if len(value) > MaximumBlockBytes || len(value) <= len(opening)+len(closing) || !bytes.HasPrefix(value, opening) || !bytes.HasSuffix(value, closing) {
		return j.ErrInvalid
	}
	return j.Validate(value[len(opening):len(value)-len(closing)], j.StateEvent)
}

func createReply(inputSha256 string, candidates []candidate, offsets PackedOffsets, published, cleanupComplete bool) ([]byte, error) {
	list := j.NewArray()
	for index, value := range candidates {
		rendered := value.value
		item := j.NewObject().Int("shape", int64(value.shape)).String("sha256", value.sha256).String("fingerprint", rendered.Fingerprint).
			Int("bytes", int64(len(rendered.Bytes))).Int("eventCount", int64(rendered.EventCount)).Bool("stateIncluded", rendered.StateIncluded).
			NullableString("degraded", rendered.Degraded).String("redeliverySha256", value.redeliverySha256).
			Int("redeliveryBytes", int64(len(value.redelivery.Bytes))).Int("redeliveryChanges", int64(len(value.redelivery.Offsets))).
			Int("redeliveryOffsetDelta", int64(offsets.Deltas[index]))
		list.Raw(item.Bytes())
	}
	reply := j.NewObject().Int("contextResultVersion", 1).String("requestSha256", inputSha256).Bool("published", published).
		// Utf8JsonWriter.WriteBase64String writes base64 text without the escaping its string writer applies to '+'.
		Bool("cleanupComplete", cleanupComplete).Raw("redeliveryOffsets", []byte(`"`+base64.StdEncoding.EncodeToString(offsets.Encoded)+`"`)).
		Raw("candidates", list.Bytes()).Bytes()
	if len(reply) > maximumReplyBytes {
		return nil, j.ErrInvalid
	}
	return reply, nil
}

func parseReference(value *j.Value, redelivery bool) (reference, error) {
	sequence, err := j.Integer(value.Get("sequence"), 1, j.MaximumSequence)
	if err != nil {
		return reference{}, err
	}
	hash, err := j.Hex(value.Get("sha256"), 64)
	if err != nil {
		return reference{}, err
	}
	return reference{sequence, hash, redelivery}, nil
}

func readExact(root, path, expectedHash string, budget j.Budget) ([]byte, error) {
	admitted, err := nativefs.AdmitWithin(root, path, false)
	if err != nil || admitted.IsDirectory || !j.IsHex(expectedHash, 64) {
		return nil, ErrUnavailable
	}
	data, err := nativefs.ReadBounded(admitted.Path, budget.Bytes)
	if err != nil {
		return nil, err
	}
	if sha(data) != expectedHash {
		return nil, ErrUnavailable
	}
	if err := j.Validate(data, budget); err != nil {
		return nil, err
	}
	return data, nil
}

func stringEquals(value *j.Value, expected string) bool {
	return value != nil && value.Kind == j.String && value.Str == expected
}

// sameString mirrors comparing two GetString results: both strings and equal, or both null.
func sameString(left, right *j.Value) bool {
	if left == nil || right == nil {
		return false
	}
	if left.Kind == j.Null || right.Kind == j.Null {
		return left.Kind == j.Null && right.Kind == j.Null
	}
	return left.Kind == j.String && right.Kind == j.String && left.Str == right.Str
}
