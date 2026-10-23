package context

import (
	"crypto/sha256"
	"encoding/hex"
	"hash"
	"sort"
	"strconv"
	"strings"

	"companion-helper/internal/events"
	j "companion-helper/internal/jsondoc"
)

type scope int

const (
	scopeOther scope = iota
	scopeContext
	scopeFreshness
	scopeEvents
	scopeEvent
	scopeDiff
	scopeState
)

// Fingerprint is the semantic digest of a context's JSON, ignoring per-interaction identities and timestamps.
func Fingerprint(contextJSON []byte, instructions, provider string) (string, error) {
	root, err := j.Parse(contextJSON, j.StateEvent)
	if err != nil {
		return "", err
	}
	if !j.IsHex(instructions, 64) || !j.IsHex(provider, 64) {
		return "", j.ErrInvalid
	}
	digest := sha256.New()
	atom(digest, 'v', "companion-context-semantic-v1")
	atom(digest, 'i', instructions)
	atom(digest, 'p', provider)
	appendValue(digest, root, scopeContext)
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func atom(digest hash.Hash, kind byte, value string) {
	digest.Write([]byte{kind})
	digest.Write([]byte(strconv.Itoa(len(value))))
	digest.Write([]byte{':'})
	digest.Write([]byte(value))
}

func omitted(s scope, name string) bool {
	switch s {
	case scopeContext:
		return name == "interactionId" || name == "requestReceivedAt"
	case scopeFreshness:
		return name == "lastGoodGeneratedAt"
	case scopeEvent:
		return name == "eventId" || name == "sequence" || name == "redelivery"
	case scopeDiff:
		return name == "baselineGeneratedAt" || name == "currentGeneratedAt" || name == "currentSource"
	case scopeState:
		return name == "generatedAt" || name == "source"
	}
	return false
}

func child(s scope, name string) scope {
	switch {
	case s == scopeContext && name == "freshness":
		return scopeFreshness
	case s == scopeContext && name == "events":
		return scopeEvents
	case s == scopeContext && name == "state":
		return scopeState
	case s == scopeEvent && name == "diff":
		return scopeDiff
	}
	return scopeOther
}

func appendValue(digest hash.Hash, value *j.Value, s scope) {
	switch value.Kind {
	case j.Object:
		members := make([]j.Member, 0, len(value.Members))
		for _, member := range value.Members {
			if !omitted(s, member.Name) {
				members = append(members, member)
			}
		}
		sort.SliceStable(members, func(a, b int) bool { return events.CompareOrdinal(members[a].Name, members[b].Name) < 0 })
		atom(digest, 'o', strconv.Itoa(len(members)))
		for _, member := range members {
			atom(digest, 'k', member.Name)
			appendValue(digest, member.Value, child(s, member.Name))
		}
	case j.Array:
		atom(digest, 'a', strconv.Itoa(len(value.Items)))
		next := scopeOther
		if s == scopeEvents {
			next = scopeEvent
		}
		for _, item := range value.Items {
			appendValue(digest, item, next)
		}
	case j.String:
		atom(digest, 's', value.Str)
	case j.Number:
		atom(digest, 'n', normalizeNumber(string(value.Raw)))
	case j.True:
		atom(digest, 'b', "true")
	case j.False:
		atom(digest, 'b', "false")
	case j.Null:
		atom(digest, 'z', "")
	}
}

// normalizeNumber renders a JSON number as [-]digits e exponent with no leading or trailing zeros in digits, using
// decimal string arithmetic so no value is converted to floating point or expanded.
func normalizeNumber(raw string) string {
	negative := raw[0] == '-'
	exponentAt := strings.IndexAny(raw, "eE")
	start := 0
	if negative {
		start = 1
	}
	end := len(raw)
	exponent := "0"
	if exponentAt >= 0 {
		end = exponentAt
		exponent = raw[exponentAt+1:]
	}
	coefficient := raw[start:end]
	fraction := 0
	if decimalAt := strings.IndexByte(coefficient, '.'); decimalAt >= 0 {
		fraction = len(coefficient) - decimalAt - 1
	}
	digits := strings.TrimLeft(strings.ReplaceAll(coefficient, ".", ""), "0")
	if digits == "" {
		return "0"
	}
	trailing := 0
	for digits[len(digits)-trailing-1] == '0' {
		trailing++
	}
	digits = digits[:len(digits)-trailing]
	sign := ""
	if negative {
		sign = "-"
	}
	return sign + digits + "e" + addExponent(exponent, trailing-fraction)
}

func addExponent(exponent string, offset int) string {
	negative := exponent[0] == '-'
	magnitude := exponent
	if exponent[0] == '-' || exponent[0] == '+' {
		magnitude = exponent[1:]
	}
	magnitude = strings.TrimLeft(magnitude, "0")
	if magnitude == "" {
		return strconv.Itoa(offset)
	}
	sign := func(on bool) string {
		if on {
			return "-"
		}
		return ""
	}
	if offset == 0 {
		return sign(negative) + magnitude
	}
	absolute := offset
	if absolute < 0 {
		absolute = -absolute
	}
	adjustment := strconv.Itoa(absolute)
	if negative == (offset < 0) {
		return sign(negative) + addMagnitude(magnitude, adjustment)
	}
	comparison := 0
	switch {
	case len(magnitude) != len(adjustment):
		if len(magnitude) > len(adjustment) {
			comparison = 1
		} else {
			comparison = -1
		}
	default:
		comparison = strings.Compare(magnitude, adjustment)
	}
	if comparison == 0 {
		return "0"
	}
	if comparison > 0 {
		return sign(negative) + subtractMagnitude(magnitude, adjustment)
	}
	return sign(offset < 0) + subtractMagnitude(adjustment, magnitude)
}

func addMagnitude(left, right string) string {
	output := make([]byte, max(len(left), len(right))+1)
	carry := 0
	for position := range output {
		a, b := 0, 0
		if position < len(left) {
			a = int(left[len(left)-position-1] - '0')
		}
		if position < len(right) {
			b = int(right[len(right)-position-1] - '0')
		}
		value := a + b + carry
		output[len(output)-position-1] = byte('0' + value%10)
		carry = value / 10
	}
	return strings.TrimLeft(string(output), "0")
}

func subtractMagnitude(left, right string) string {
	output := make([]byte, len(left))
	borrow := 0
	for position := range output {
		a := int(left[len(left)-position-1] - '0')
		b := 0
		if position < len(right) {
			b = int(right[len(right)-position-1] - '0')
		}
		value := a - b - borrow
		borrow = 0
		if value < 0 {
			borrow = 1
			value += 10
		}
		output[len(output)-position-1] = byte('0' + value)
	}
	return strings.TrimLeft(string(output), "0")
}
