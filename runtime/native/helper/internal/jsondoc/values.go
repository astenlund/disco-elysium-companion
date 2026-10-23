package jsondoc

import (
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// MaximumSequence is the largest integer JavaScript represents exactly.
const MaximumSequence = 9007199254740991

// Require returns ErrInvalid unless condition holds.
func Require(condition bool) error {
	if !condition {
		return ErrInvalid
	}
	return nil
}

// Fields requires an object with exactly the named members.
func Fields(v *Value, fields ...string) error {
	if v == nil || v.Kind != Object || len(v.Members) != len(fields) {
		return ErrInvalid
	}
	for _, field := range fields {
		if v.Get(field) == nil {
			return ErrInvalid
		}
	}
	return nil
}

// Property returns a required member.
func Property(v *Value, name string) (*Value, error) {
	member := v.Get(name)
	if member == nil {
		return nil, ErrInvalid
	}
	return member, nil
}

// Text requires a non-empty string.
func Text(v *Value) (string, error) {
	if v == nil || v.Kind != String || v.Str == "" {
		return "", ErrInvalid
	}
	return v.Str, nil
}

// IsCanonicalInteger reports whether raw number text has the -?(0|[1-9][0-9]*) form.
func IsCanonicalInteger(raw []byte) bool {
	digits := raw
	if len(digits) > 0 && digits[0] == '-' {
		digits = digits[1:]
	}
	if len(digits) == 0 || digits[0] == '0' && len(digits) > 1 {
		return false
	}
	for _, c := range digits {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// Integer requires a canonical integer that fits a signed 64-bit value within [minimum, maximum].
func Integer(v *Value, minimum, maximum int64) (int64, error) {
	if v == nil || v.Kind != Number || !IsCanonicalInteger(v.Raw) {
		return 0, ErrInvalid
	}
	number, err := strconv.ParseInt(string(v.Raw), 10, 64)
	if err != nil || number < minimum || number > maximum {
		return 0, ErrInvalid
	}
	return number, nil
}

// AnyInteger is Integer without bounds beyond the signed 64-bit range.
func AnyInteger(v *Value) (int64, error) {
	return Integer(v, -1<<63, 1<<63-1)
}

// Boolean requires true or false.
func Boolean(v *Value) (bool, error) {
	if v == nil || v.Kind != True && v.Kind != False {
		return false, ErrInvalid
	}
	return v.Kind == True, nil
}

// IsHex reports lowercase hexadecimal of an exact length.
func IsHex(text string, length int) bool {
	if len(text) != length {
		return false
	}
	for index := 0; index < len(text); index++ {
		c := text[index]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// Hex requires lowercase hexadecimal text of an exact length.
func Hex(v *Value, length int) (string, error) {
	text, err := Text(v)
	if err != nil || !IsHex(text, length) {
		return "", ErrInvalid
	}
	return text, nil
}

// Token requires NFC text of at most 512 UTF-8 bytes and 128 characters, none of them C0 or C1 controls.
func Token(v *Value) (string, error) {
	text, err := Text(v)
	if err != nil || len(text) > 512 || !IsNormalizedNFC(text) {
		return "", ErrInvalid
	}
	count := 0
	for _, r := range text {
		if r <= 31 || r >= 128 && r <= 159 {
			return "", ErrInvalid
		}
		count++
	}
	if count > 128 {
		return "", ErrInvalid
	}
	return text, nil
}

// IsUtc reports text in the round-trip "o" form of a UTC DateTime: yyyy-MM-ddTHH:mm:ss.fffffffZ with a real date.
func IsUtc(text string) bool {
	if len(text) != 28 || text[4] != '-' || text[7] != '-' || text[10] != 'T' || text[13] != ':' || text[16] != ':' || text[19] != '.' || text[27] != 'Z' {
		return false
	}
	for _, index := range []int{0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22, 23, 24, 25, 26} {
		if text[index] < '0' || text[index] > '9' {
			return false
		}
	}
	number := func(from, to int) int {
		value, _ := strconv.Atoi(text[from:to])
		return value
	}
	year, month, day := number(0, 4), number(5, 7), number(8, 10)
	hour, minute, second := number(11, 13), number(14, 16), number(17, 19)
	if year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 {
		return false
	}
	return time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC).Day() == day
}

// Utc requires an admitted UTC timestamp string.
func Utc(v *Value) (string, error) {
	text, err := Text(v)
	if err != nil || !IsUtc(text) {
		return "", ErrInvalid
	}
	return text, nil
}

// Choice requires one of the given strings.
func Choice(v *Value, choices ...string) (string, error) {
	text, err := Text(v)
	if err != nil {
		return "", err
	}
	for _, choice := range choices {
		if text == choice {
			return text, nil
		}
	}
	return "", ErrInvalid
}

// LogicalSequence requires <32 hex>-<positive canonical decimal sequence>.
func LogicalSequence(v *Value) (int64, error) {
	text, err := Text(v)
	if err != nil || len(text) < 34 || text[32] != '-' || !IsHex(text[:32], 32) {
		return 0, ErrInvalid
	}
	suffix := text[33:]
	for index := 0; index < len(suffix); index++ {
		if suffix[index] < '0' || suffix[index] > '9' {
			return 0, ErrInvalid
		}
	}
	sequence, err := strconv.ParseInt(suffix, 10, 64)
	if err != nil || sequence <= 0 || sequence > MaximumSequence || strconv.FormatInt(sequence, 10) != suffix {
		return 0, ErrInvalid
	}
	return sequence, nil
}

// IsEmptyArray reports an array with no items.
func IsEmptyArray(v *Value) bool { return v != nil && v.Kind == Array && len(v.Items) == 0 }

// IsDecimalZero reports a number that System.Text.Json's TryGetDecimal reads as zero: a mathematical zero, or a value
// too small to keep a significant digit at the 28-digit decimal scale.
func IsDecimalZero(v *Value) bool {
	if v == nil || v.Kind != Number {
		return false
	}
	digits, exponent := numberParts(v.Raw)
	if digits == "" {
		return true
	}
	// value = 0.digits * 10^(exponent); decimal keeps 28 fractional digits and rounds half away from zero.
	if exponent < -28 {
		return true
	}
	if exponent == -28 {
		return digits[0] < '5'
	}
	return false
}

// numberParts returns the significant digits without leading or trailing zeros and the exponent e such that the
// absolute value is 0.digits * 10^e.
func numberParts(raw []byte) (string, int) {
	text := string(raw)
	text = strings.TrimPrefix(text, "-")
	exponent := 0
	if index := strings.IndexAny(text, "eE"); index >= 0 {
		value, err := strconv.Atoi(text[index+1:])
		if err != nil {
			// Out-of-range exponents are far from zero in either direction; treat a huge negative one as zero.
			if strings.HasPrefix(text[index+1:], "-") {
				return "", 0
			}
			value = 1 << 30
		}
		exponent = value
		text = text[:index]
	}
	integer, fraction, _ := strings.Cut(text, ".")
	digits := integer + fraction
	exponent += len(integer)
	trimmed := strings.TrimLeft(digits, "0")
	exponent -= len(digits) - len(trimmed)
	trimmed = strings.TrimRight(trimmed, "0")
	return trimmed, exponent
}

// DeepEquals compares two values the way System.Text.Json's JsonElement.DeepEquals does: numbers by mathematical
// value, strings by decoded text, arrays in order and objects as unordered sets of uniquely named members.
func DeepEquals(left, right *Value) bool {
	if left == nil || right == nil || left.Kind != right.Kind {
		return false
	}
	switch left.Kind {
	case Null, True, False:
		return true
	case String:
		return left.Str == right.Str
	case Number:
		leftDigits, leftExponent := numberParts(left.Raw)
		rightDigits, rightExponent := numberParts(right.Raw)
		if leftDigits == "" || rightDigits == "" {
			return leftDigits == rightDigits
		}
		leftNegative := len(left.Raw) > 0 && left.Raw[0] == '-'
		rightNegative := len(right.Raw) > 0 && right.Raw[0] == '-'
		return leftNegative == rightNegative && leftDigits == rightDigits && leftExponent == rightExponent
	case Array:
		if len(left.Items) != len(right.Items) {
			return false
		}
		for index := range left.Items {
			if !DeepEquals(left.Items[index], right.Items[index]) {
				return false
			}
		}
		return true
	case Object:
		if len(left.Members) != len(right.Members) {
			return false
		}
		for _, member := range left.Members {
			if !DeepEquals(member.Value, right.Get(member.Name)) {
				return false
			}
		}
		return true
	}
	return false
}

// RuneCount is the number of Unicode scalar values in text.
func RuneCount(text string) int { return utf8.RuneCountInString(text) }
