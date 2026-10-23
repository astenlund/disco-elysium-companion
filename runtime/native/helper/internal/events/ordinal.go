package events

import "unicode/utf16"

// CompareOrdinal orders strings by UTF-16 code units, as .NET string.CompareOrdinal does. Byte order differs for
// characters above U+FFFF relative to those in U+E000 through U+FFFF.
func CompareOrdinal(left, right string) int {
	a, b := utf16.Encode([]rune(left)), utf16.Encode([]rune(right))
	for index := 0; index < len(a) && index < len(b); index++ {
		if a[index] != b[index] {
			if a[index] < b[index] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	}
	return 0
}
