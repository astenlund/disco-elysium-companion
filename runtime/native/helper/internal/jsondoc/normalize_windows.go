package jsondoc

import (
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	normaliz           = syscall.NewLazyDLL("normaliz.dll")
	isNormalizedString = normaliz.NewProc("IsNormalizedString")
)

const normalizationC = 1

// IsNormalizedNFC reports whether text is in Unicode normalization form C, using the Windows normalization API so the
// check needs no bundled Unicode tables. ASCII is always normalized; an API failure counts as not normalized.
func IsNormalizedNFC(text string) bool {
	ascii := true
	for index := 0; index < len(text); index++ {
		if text[index] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		return true
	}
	units := utf16.Encode([]rune(text))
	if len(units) == 0 {
		return true
	}
	result, _, _ := isNormalizedString.Call(normalizationC, uintptr(unsafe.Pointer(&units[0])), uintptr(len(units)))
	return result != 0
}
