// Package events reproduces the runtime's state-event document rules and lossless payload codec. Only transport
// metadata and cross-document invariants are interpreted; nested game values stay exact source bytes.
package events

import (
	"strings"

	j "companion-helper/internal/jsondoc"
)

// PayloadFields, OutboxFields and MetadataFields are the exact member lists, in order.
var (
	PayloadFields  = []string{"baseline", "sourceFloor", "refresh", "warnings", "baselineReset", "diff", "state"}
	OutboxFields   = append([]string{"stateEventVersion", "logicalOutboxId", "incarnationId", "sequence", "kind", "createdAt", "principal", "repairOperationId", "adapterVersion", "game"}, PayloadFields...)
	MetadataFields = []string{"eventVersion", "journalId", "sequence", "eventId", "type", "occurredAt", "runtimeInstanceId", "adapter", "adapterBindingEpoch", "principal", "logicalOutboxId", "recordSha256", "coreRepairOperationId", "attemptRef", "schemaVersion", "adapterVersion", "settlement", "acceptance", "acknowledgedAt", "compacted"}
)

var recordWarnings = map[string]bool{
	"pipeline-cache-degraded": true, "pipeline-bookkeeping-degraded": true, "pipeline-baseline-unreadable": true, "pipeline-guard-discarded": true,
	"pipeline-current-self-healed": true, "diff-exclude-path-unused": true, "pipeline-cleanup-degraded": true, "pipeline-reaper-discovery-limit-exceeded": true,
}

// checker accumulates the first failure so rule sequences read like the C# originals.
type checker struct{ err error }

func (c *checker) ok(err error) bool {
	if c.err == nil && err != nil {
		c.err = j.ErrInvalid
	}
	return c.err == nil
}

func (c *checker) require(condition bool) {
	if c.err == nil && !condition {
		c.err = j.ErrInvalid
	}
}

func (c *checker) property(v *j.Value, name string) *j.Value {
	p, err := j.Property(v, name)
	if !c.ok(err) {
		return &j.Value{Kind: j.Null}
	}
	return p
}

func (c *checker) fields(v *j.Value, fields ...string) { c.ok(j.Fields(v, fields...)) }

func (c *checker) text(v *j.Value) string {
	s, err := j.Text(v)
	c.ok(err)
	return s
}

func (c *checker) integer(v *j.Value, minimum, maximum int64) int64 {
	n, err := j.Integer(v, minimum, maximum)
	c.ok(err)
	return n
}

func (c *checker) anyInteger(v *j.Value) int64 {
	n, err := j.AnyInteger(v)
	c.ok(err)
	return n
}

func (c *checker) boolean(v *j.Value) bool {
	b, err := j.Boolean(v)
	c.ok(err)
	return b
}

func (c *checker) hex(v *j.Value, length int) string {
	s, err := j.Hex(v, length)
	c.ok(err)
	return s
}

func (c *checker) token(v *j.Value) string {
	s, err := j.Token(v)
	c.ok(err)
	return s
}

func (c *checker) utc(v *j.Value) string {
	s, err := j.Utc(v)
	c.ok(err)
	return s
}

func (c *checker) choice(v *j.Value, choices ...string) string {
	s, err := j.Choice(v, choices...)
	c.ok(err)
	return s
}

// ValidateOutbox validates a core outbox record; a nonzero expectedSequence must match.
func ValidateOutbox(root *j.Value, expectedSequence int64) error {
	c := &checker{}
	c.fields(root, OutboxFields...)
	c.require(c.anyInteger(c.property(root, "stateEventVersion")) == 1)
	incarnation := c.hex(c.property(root, "incarnationId"), 32)
	sequence := c.integer(c.property(root, "sequence"), 1, j.MaximumSequence)
	c.require(expectedSequence == 0 || sequence == expectedSequence)
	if c.err == nil {
		c.require(c.text(c.property(root, "logicalOutboxId")) == incarnation+"-"+itoa(sequence))
	}
	kind := c.choice(c.property(root, "kind"), "consumed", "snapshot", "resync")
	c.utc(c.property(root, "createdAt"))
	c.token(c.property(root, "principal"))
	c.repairToken(c.property(root, "repairOperationId"), kind == "resync")
	version := c.anyInteger(c.property(root, "adapterVersion"))
	game := c.text(c.property(root, "game"))
	if c.err != nil {
		return c.err
	}
	return validatePayload(root, kind, version, game)
}

// ValidateMetadata validates event metadata, and with fullEvent the binding and any retained payload.
func ValidateMetadata(root *j.Value, fullEvent bool) error {
	c := &checker{}
	compacted := c.boolean(c.property(root, "compacted"))
	if c.err != nil {
		return c.err
	}
	switch {
	case !fullEvent:
		c.fields(root, MetadataFields...)
	case compacted:
		c.fields(root, append(append([]string{}, MetadataFields...), "payloadBindingSha256")...)
	default:
		c.fields(root, append(append([]string{}, MetadataFields...), "payloadBindingSha256", "payload")...)
	}
	c.require(c.anyInteger(c.property(root, "eventVersion")) == 1)
	c.token(c.property(root, "journalId"))
	c.integer(c.property(root, "sequence"), 1, j.MaximumSequence)
	c.hex(c.property(root, "eventId"), 32)
	eventType := c.choice(c.property(root, "type"), "state.consumed", "state.snapshot", "state.resync")
	c.utc(c.property(root, "occurredAt"))
	c.hex(c.property(root, "runtimeInstanceId"), 32)
	c.hex(c.property(root, "adapterBindingEpoch"), 32)
	c.token(c.property(root, "principal"))
	game := c.text(c.property(root, "adapter"))
	if c.err == nil {
		_, err := j.LogicalSequence(c.property(root, "logicalOutboxId"))
		c.ok(err)
	}
	c.hex(c.property(root, "recordSha256"), 64)
	c.repairToken(c.property(root, "coreRepairOperationId"), eventType == "state.resync")
	association := c.property(root, "attemptRef")
	if c.err == nil && association.Kind != j.Null {
		c.require(eventType == "state.resync")
		c.fields(association, "operationId", "attemptOrdinal")
		operation := c.text(c.property(association, "operationId"))
		c.require(strings.HasPrefix(operation, "jr-") && j.IsHex(operation[min(3, len(operation)):], 32))
		c.integer(c.property(association, "attemptOrdinal"), 0, j.MaximumSequence)
	}
	schema := c.anyInteger(c.property(root, "schemaVersion"))
	adapter := c.anyInteger(c.property(root, "adapterVersion"))
	settlement := c.choice(c.property(root, "settlement"), "pending", "accepted", "unknown")
	acceptance := c.property(root, "acceptance")
	if c.err == nil && acceptance.Kind != j.Null {
		c.fields(acceptance, "journalId", "eventId", "generation")
		c.token(c.property(acceptance, "journalId"))
		c.token(c.property(acceptance, "eventId"))
		c.hex(c.property(acceptance, "generation"), 32)
	}
	c.require(settlement != "accepted" || acceptance.Kind != j.Null)
	acknowledged := c.property(root, "acknowledgedAt")
	if c.err == nil && acknowledged.Kind != j.Null {
		c.utc(acknowledged)
	}
	if c.err == nil && fullEvent {
		c.hex(c.property(root, "payloadBindingSha256"), 64)
		if c.err == nil && !compacted {
			payload := c.property(root, "payload")
			c.fields(payload, PayloadFields...)
			if c.err == nil {
				if err := validatePayload(payload, eventType[6:], adapter, game); err != nil {
					return err
				}
				c.require(c.anyInteger(c.property(c.property(payload, "state"), "schemaVersion")) == schema)
			}
		}
	}
	return c.err
}

// CorrelateSource requires creation metadata to describe its source record.
func CorrelateSource(source, metadata *j.Value) error {
	c := &checker{}
	c.require(c.text(c.property(metadata, "logicalOutboxId")) == c.text(c.property(source, "logicalOutboxId")))
	c.require(c.text(c.property(metadata, "type")) == "state."+c.text(c.property(source, "kind")))
	c.require(c.text(c.property(metadata, "principal")) == c.text(c.property(source, "principal")))
	c.require(c.text(c.property(metadata, "adapter")) == c.text(c.property(source, "game")))
	c.require(j.DeepEquals(c.property(metadata, "coreRepairOperationId"), c.property(source, "repairOperationId")))
	c.require(c.anyInteger(c.property(metadata, "adapterVersion")) == c.anyInteger(c.property(source, "adapterVersion")))
	c.require(c.anyInteger(c.property(metadata, "schemaVersion")) == c.anyInteger(c.property(c.property(source, "state"), "schemaVersion")))
	settlement := c.property(metadata, "settlement")
	c.require(settlement.Kind == j.String && settlement.Str == "pending" && c.property(metadata, "acceptance").Kind == j.Null)
	c.require(c.property(metadata, "acknowledgedAt").Kind == j.Null && !c.boolean(c.property(metadata, "compacted")))
	return c.err
}

// CorrelateRewrite requires rewrite metadata to keep the original's identity fields.
func CorrelateRewrite(original, metadata *j.Value) error {
	c := &checker{}
	for _, field := range []string{"type", "principal", "adapter", "logicalOutboxId", "recordSha256", "coreRepairOperationId", "schemaVersion", "adapterVersion"} {
		c.require(j.DeepEquals(c.property(original, field), c.property(metadata, field)))
	}
	reference := c.property(original, "attemptRef")
	c.require(reference.Kind == j.Null || j.DeepEquals(reference, c.property(metadata, "attemptRef")))
	acceptance := c.property(original, "acceptance")
	if c.err == nil && acceptance.Kind != j.Null {
		next := c.property(metadata, "acceptance")
		c.require(next.Kind == j.Object)
		for _, field := range []string{"journalId", "eventId"} {
			c.require(j.DeepEquals(c.property(acceptance, field), c.property(next, field)))
		}
	}
	return c.err
}

func validatePayload(root *j.Value, kind string, adapterVersion int64, game string) error {
	c := &checker{}
	baseline := c.property(root, "baseline")
	if c.err == nil && baseline.Kind != j.Null {
		c.fields(baseline, "generatedAt", "source")
		c.utc(c.property(baseline, "generatedAt"))
		c.source(c.property(baseline, "source"), true)
	}
	floor := c.property(root, "sourceFloor")
	c.source(floor, false)
	refresh := c.property(root, "refresh")
	c.fields(refresh, "attempted", "commitObserved", "attempts")
	attempts := c.integer(c.property(refresh, "attempts"), 0, 3)
	attempted := c.boolean(c.property(refresh, "attempted"))
	c.require(attempted == (attempts > 0) && (!c.boolean(c.property(refresh, "commitObserved")) || attempted))
	c.warnings(c.property(root, "warnings"))
	reset := c.boolean(c.property(root, "baselineReset"))
	state := c.property(root, "state")
	diff := c.property(root, "diff")
	source := c.property(state, "source")
	c.source(source, true)
	c.source(c.property(diff, "currentSource"), true)
	c.require(j.DeepEquals(source, c.property(diff, "currentSource")))
	generated := c.utc(c.property(state, "generatedAt"))
	c.require(c.utc(c.property(diff, "currentGeneratedAt")) == generated)
	c.require(c.anyInteger(c.property(state, "schemaVersion")) == c.anyInteger(c.property(diff, "schemaVersion")))
	c.require(c.anyInteger(c.property(state, "adapterVersion")) == adapterVersion && c.anyInteger(c.property(diff, "adapterVersion")) == adapterVersion)
	c.require(c.text(c.property(state, "game")) == game && c.text(c.property(diff, "game")) == game)
	c.require(c.text(c.property(floor, "domainId")) == c.text(c.property(source, "domainId")))
	if c.err != nil {
		return c.err
	}
	sourceSaved, floorSaved := c.utc(c.property(source, "savedAt")), c.utc(c.property(floor, "savedAt"))
	order := CompareOrdinal(sourceSaved, floorSaved)
	c.require(order > 0 || order == 0 && CompareOrdinal(c.text(c.property(source, "saveFile")), c.text(c.property(floor, "saveFile"))) >= 0)
	diffBaseline := c.property(diff, "baselineGeneratedAt")
	c.require(reset == (baseline.Kind == j.Null) && reset == (diffBaseline.Kind == j.Null))
	targetEqualsBaseline := false
	if c.err == nil && baseline.Kind != j.Null {
		baselineTime := c.utc(c.property(baseline, "generatedAt"))
		c.require(c.utc(diffBaseline) == baselineTime)
		targetEqualsBaseline = baselineTime == generated && j.DeepEquals(c.property(baseline, "source"), source)
	}
	if c.err != nil {
		return c.err
	}
	c.require(kind != "consumed" || !targetEqualsBaseline)
	if kind == "snapshot" {
		c.require(targetEqualsBaseline && !reset && c.emptyDiff(diff))
	}
	if kind == "resync" {
		c.require(reset && c.emptyDiff(diff))
	}
	return c.err
}

func (c *checker) source(v *j.Value, full bool) {
	if full {
		c.fields(v, "domainId", "saveFile", "savedAt", "byteLength", "contentSha256")
	} else {
		c.fields(v, "domainId", "saveFile", "savedAt")
	}
	c.hex(c.property(v, "domainId"), 64)
	name := c.text(c.property(v, "saveFile"))
	c.require(!strings.ContainsAny(name, `/\`))
	c.utc(c.property(v, "savedAt"))
	if full {
		c.integer(c.property(v, "byteLength"), 1, 1<<63-1)
		c.hex(c.property(v, "contentSha256"), 64)
	}
}

func (c *checker) repairToken(v *j.Value, resync bool) {
	if resync {
		c.token(v)
	} else {
		c.require(v.Kind == j.Null)
	}
}

func (c *checker) warnings(v *j.Value) {
	c.require(v.Kind == j.Array)
	if c.err != nil {
		return
	}
	previous := ""
	first := true
	for _, warning := range v.Items {
		c.fields(warning, "code", "detail")
		code := c.text(c.property(warning, "code"))
		detailValue := c.property(warning, "detail")
		var detail *string
		if detailValue.Kind != j.Null {
			text := c.text(detailValue)
			detail = &text
		}
		if c.err != nil {
			return
		}
		c.require(recordWarnings[code])
		switch code {
		case "pipeline-reaper-discovery-limit-exceeded":
			c.require(detail != nil && (*detail == "tmp" || *detail == "state"))
		case "diff-exclude-path-unused":
			c.require(detail != nil && strings.HasPrefix(*detail, "/"))
		default:
			c.require(detail == nil)
		}
		key := code + "\x00"
		if detail != nil {
			key += *detail
		}
		c.require(first || CompareOrdinal(previous, key) < 0)
		previous, first = key, false
	}
}

func (c *checker) emptyDiff(v *j.Value) bool {
	character := c.property(v, "character")
	inventory := c.property(v, "inventory")
	objectives := c.property(v, "objectives")
	if c.err != nil {
		return false
	}
	return !c.boolean(c.property(v, "hasChanges")) && !c.boolean(c.property(v, "hasUnrepresentedChanges")) && c.property(v, "sessionChange").Kind == j.Null &&
		j.IsEmptyArray(c.property(objectives, "added")) && j.IsEmptyArray(c.property(objectives, "removed")) && j.IsEmptyArray(c.property(objectives, "statusChanged")) &&
		c.anyInteger(c.property(character, "levelDelta")) == 0 && c.anyInteger(c.property(character, "xpDelta")) == 0 && j.IsDecimalZero(c.property(character, "moneyDelta")) &&
		j.IsEmptyArray(c.property(character, "skillChanges")) && j.IsEmptyArray(c.property(inventory, "gained")) && j.IsEmptyArray(c.property(inventory, "lost")) &&
		!c.boolean(c.property(inventory, "equippedChanged")) && j.IsEmptyArray(c.property(v, "extraChanges"))
}

func itoa(value int64) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	var digits [20]byte
	index := len(digits)
	for value != 0 {
		digit := value % 10
		if digit < 0 {
			digit = -digit
		}
		index--
		digits[index] = byte('0' + digit)
		value /= 10
	}
	if negative {
		index--
		digits[index] = '-'
	}
	return string(digits[index:])
}
