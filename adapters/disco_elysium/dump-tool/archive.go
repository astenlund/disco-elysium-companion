package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

const (
	centralDirectorySignature = 0x02014b50
	eocdSignature             = 0x06054b50
	zip64EOCDSignature        = 0x06064b50
	zip64LocatorSignature     = 0x07064b50
	zip64ExtraID              = 0x0001
)

var openZipReader = zip.OpenReader

type memberKind int

const (
	headerMember memberKind = iota
	worldMember
	tlvMember
	statesMember
)

var requiredSuffixes = [...]string{
	headerMember: ".1st.ntwtf.json",
	worldMember:  ".2nd.ntwtf.json",
	tlvMember:    ".ntwtf.lua",
	statesMember: ".states.lua",
}

type directoryEntry struct {
	name             string
	flags            uint16
	method           uint16
	compressedSize   uint64
	uncompressedSize uint64
}

type archiveManifest struct {
	entries  []directoryEntry
	required [len(requiredSuffixes)]int
	size     int64
}

type archiveMembers struct {
	header []byte
	world  []byte
	tlv    []byte
	states []byte
}

type archiveContents struct {
	members       archiveMembers
	entries       []string
	byteLength    int64
	contentSHA256 string
}

type directoryMetadata struct {
	count  uint64
	size   uint64
	offset uint64
}

func readAt(file *os.File, offset int64, size int) ([]byte, error) {
	buffer := make([]byte, size)
	if _, err := file.ReadAt(buffer, offset); err != nil {
		return nil, err
	}

	return buffer, nil
}

func locateDirectory(file *os.File, size int64) (directoryMetadata, error) {
	searchSize := int64(65_535 + 22)
	if size < searchSize {
		searchSize = size
	}
	tail, err := readAt(file, size-searchSize, int(searchSize))
	if err != nil {
		return directoryMetadata{}, fmt.Errorf("read-eocd")
	}
	eocdIndex := -1
	for index := len(tail) - 22; index >= 0; index-- {
		if binary.LittleEndian.Uint32(tail[index:index+4]) != eocdSignature {
			continue
		}
		commentLength := int(binary.LittleEndian.Uint16(tail[index+20 : index+22]))
		if index+22+commentLength == len(tail) {
			eocdIndex = index
			break
		}
	}
	if eocdIndex < 0 {
		return directoryMetadata{}, fmt.Errorf("missing-eocd")
	}
	eocd := tail[eocdIndex : eocdIndex+22]
	eocdOffset := size - searchSize + int64(eocdIndex)
	disk := binary.LittleEndian.Uint16(eocd[4:6])
	directoryDisk := binary.LittleEndian.Uint16(eocd[6:8])
	diskCount := binary.LittleEndian.Uint16(eocd[8:10])
	totalCount := binary.LittleEndian.Uint16(eocd[10:12])
	directorySize := binary.LittleEndian.Uint32(eocd[12:16])
	directoryOffset := binary.LittleEndian.Uint32(eocd[16:20])
	usesZip64 := disk == 0xffff || directoryDisk == 0xffff || diskCount == 0xffff || totalCount == 0xffff || directorySize == 0xffffffff || directoryOffset == 0xffffffff
	if !usesZip64 {
		if disk != 0 || directoryDisk != 0 || diskCount != totalCount {
			return directoryMetadata{}, fmt.Errorf("multi-disk-archive")
		}

		return directoryMetadata{count: uint64(totalCount), size: uint64(directorySize), offset: uint64(directoryOffset)}, nil
	}
	if eocdOffset < 20 {
		return directoryMetadata{}, fmt.Errorf("missing-zip64-locator")
	}
	locator, err := readAt(file, eocdOffset-20, 20)
	if err != nil || binary.LittleEndian.Uint32(locator[0:4]) != zip64LocatorSignature {
		return directoryMetadata{}, fmt.Errorf("missing-zip64-locator")
	}
	if binary.LittleEndian.Uint32(locator[4:8]) != 0 || binary.LittleEndian.Uint32(locator[16:20]) != 1 {
		return directoryMetadata{}, fmt.Errorf("multi-disk-archive")
	}
	zip64Offset := binary.LittleEndian.Uint64(locator[8:16])
	locatorOffset := uint64(eocdOffset - 20)
	if zip64Offset > locatorOffset {
		return directoryMetadata{}, fmt.Errorf("invalid-zip64-record-range")
	}
	recordSpan := locatorOffset - zip64Offset
	if recordSpan < 56 || zip64Offset > uint64(size) || uint64(size)-zip64Offset < 56 {
		return directoryMetadata{}, fmt.Errorf("invalid-zip64-record-range")
	}
	record, err := readAt(file, int64(zip64Offset), 56)
	if err != nil || binary.LittleEndian.Uint32(record[0:4]) != zip64EOCDSignature {
		return directoryMetadata{}, fmt.Errorf("invalid-zip64-record")
	}
	recordSize := binary.LittleEndian.Uint64(record[4:12])
	if recordSize < 44 || recordSize > uint64(size)-zip64Offset-12 || recordSize != recordSpan-12 {
		return directoryMetadata{}, fmt.Errorf("invalid-zip64-record-range")
	}
	zip64Disk := binary.LittleEndian.Uint32(record[16:20])
	zip64DirectoryDisk := binary.LittleEndian.Uint32(record[20:24])
	zip64DiskCount := binary.LittleEndian.Uint64(record[24:32])
	zip64TotalCount := binary.LittleEndian.Uint64(record[32:40])
	zip64DirectorySize := binary.LittleEndian.Uint64(record[40:48])
	zip64DirectoryOffset := binary.LittleEndian.Uint64(record[48:56])
	if zip64Disk != 0 || zip64DirectoryDisk != 0 || zip64DiskCount != zip64TotalCount {
		return directoryMetadata{}, fmt.Errorf("multi-disk-archive")
	}
	if disk != 0xffff && uint64(disk) != uint64(zip64Disk) || directoryDisk != 0xffff && uint64(directoryDisk) != uint64(zip64DirectoryDisk) || diskCount != 0xffff && uint64(diskCount) != zip64DiskCount || totalCount != 0xffff && uint64(totalCount) != zip64TotalCount || directorySize != 0xffffffff && uint64(directorySize) != zip64DirectorySize || directoryOffset != 0xffffffff && uint64(directoryOffset) != zip64DirectoryOffset {
		return directoryMetadata{}, fmt.Errorf("contradictory-zip64-metadata")
	}

	return directoryMetadata{
		count:  zip64TotalCount,
		size:   zip64DirectorySize,
		offset: zip64DirectoryOffset,
	}, nil
}

func parseZip64Sizes(extra []byte, compressed uint64, uncompressed uint64) (uint64, uint64, error) {
	needsUncompressed := uncompressed == 0xffffffff
	needsCompressed := compressed == 0xffffffff
	if !needsUncompressed && !needsCompressed {
		return compressed, uncompressed, nil
	}
	for len(extra) >= 4 {
		fieldID := binary.LittleEndian.Uint16(extra[0:2])
		fieldLength := int(binary.LittleEndian.Uint16(extra[2:4]))
		extra = extra[4:]
		if fieldLength > len(extra) {
			return 0, 0, fmt.Errorf("invalid-extra-field")
		}
		if fieldID == zip64ExtraID {
			field := extra[:fieldLength]
			if needsUncompressed {
				if len(field) < 8 {
					return 0, 0, fmt.Errorf("truncated-zip64-extra")
				}
				uncompressed = binary.LittleEndian.Uint64(field[:8])
				field = field[8:]
			}
			if needsCompressed {
				if len(field) < 8 {
					return 0, 0, fmt.Errorf("truncated-zip64-extra")
				}
				compressed = binary.LittleEndian.Uint64(field[:8])
			}

			return compressed, uncompressed, nil
		}
		extra = extra[fieldLength:]
	}

	return 0, 0, fmt.Errorf("missing-zip64-extra")
}

func preflightArchive(path string) (*archiveManifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open-archive: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat-archive: %w", err)
	}
	if info.Size() > maxArchiveBytes {
		return nil, fmt.Errorf("archive-bytes-exceeded")
	}
	if info.Size() < 22 {
		return nil, fmt.Errorf("missing-eocd")
	}
	metadata, err := locateDirectory(file, info.Size())
	if err != nil {
		return nil, err
	}
	if metadata.count > maxDirectoryRecords {
		return nil, fmt.Errorf("directory-records-exceeded")
	}
	if metadata.size > uint64(maxDirectoryBytes) {
		return nil, fmt.Errorf("directory-bytes-exceeded")
	}
	if metadata.offset > uint64(info.Size()) || metadata.size > uint64(info.Size())-metadata.offset {
		return nil, fmt.Errorf("directory-range-out-of-bounds")
	}
	directoryEnd := metadata.offset + metadata.size
	offset := metadata.offset
	manifest := &archiveManifest{size: info.Size()}
	for index := range manifest.required {
		manifest.required[index] = -1
	}
	var retainedNameBytes int64
	for record := uint64(0); record < metadata.count; record++ {
		if offset > directoryEnd || directoryEnd-offset < 46 {
			return nil, fmt.Errorf("central-directory-header-overrun")
		}
		header, err := readAt(file, int64(offset), 46)
		if err != nil || binary.LittleEndian.Uint32(header[0:4]) != centralDirectorySignature {
			return nil, fmt.Errorf("invalid-central-directory-header")
		}
		nameLength := uint64(binary.LittleEndian.Uint16(header[28:30]))
		extraLength := uint64(binary.LittleEndian.Uint16(header[30:32]))
		commentLength := uint64(binary.LittleEndian.Uint16(header[32:34]))
		variableLength := nameLength + extraLength + commentLength
		if variableLength > directoryEnd-offset-46 {
			return nil, fmt.Errorf("central-directory-header-overrun")
		}
		variable, err := readAt(file, int64(offset+46), int(variableLength))
		if err != nil {
			return nil, fmt.Errorf("read-central-directory-entry")
		}
		nameBytes := variable[:nameLength]
		if !utf8.Valid(nameBytes) {
			return nil, fmt.Errorf("invalid-entry-name-utf8")
		}
		name := string(nameBytes)
		if strings.Contains(name, "\\") {
			return nil, fmt.Errorf("backslash-entry-name")
		}
		retainedNameBytes += int64(nameLength)
		if retainedNameBytes > maxRetainedNameBytes {
			return nil, fmt.Errorf("retained-name-bytes-exceeded")
		}
		compressed, uncompressed, err := parseZip64Sizes(variable[nameLength:nameLength+extraLength], uint64(binary.LittleEndian.Uint32(header[20:24])), uint64(binary.LittleEndian.Uint32(header[24:28])))
		if err != nil {
			return nil, err
		}
		entry := directoryEntry{name: name, flags: binary.LittleEndian.Uint16(header[8:10]), method: binary.LittleEndian.Uint16(header[10:12]), compressedSize: compressed, uncompressedSize: uncompressed}
		manifest.entries = append(manifest.entries, entry)
		for kind, suffix := range requiredSuffixes {
			if strings.HasSuffix(name, suffix) {
				if manifest.required[kind] >= 0 {
					return nil, fmt.Errorf("duplicate-required-member")
				}
				if entry.flags&1 != 0 {
					return nil, fmt.Errorf("encrypted-required-member")
				}
				if entry.method != zip.Store && entry.method != zip.Deflate {
					return nil, fmt.Errorf("unsupported-required-compression")
				}
				if entry.uncompressedSize > uint64(maxRequiredMemberBytes) {
					return nil, fmt.Errorf("required-member-bytes-exceeded")
				}
				manifest.required[kind] = len(manifest.entries) - 1
			}
		}
		offset += 46 + variableLength
	}
	if offset != directoryEnd {
		return nil, fmt.Errorf("central-directory-end-mismatch")
	}
	var prefix string
	for kind, entryIndex := range manifest.required {
		if entryIndex < 0 {
			return nil, fmt.Errorf("missing-required-member")
		}
		candidate := strings.TrimSuffix(manifest.entries[entryIndex].name, requiredSuffixes[kind])
		if candidate == "" {
			return nil, fmt.Errorf("empty-logical-prefix")
		}
		finalSlash := strings.LastIndexByte(candidate, '/')
		if finalSlash == len(candidate)-1 {
			return nil, fmt.Errorf("empty-logical-prefix-component")
		}
		if memberKind(kind) == headerMember {
			prefix = candidate
		} else if candidate != prefix {
			return nil, fmt.Errorf("mixed-logical-prefixes")
		}
	}

	return manifest, nil
}

func readRequiredMember(file *zip.File) ([]byte, error) {
	if file.Flags&1 != 0 {
		return nil, fmt.Errorf("encrypted-required-member")
	}
	if file.Method != zip.Store && file.Method != zip.Deflate {
		return nil, fmt.Errorf("unsupported-required-compression")
	}
	if file.UncompressedSize64 > uint64(maxRequiredMemberBytes) {
		return nil, fmt.Errorf("required-member-bytes-exceeded")
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}

	return readBoundedRequiredMember(reader, maxRequiredMemberBytes)
}

func readBoundedRequiredMember(reader io.ReadCloser, byteLimit int64) ([]byte, error) {
	data, readErr := io.ReadAll(io.LimitReader(reader, byteLimit+1))
	closeErr := reader.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if int64(len(data)) > byteLimit {
		return nil, fmt.Errorf("required-member-bytes-exceeded")
	}

	return data, nil
}

func readArchive(path string) (*archiveContents, error) {
	manifest, err := preflightArchive(path)
	if err != nil {
		return nil, fmt.Errorf("preflight: %w", err)
	}
	reader, err := openZipReader(path)
	if err != nil {
		return nil, fmt.Errorf("open-zip: %w", err)
	}
	defer reader.Close()
	if len(reader.File) != len(manifest.entries) {
		return nil, fmt.Errorf("directory-record-count-changed")
	}
	contents := &archiveContents{byteLength: manifest.size}
	var retainedNameBytes int64
	for index, file := range reader.File {
		if !utf8.ValidString(file.Name) || strings.Contains(file.Name, "\\") || file.Name != manifest.entries[index].name {
			return nil, fmt.Errorf("entry-name-changed")
		}
		entry := manifest.entries[index]
		if file.Flags != entry.flags || file.Method != entry.method || file.CompressedSize64 != entry.compressedSize || file.UncompressedSize64 != entry.uncompressedSize {
			return nil, fmt.Errorf("directory-entry-metadata-changed")
		}
		retainedNameBytes += int64(len(file.Name))
		if retainedNameBytes > maxRetainedNameBytes {
			return nil, fmt.Errorf("retained-name-bytes-exceeded")
		}
		contents.entries = append(contents.entries, file.Name)
	}
	memberDestinations := [...]*[]byte{
		headerMember: &contents.members.header,
		worldMember:  &contents.members.world,
		tlvMember:    &contents.members.tlv,
		statesMember: &contents.members.states,
	}
	for kind, entryIndex := range manifest.required {
		data, err := readRequiredMember(reader.File[entryIndex])
		if err != nil {
			return nil, fmt.Errorf("read-required-member: %w", err)
		}
		*memberDestinations[kind] = data
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("hash-open: %w", err)
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, file)
	closeErr := file.Close()
	if copyErr != nil {
		return nil, fmt.Errorf("hash-read: %w", copyErr)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("hash-close: %w", closeErr)
	}
	contents.contentSHA256 = hex.EncodeToString(hash.Sum(nil))

	return contents, nil
}
