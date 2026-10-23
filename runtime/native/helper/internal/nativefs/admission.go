// Package nativefs reproduces the runtime's physical path admission: a local drive-qualified path is walked component
// by component through handles opened without following reparse points, and every object on the way must be an ordinary
// disk file or directory whose canonical spelling equals the admitted one. A file must have exactly one link.
package nativefs

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"
)

// ErrUnavailable marks an admission that failed; callers report their own failure class.
var ErrUnavailable = errors.New("path admission unavailable")

const (
	readAttributes       = 0x80
	shareReadWriteDelete = 7
	openExisting         = 3
	openReparsePoint     = 0x00200000
	backupSemantics      = 0x02000000
	directoryAttribute   = 0x10
	reparseAttribute     = 0x400
	diskFileType         = 1
	fileIDInfoClass      = 18
	maximumComponents    = 64
	maximumPathChars     = 32760
)

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procCreateFileW              = kernel32.NewProc("CreateFileW")
	procGetFileType              = kernel32.NewProc("GetFileType")
	procGetFileInformationByHnd  = kernel32.NewProc("GetFileInformationByHandle")
	procGetFileInformationByHndX = kernel32.NewProc("GetFileInformationByHandleEx")
	procGetFinalPathNameByHandle = kernel32.NewProc("GetFinalPathNameByHandleW")
	procGetFullPathNameW         = kernel32.NewProc("GetFullPathNameW")
)

// Admission describes one admitted path.
type Admission struct {
	Path        string
	Exists      bool
	IsDirectory bool
	Links       uint32
	Volume      string
	Identity    string
	Missing     []string
}

type fileInformation struct {
	Attributes uint32
	Created    syscall.Filetime
	Accessed   syscall.Filetime
	Written    syscall.Filetime
	Volume     uint32
	SizeHigh   uint32
	SizeLow    uint32
	Links      uint32
	IndexHigh  uint32
	IndexLow   uint32
}

type fileIdentity struct {
	Volume uint64
	Low    uint64
	High   uint64
}

// NormalizePath validates and canonicalizes a local drive-qualified path the way the C# NativeFiles.NormalizePath does.
func NormalizePath(candidate string) (string, error) {
	if !utf8.ValidString(candidate) {
		return "", ErrUnavailable
	}
	normalized := strings.ReplaceAll(candidate, "/", `\`)
	if utf16Length(normalized) < 3 || utf16Length(normalized) > maximumPathChars || !asciiLetter(normalized[0]) || normalized[1] != ':' || normalized[2] != '\\' {
		return "", ErrUnavailable
	}
	if len(normalized) > 3 {
		normalized = strings.TrimRight(normalized, `\`)
		if len(normalized) < 3 {
			normalized = normalized[:2] + `\`
		}
	}
	if len(normalized) > 3 {
		components := strings.Split(normalized[3:], `\`)
		if len(components) > maximumComponents {
			return "", ErrUnavailable
		}
		for _, component := range components {
			if invalidComponent(component) {
				return "", ErrUnavailable
			}
		}
	}
	return fullPath(normalized)
}

func utf16Length(text string) int { return len(utf16.Encode([]rune(text))) }

func asciiLetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

func invalidComponent(component string) bool {
	if component == "" || component == "." || component == ".." || strings.HasSuffix(component, " ") || strings.HasSuffix(component, ".") {
		return true
	}
	for _, r := range component {
		// Path.GetInvalidFileNameChars on Windows: control characters and " < > | : * ? \ /.
		if r < 32 || strings.ContainsRune("\"<>|:*?\\/", r) {
			return true
		}
	}
	return reservedName(component)
}

func reservedName(component string) bool {
	stem, _, _ := strings.Cut(component, ".")
	upper := strings.ToUpper(stem)
	switch upper {
	case "CON", "PRN", "AUX", "NUL":
		return true
	}
	runes := []rune(upper)
	if len(runes) == 4 && (strings.HasPrefix(upper, "COM") || strings.HasPrefix(upper, "LPT")) {
		last := runes[3]
		return last >= '1' && last <= '9' || last == '¹' || last == '²' || last == '³'
	}
	return false
}

// fullPath applies GetFullPathNameW, as System.IO.Path.GetFullPath does for an already-rooted path.
func fullPath(path string) (string, error) {
	input, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", ErrUnavailable
	}
	buffer := make([]uint16, maximumPathChars+8)
	length, _, _ := procGetFullPathNameW.Call(uintptr(unsafe.Pointer(input)), uintptr(len(buffer)), uintptr(unsafe.Pointer(&buffer[0])), 0)
	if length == 0 || int(length) >= len(buffer) {
		return "", ErrUnavailable
	}
	return string(utf16.Decode(buffer[:length])), nil
}

// AdmitWithin admits candidate under an admitted directory root, requiring that the textual root prefix of candidate
// names the same physical object as root.
func AdmitWithin(root, candidate string, allowMissing bool) (Admission, error) {
	admittedRoot, err := Admit(root, false)
	if err != nil {
		return Admission{}, err
	}
	if !admittedRoot.IsDirectory {
		return Admission{}, ErrUnavailable
	}
	full, err := NormalizePath(candidate)
	if err != nil {
		return Admission{}, err
	}
	rootPath, err := NormalizePath(root)
	if err != nil {
		return Admission{}, err
	}
	prefix := rootPath
	if !strings.HasSuffix(prefix, `\`) {
		prefix += `\`
	}
	if !EqualOrdinalIgnoreCase(full, rootPath) && !hasPrefixIgnoreCase(full, prefix) {
		return Admission{}, ErrUnavailable
	}
	actualRoot, err := Admit(runePrefix(full, utf8.RuneCountInString(rootPath)), false)
	if err != nil {
		return Admission{}, err
	}
	if actualRoot.Volume != admittedRoot.Volume || actualRoot.Identity != admittedRoot.Identity {
		return Admission{}, ErrUnavailable
	}
	return Admit(full, allowMissing)
}

// EqualOrdinalIgnoreCase compares like .NET StringComparison.OrdinalIgnoreCase: character by character after simple
// uppercase mapping, without the wider case folding strings.EqualFold applies.
func EqualOrdinalIgnoreCase(left, right string) bool {
	leftRunes, rightRunes := []rune(left), []rune(right)
	if len(leftRunes) != len(rightRunes) {
		return false
	}
	for index := range leftRunes {
		if leftRunes[index] != rightRunes[index] && unicode.ToUpper(leftRunes[index]) != unicode.ToUpper(rightRunes[index]) {
			return false
		}
	}
	return true
}

func hasPrefixIgnoreCase(text, prefix string) bool {
	count := utf8.RuneCountInString(prefix)
	return utf8.RuneCountInString(text) >= count && EqualOrdinalIgnoreCase(runePrefix(text, count), prefix)
}

func runePrefix(text string, count int) string {
	for index := range text {
		if count == 0 {
			return text[:index]
		}
		count--
	}
	return text
}

// Admit walks a path from its drive root.
func Admit(candidate string, allowMissing bool) (Admission, error) {
	full, err := NormalizePath(candidate)
	if err != nil {
		return Admission{}, err
	}
	current := full[:3]
	metadata, found, err := inspect(current)
	if err != nil {
		return Admission{}, err
	}
	if !found {
		return Admission{}, ErrUnavailable
	}
	if err := requireOrdinary(metadata); err != nil {
		return Admission{}, err
	}
	if len(full) == 3 {
		return metadata, nil
	}
	components := strings.Split(full[3:], `\`)
	for index, component := range components {
		if !metadata.IsDirectory {
			return Admission{}, ErrUnavailable
		}
		current = filepath.Join(current, component)
		next, found, err := inspect(current)
		if err != nil {
			return Admission{}, err
		}
		if !found {
			if !allowMissing {
				return Admission{}, ErrUnavailable
			}
			return Admission{Path: full, Missing: append([]string(nil), components[index:]...)}, nil
		}
		if err := requireOrdinary(next); err != nil {
			return Admission{}, err
		}
		metadata = next
	}
	return metadata, nil
}

func requireOrdinary(metadata Admission) error {
	if !metadata.IsDirectory && metadata.Links != 1 {
		return ErrUnavailable
	}
	return nil
}

// Open opens a path without following reparse points, with read-attributes access and full sharing.
func Open(path string, access uint32, share uint32) (syscall.Handle, error) {
	name, err := syscall.UTF16PtrFromString(`\\?\` + path)
	if err != nil {
		return syscall.InvalidHandle, ErrUnavailable
	}
	handle, _, callError := procCreateFileW.Call(uintptr(unsafe.Pointer(name)), uintptr(access), uintptr(share), 0, openExisting,
		openReparsePoint|backupSemantics, 0)
	if syscall.Handle(handle) == syscall.InvalidHandle {
		return syscall.InvalidHandle, callError
	}
	return syscall.Handle(handle), nil
}

func inspect(path string) (Admission, bool, error) {
	handle, err := Open(path, readAttributes, shareReadWriteDelete)
	if handle == syscall.InvalidHandle {
		if err == syscall.ERROR_FILE_NOT_FOUND || err == syscall.ERROR_PATH_NOT_FOUND {
			return Admission{}, false, nil
		}
		return Admission{}, false, ErrUnavailable
	}
	defer syscall.CloseHandle(handle)
	admission, err := DescribeHeld(handle, path)
	if err != nil {
		return Admission{}, false, err
	}
	return admission, true, nil
}

// DescribeHeld describes an open handle and requires its canonical path to equal expectedPath ignoring case.
func DescribeHeld(handle syscall.Handle, expectedPath string) (Admission, error) {
	path, err := NormalizePath(expectedPath)
	if err != nil {
		return Admission{}, err
	}
	kind, _, _ := procGetFileType.Call(uintptr(handle))
	if kind != diskFileType {
		return Admission{}, ErrUnavailable
	}
	var information fileInformation
	if ok, _, _ := procGetFileInformationByHnd.Call(uintptr(handle), uintptr(unsafe.Pointer(&information))); ok == 0 {
		return Admission{}, ErrUnavailable
	}
	if information.Attributes&reparseAttribute != 0 {
		return Admission{}, ErrUnavailable
	}
	var identity fileIdentity
	if ok, _, _ := procGetFileInformationByHndX.Call(uintptr(handle), fileIDInfoClass, uintptr(unsafe.Pointer(&identity)), unsafe.Sizeof(identity)); ok == 0 {
		return Admission{}, ErrUnavailable
	}
	if identity.Low == 0 && identity.High == 0 {
		return Admission{}, ErrUnavailable
	}
	buffer := make([]uint16, maximumPathChars+8)
	length, _, _ := procGetFinalPathNameByHandle.Call(uintptr(handle), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0)
	if length == 0 || int(length) >= len(buffer) {
		return Admission{}, ErrUnavailable
	}
	canonical := string(utf16.Decode(buffer[:length]))
	canonical = strings.TrimPrefix(canonical, `\\?\`)
	canonical, err = NormalizePath(canonical)
	if err != nil {
		return Admission{}, err
	}
	if !EqualOrdinalIgnoreCase(canonical, path) {
		return Admission{}, ErrUnavailable
	}
	return Admission{
		Path: canonical, Exists: true, IsDirectory: information.Attributes&directoryAttribute != 0, Links: information.Links,
		Volume: fmt.Sprintf("%016x", identity.Volume), Identity: fmt.Sprintf("%016x%016x", identity.Low, identity.High), Missing: []string{},
	}, nil
}
