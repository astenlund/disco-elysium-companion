package jsondoc

import "strconv"

const upperHex = "0123456789ABCDEF"

// AppendString appends a JSON string the way System.Text.Json's Utf8JsonWriter does with its default encoder: every
// non-ASCII character, every control character and the characters " & ' + < > ` and DEL become uppercase \u escapes,
// except that backspace, form feed, newline, carriage return and tab use their short forms and backslash becomes \\.
func AppendString(out []byte, text string) []byte {
	out = append(out, '"')
	for _, r := range text {
		switch {
		case r == '\b':
			out = append(out, '\\', 'b')
		case r == '\f':
			out = append(out, '\\', 'f')
		case r == '\n':
			out = append(out, '\\', 'n')
		case r == '\r':
			out = append(out, '\\', 'r')
		case r == '\t':
			out = append(out, '\\', 't')
		case r == '\\':
			out = append(out, '\\', '\\')
		case r < 0x20 || r >= 0x7f || r == '"' || r == '&' || r == '\'' || r == '+' || r == '<' || r == '>' || r == '`':
			if r > 0xffff {
				r -= 0x10000
				out = appendUnit(out, 0xd800+(r>>10))
				out = appendUnit(out, 0xdc00+(r&0x3ff))
			} else {
				out = appendUnit(out, r)
			}
		default:
			out = append(out, byte(r))
		}
	}
	return append(out, '"')
}

func appendUnit(out []byte, unit rune) []byte {
	return append(out, '\\', 'u', upperHex[unit>>12&15], upperHex[unit>>8&15], upperHex[unit>>4&15], upperHex[unit&15])
}

// ObjectWriter writes a compact JSON object the way Utf8JsonWriter does without indentation.
type ObjectWriter struct {
	out   []byte
	count int
}

// NewObject starts an object.
func NewObject() *ObjectWriter { return &ObjectWriter{out: []byte{'{'}} }

func (o *ObjectWriter) name(name string) {
	if o.count > 0 {
		o.out = append(o.out, ',')
	}
	o.count++
	o.out = AppendString(o.out, name)
	o.out = append(o.out, ':')
}

// Raw writes a member whose value is exact, already admitted JSON bytes.
func (o *ObjectWriter) Raw(name string, raw []byte) *ObjectWriter {
	o.name(name)
	o.out = append(o.out, raw...)
	return o
}

// String writes a string member.
func (o *ObjectWriter) String(name, value string) *ObjectWriter {
	o.name(name)
	o.out = AppendString(o.out, value)
	return o
}

// NullableString writes a string member, or null when value is nil.
func (o *ObjectWriter) NullableString(name string, value *string) *ObjectWriter {
	if value == nil {
		return o.Null(name)
	}
	return o.String(name, *value)
}

// Null writes a null member.
func (o *ObjectWriter) Null(name string) *ObjectWriter {
	o.name(name)
	o.out = append(o.out, "null"...)
	return o
}

// Bool writes a boolean member.
func (o *ObjectWriter) Bool(name string, value bool) *ObjectWriter {
	o.name(name)
	o.out = strconv.AppendBool(o.out, value)
	return o
}

// Int writes an integer member.
func (o *ObjectWriter) Int(name string, value int64) *ObjectWriter {
	o.name(name)
	o.out = strconv.AppendInt(o.out, value, 10)
	return o
}

// Bytes closes the object and returns its bytes.
func (o *ObjectWriter) Bytes() []byte {
	return append(o.out, '}')
}

// ArrayWriter writes a compact JSON array.
type ArrayWriter struct {
	out   []byte
	count int
}

// NewArray starts an array.
func NewArray() *ArrayWriter { return &ArrayWriter{out: []byte{'['}} }

func (a *ArrayWriter) next() {
	if a.count > 0 {
		a.out = append(a.out, ',')
	}
	a.count++
}

// Raw appends exact JSON bytes.
func (a *ArrayWriter) Raw(raw []byte) *ArrayWriter {
	a.next()
	a.out = append(a.out, raw...)
	return a
}

// String appends a string.
func (a *ArrayWriter) String(value string) *ArrayWriter {
	a.next()
	a.out = AppendString(a.out, value)
	return a
}

// NullableString appends a string or null.
func (a *ArrayWriter) NullableString(value *string) *ArrayWriter {
	a.next()
	if value == nil {
		a.out = append(a.out, "null"...)
	} else {
		a.out = AppendString(a.out, *value)
	}
	return a
}

// Bytes closes the array and returns its bytes.
func (a *ArrayWriter) Bytes() []byte {
	return append(a.out, ']')
}
