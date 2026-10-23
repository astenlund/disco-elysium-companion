// Package jsondoc reproduces the runtime's strict JSON admission and byte-preserving document model.
//
// Its rules follow the C# JsonDocuments and System.Text.Json behavior the runtime used before: strict UTF-8 without a
// byte-order mark, no comments or trailing commas, at most 64 levels of nesting, unique property names per object, and
// token, decoded-text and byte budgets per profile. Values keep their exact source bytes, so documents can be rewritten
// without re-encoding any nested value.
package jsondoc

import (
	"errors"
	"unicode/utf16"
	"unicode/utf8"
)

// ErrInvalid marks content that is not an admissible document. Callers classify it as document-invalid, never as an
// infrastructure failure.
var ErrInvalid = errors.New("document invalid")

// Budget bounds one document profile.
type Budget struct {
	Bytes     int
	Tokens    int64
	TextBytes int64
}

// Profiles used by the runtime.
var (
	Config     = Budget{Bytes: 1048576, Tokens: 65536, TextBytes: 524288}
	StateEvent = Budget{Bytes: 33554432, Tokens: 2000000, TextBytes: 16777216}
)

// ProfileBudget returns the named profile's budget.
func ProfileBudget(profile string) (Budget, bool) {
	switch profile {
	case "config":
		return Config, true
	case "state-event":
		return StateEvent, true
	}
	return Budget{}, false
}

const maxDepth = 64

// Kind is a JSON value kind.
type Kind int

const (
	Null Kind = iota
	False
	True
	Number
	String
	Array
	Object
)

// Member is one object property in source order.
type Member struct {
	Name  string
	Value *Value
}

// Value is a parsed JSON value that keeps its exact source bytes.
type Value struct {
	Kind    Kind
	Start   int
	Raw     []byte
	Str     string
	Members []Member
	Items   []*Value
}

// Validate applies the strict admission rules of the named budget.
func Validate(data []byte, budget Budget) error {
	_, err := parse(data, budget, false)
	return err
}

// ValidateProfile applies the strict admission rules of a named profile.
func ValidateProfile(data []byte, profile string) error {
	budget, ok := ProfileBudget(profile)
	if !ok {
		return ErrInvalid
	}
	return Validate(data, budget)
}

// Parse admits a document under the given budget and returns its value tree.
func Parse(data []byte, budget Budget) (*Value, error) {
	return parse(data, budget, true)
}

func parse(data []byte, budget Budget, build bool) (*Value, error) {
	if len(data) > budget.Bytes || len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf {
		return nil, ErrInvalid
	}
	if !utf8.Valid(data) {
		return nil, ErrInvalid
	}
	p := &parser{data: data, budget: budget, build: build}
	p.skipSpace()
	if p.pos >= len(p.data) {
		return nil, ErrInvalid
	}
	value, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.skipSpace()
	if p.pos != len(p.data) {
		return nil, ErrInvalid
	}
	return value, nil
}

type parser struct {
	data      []byte
	pos       int
	tokens    int64
	textBytes int64
	budget    Budget
	build     bool
}

func (p *parser) token() error {
	p.tokens++
	if p.tokens > p.budget.Tokens {
		return ErrInvalid
	}
	return nil
}

func (p *parser) skipSpace() {
	for p.pos < len(p.data) {
		switch p.data[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *parser) value(depth int) (*Value, error) {
	if p.pos >= len(p.data) {
		return nil, ErrInvalid
	}
	start := p.pos
	switch c := p.data[p.pos]; {
	case c == '{':
		return p.object(depth, start)
	case c == '[':
		return p.array(depth, start)
	case c == '"':
		if err := p.token(); err != nil {
			return nil, err
		}
		text, err := p.stringToken()
		if err != nil {
			return nil, err
		}
		return &Value{Kind: String, Start: start, Raw: p.data[start:p.pos], Str: text}, nil
	case c == '-' || c >= '0' && c <= '9':
		if err := p.token(); err != nil {
			return nil, err
		}
		if err := p.number(); err != nil {
			return nil, err
		}
		return &Value{Kind: Number, Start: start, Raw: p.data[start:p.pos]}, nil
	default:
		for _, literal := range []struct {
			text string
			kind Kind
		}{{"true", True}, {"false", False}, {"null", Null}} {
			if len(p.data)-p.pos >= len(literal.text) && string(p.data[p.pos:p.pos+len(literal.text)]) == literal.text {
				if err := p.token(); err != nil {
					return nil, err
				}
				p.pos += len(literal.text)
				return &Value{Kind: literal.kind, Start: start, Raw: p.data[start:p.pos]}, nil
			}
		}
		return nil, ErrInvalid
	}
}

func (p *parser) object(depth, start int) (*Value, error) {
	if depth >= maxDepth {
		return nil, ErrInvalid
	}
	if err := p.token(); err != nil {
		return nil, err
	}
	p.pos++
	result := &Value{Kind: Object, Start: start}
	names := make(map[string]struct{})
	p.skipSpace()
	if p.pos < len(p.data) && p.data[p.pos] == '}' {
		p.pos++
		if err := p.token(); err != nil {
			return nil, err
		}
		result.Raw = p.data[start:p.pos]
		return result, nil
	}
	for {
		p.skipSpace()
		if p.pos >= len(p.data) || p.data[p.pos] != '"' {
			return nil, ErrInvalid
		}
		if err := p.token(); err != nil {
			return nil, err
		}
		name, err := p.stringToken()
		if err != nil {
			return nil, err
		}
		if _, exists := names[name]; exists {
			return nil, ErrInvalid
		}
		names[name] = struct{}{}
		p.skipSpace()
		if p.pos >= len(p.data) || p.data[p.pos] != ':' {
			return nil, ErrInvalid
		}
		p.pos++
		p.skipSpace()
		member, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		if p.build {
			result.Members = append(result.Members, Member{Name: name, Value: member})
		}
		p.skipSpace()
		if p.pos >= len(p.data) {
			return nil, ErrInvalid
		}
		if p.data[p.pos] == ',' {
			p.pos++
			continue
		}
		if p.data[p.pos] != '}' {
			return nil, ErrInvalid
		}
		p.pos++
		if err := p.token(); err != nil {
			return nil, err
		}
		result.Raw = p.data[start:p.pos]
		return result, nil
	}
}

func (p *parser) array(depth, start int) (*Value, error) {
	if depth >= maxDepth {
		return nil, ErrInvalid
	}
	if err := p.token(); err != nil {
		return nil, err
	}
	p.pos++
	result := &Value{Kind: Array, Start: start}
	p.skipSpace()
	if p.pos < len(p.data) && p.data[p.pos] == ']' {
		p.pos++
		if err := p.token(); err != nil {
			return nil, err
		}
		result.Raw = p.data[start:p.pos]
		return result, nil
	}
	for {
		p.skipSpace()
		item, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		if p.build {
			result.Items = append(result.Items, item)
		}
		p.skipSpace()
		if p.pos >= len(p.data) {
			return nil, ErrInvalid
		}
		if p.data[p.pos] == ',' {
			p.pos++
			continue
		}
		if p.data[p.pos] != ']' {
			return nil, ErrInvalid
		}
		p.pos++
		if err := p.token(); err != nil {
			return nil, err
		}
		result.Raw = p.data[start:p.pos]
		return result, nil
	}
}

func (p *parser) number() error {
	data := p.data
	i := p.pos
	if i < len(data) && data[i] == '-' {
		i++
	}
	if i >= len(data) {
		return ErrInvalid
	}
	if data[i] == '0' {
		i++
	} else if data[i] >= '1' && data[i] <= '9' {
		for i < len(data) && data[i] >= '0' && data[i] <= '9' {
			i++
		}
	} else {
		return ErrInvalid
	}
	if i < len(data) && data[i] == '.' {
		i++
		digits := i
		for i < len(data) && data[i] >= '0' && data[i] <= '9' {
			i++
		}
		if i == digits {
			return ErrInvalid
		}
	}
	if i < len(data) && (data[i] == 'e' || data[i] == 'E') {
		i++
		if i < len(data) && (data[i] == '+' || data[i] == '-') {
			i++
		}
		digits := i
		for i < len(data) && data[i] >= '0' && data[i] <= '9' {
			i++
		}
		if i == digits {
			return ErrInvalid
		}
	}
	if i < len(data) && !delimiter(data[i]) {
		return ErrInvalid
	}
	p.pos = i
	return nil
}

func delimiter(c byte) bool {
	switch c {
	case ' ', '\t', '\n', '\r', ',', ']', '}':
		return true
	}
	return false
}

// stringToken reads a string starting at the opening quote, returns its decoded text and charges its UTF-8 length.
func (p *parser) stringToken() (string, error) {
	p.pos++
	var decoded []byte
	segment := p.pos
	escaped := false
	for {
		if p.pos >= len(p.data) {
			return "", ErrInvalid
		}
		c := p.data[p.pos]
		switch {
		case c == '"':
			if escaped {
				decoded = append(decoded, p.data[segment:p.pos]...)
			} else {
				decoded = p.data[segment:p.pos]
			}
			p.pos++
			p.textBytes += int64(len(decoded))
			if p.textBytes > p.budget.TextBytes {
				return "", ErrInvalid
			}
			return string(decoded), nil
		case c < 0x20:
			return "", ErrInvalid
		case c == '\\':
			if !escaped {
				decoded = make([]byte, 0, p.pos-segment+16)
				escaped = true
			}
			decoded = append(decoded, p.data[segment:p.pos]...)
			p.pos++
			if p.pos >= len(p.data) {
				return "", ErrInvalid
			}
			switch p.data[p.pos] {
			case '"':
				decoded = append(decoded, '"')
			case '\\':
				decoded = append(decoded, '\\')
			case '/':
				decoded = append(decoded, '/')
			case 'b':
				decoded = append(decoded, '\b')
			case 'f':
				decoded = append(decoded, '\f')
			case 'n':
				decoded = append(decoded, '\n')
			case 'r':
				decoded = append(decoded, '\r')
			case 't':
				decoded = append(decoded, '\t')
			case 'u':
				unit, ok := hex4(p.data, p.pos+1)
				if !ok {
					return "", ErrInvalid
				}
				p.pos += 4
				r := rune(unit)
				if utf16.IsSurrogate(r) {
					// System.Text.Json refuses to materialize a string holding an unpaired surrogate.
					if unit >= 0xdc00 || p.pos+6 >= len(p.data) || p.data[p.pos+1] != '\\' || p.data[p.pos+2] != 'u' {
						return "", ErrInvalid
					}
					low, ok := hex4(p.data, p.pos+3)
					if !ok || low < 0xdc00 || low > 0xdfff {
						return "", ErrInvalid
					}
					p.pos += 6
					r = utf16.DecodeRune(r, rune(low))
				}
				decoded = utf8.AppendRune(decoded, r)
			default:
				return "", ErrInvalid
			}
			p.pos++
			segment = p.pos
		default:
			p.pos++
		}
	}
}

func hex4(data []byte, at int) (uint16, bool) {
	if at+4 > len(data) {
		return 0, false
	}
	var value uint16
	for _, c := range data[at : at+4] {
		value <<= 4
		switch {
		case c >= '0' && c <= '9':
			value |= uint16(c - '0')
		case c >= 'a' && c <= 'f':
			value |= uint16(c-'a') + 10
		case c >= 'A' && c <= 'F':
			value |= uint16(c-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}

// Get returns the named member, or nil.
func (v *Value) Get(name string) *Value {
	if v == nil || v.Kind != Object {
		return nil
	}
	for _, member := range v.Members {
		if member.Name == name {
			return member.Value
		}
	}
	return nil
}
