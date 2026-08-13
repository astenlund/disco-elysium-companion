package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type zipFixture struct {
	name string
	body []byte
}

func requiredZipFixtures(prefix string) []zipFixture {
	return []zipFixture{
		{name: prefix + ".1st.ntwtf.json", body: []byte(`{"header":1}`)},
		{name: prefix + ".2nd.ntwtf.json", body: []byte(`{"world":2}`)},
		{name: prefix + ".ntwtf.lua", body: []byte("tlv")},
		{name: prefix + ".states.lua", body: []byte("states")},
	}
}

func writeZipFixture(t *testing.T, fixtures []zipFixture) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fixture.ntwtf.zip")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for _, fixture := range fixtures {
		entry, err := writer.CreateHeader(&zip.FileHeader{Name: fixture.name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(fixture.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	return path
}

func rawDirectoryArchive(names [][]byte, flags uint16, method uint16, declaredCount uint16) []byte {
	var directory bytes.Buffer
	for _, name := range names {
		directory.Write(centralDirectoryRecord(name, nil, flags, method, 0))
	}

	return archiveFromDirectory(directory.Bytes(), declaredCount)
}

func centralDirectoryRecord(name []byte, extra []byte, flags uint16, method uint16, uncompressedSize uint32) []byte {
	header := make([]byte, 46)
	binary.LittleEndian.PutUint32(header[0:4], 0x02014b50)
	binary.LittleEndian.PutUint16(header[8:10], flags)
	binary.LittleEndian.PutUint16(header[10:12], method)
	binary.LittleEndian.PutUint32(header[24:28], uncompressedSize)
	binary.LittleEndian.PutUint16(header[28:30], uint16(len(name)))
	binary.LittleEndian.PutUint16(header[30:32], uint16(len(extra)))
	record := append(header, name...)

	return append(record, extra...)
}

func archiveFromDirectory(directory []byte, declaredCount uint16) []byte {
	var archive bytes.Buffer
	archive.Write(directory)
	eocd := make([]byte, 22)
	binary.LittleEndian.PutUint32(eocd[0:4], 0x06054b50)
	binary.LittleEndian.PutUint16(eocd[8:10], declaredCount)
	binary.LittleEndian.PutUint16(eocd[10:12], declaredCount)
	binary.LittleEndian.PutUint32(eocd[12:16], uint32(len(directory)))
	binary.LittleEndian.PutUint32(eocd[16:20], 0)
	archive.Write(eocd)

	return archive.Bytes()
}

func zip64ArchiveFromDirectory(directory []byte, declaredCount uint64) []byte {
	var archive bytes.Buffer
	archive.Write(directory)
	zip64Offset := uint64(len(directory))
	record := make([]byte, 56)
	binary.LittleEndian.PutUint32(record[0:4], 0x06064b50)
	binary.LittleEndian.PutUint64(record[4:12], 44)
	binary.LittleEndian.PutUint64(record[24:32], declaredCount)
	binary.LittleEndian.PutUint64(record[32:40], declaredCount)
	binary.LittleEndian.PutUint64(record[40:48], uint64(len(directory)))
	binary.LittleEndian.PutUint64(record[48:56], 0)
	archive.Write(record)
	locator := make([]byte, 20)
	binary.LittleEndian.PutUint32(locator[0:4], 0x07064b50)
	binary.LittleEndian.PutUint64(locator[8:16], zip64Offset)
	binary.LittleEndian.PutUint32(locator[16:20], 1)
	archive.Write(locator)
	eocd := make([]byte, 22)
	binary.LittleEndian.PutUint32(eocd[0:4], 0x06054b50)
	binary.LittleEndian.PutUint16(eocd[8:10], 0xffff)
	binary.LittleEndian.PutUint16(eocd[10:12], 0xffff)
	binary.LittleEndian.PutUint32(eocd[12:16], 0xffffffff)
	binary.LittleEndian.PutUint32(eocd[16:20], 0xffffffff)
	archive.Write(eocd)

	return archive.Bytes()
}

func requiredNames(prefix string) [][]byte {
	return [][]byte{
		[]byte(prefix + ".1st.ntwtf.json"),
		[]byte(prefix + ".2nd.ntwtf.json"),
		[]byte(prefix + ".ntwtf.lua"),
		[]byte(prefix + ".states.lua"),
	}
}

func writeRawArchive(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "raw.ntwtf.zip")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	return path
}

func TestPreflightRequiredMemberIdentity(t *testing.T) {
	tests := []struct {
		name    string
		names   [][]byte
		wantErr bool
	}{
		{name: "shared root prefix", names: requiredNames("save")},
		{name: "shared nested prefix", names: requiredNames("slot/save")},
		{name: "mixed logical prefixes", names: [][]byte{[]byte("a.1st.ntwtf.json"), []byte("b.2nd.ntwtf.json"), []byte("a.ntwtf.lua"), []byte("a.states.lua")}, wantErr: true},
		{name: "suffix-only names", names: requiredNames(""), wantErr: true},
		{name: "duplicate required member", names: append(requiredNames("save"), []byte("save.1st.ntwtf.json")), wantErr: true},
		{name: "case-sensitive suffix", names: [][]byte{[]byte("save.1ST.ntwtf.json"), []byte("save.2nd.ntwtf.json"), []byte("save.ntwtf.lua"), []byte("save.states.lua")}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Weak suffix matching or independent member selection makes this fail.
			path := writeRawArchive(t, rawDirectoryArchive(test.names, 0, zip.Store, uint16(len(test.names))))

			_, err := preflightArchive(path)

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

func TestPreflightRejectsUnsafeDirectoryEntries(t *testing.T) {
	tests := []struct {
		name   string
		names  [][]byte
		flags  uint16
		method uint16
	}{
		{name: "backslash", names: append(requiredNames("save"), []byte("ignored\\name")), method: zip.Store},
		{name: "invalid UTF-8", names: append(requiredNames("save"), []byte{'b', 'a', 'd', 0xff}), method: zip.Store},
		{name: "encrypted required member", names: requiredNames("save"), flags: 1, method: zip.Store},
		{name: "unsupported required compression", names: requiredNames("save"), method: 99},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Deferring these checks until archive/zip opens entries makes this fail.
			path := writeRawArchive(t, rawDirectoryArchive(test.names, test.flags, test.method, uint16(len(test.names))))

			_, err := preflightArchive(path)

			if err == nil {
				t.Fatal("want error")
			}
		})
	}
}

func TestPreflightRejectsMalformedDirectory(t *testing.T) {
	valid := rawDirectoryArchive(requiredNames("save"), 0, zip.Store, 4)
	tests := []struct {
		name string
		data []byte
	}{
		{name: "truncated archive", data: valid[:len(valid)-1]},
		{name: "declared count mismatch", data: rawDirectoryArchive(requiredNames("save"), 0, zip.Store, 5)},
		{name: "header signature", data: append([]byte(nil), valid...)},
		{name: "header length overrun", data: append([]byte(nil), valid...)},
	}
	for index := range tests {
		switch tests[index].name {
		case "header signature":
			tests[index].data[0] = 0
		case "header length overrun":
			binary.LittleEndian.PutUint16(tests[index].data[28:30], 0xffff)
		}
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Trusting EOCD counts without exact range scanning makes this fail.
			_, err := preflightArchive(writeRawArchive(t, test.data))

			if err == nil {
				t.Fatal("want error")
			}
		})
	}
}

func TestArchiveSizeBoundary(t *testing.T) {
	makeSparse := func(t *testing.T, size int64) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), "sparse.ntwtf.zip")
		file, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := file.Truncate(size); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}

		return path
	}
	tests := []struct {
		name          string
		size          int64
		wantSizeError bool
	}{
		{name: "exact ceiling reaches format validation", size: maxArchiveBytes},
		{name: "plus one rejected by size", size: maxArchiveBytes + 1, wantSizeError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Changing the inclusive archive-byte comparison makes this fail.
			_, err := preflightArchive(makeSparse(t, test.size))

			if err == nil {
				t.Fatal("want format or size error")
			}
			gotSizeError := strings.Contains(err.Error(), "archive-bytes-exceeded")
			if gotSizeError != test.wantSizeError {
				t.Fatalf("error = %v, wantSizeError %t", err, test.wantSizeError)
			}
		})
	}
}

func TestCentralDirectoryRecordBoundary(t *testing.T) {
	makeDirectory := func(count int) []byte {
		var directory bytes.Buffer
		for _, name := range requiredNames("save") {
			directory.Write(centralDirectoryRecord(name, nil, 0, zip.Store, 0))
		}
		ignored := centralDirectoryRecord(nil, nil, 0, zip.Store, 0)
		for index := 4; index < count; index++ {
			directory.Write(ignored)
		}

		return directory.Bytes()
	}
	tests := []struct {
		name    string
		count   int
		wantErr bool
	}{
		{name: "exact ceiling", count: maxDirectoryRecords},
		{name: "plus one", count: maxDirectoryRecords + 1, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Moving the inclusive record comparison by one makes this fail.
			path := writeRawArchive(t, zip64ArchiveFromDirectory(makeDirectory(test.count), uint64(test.count)))

			_, err := preflightArchive(path)

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
			if err != nil && !strings.Contains(err.Error(), "directory-records-exceeded") {
				t.Fatalf("unexpected error %v", err)
			}
		})
	}
}

func directoryWithExactSize(t *testing.T, target int64) ([]byte, uint64) {
	t.Helper()
	var directory bytes.Buffer
	for _, name := range requiredNames("save") {
		directory.Write(centralDirectoryRecord(name, nil, 0, zip.Store, 0))
	}
	remaining := target - int64(directory.Len())
	if remaining <= 0 {
		t.Fatalf("target %d is too small", target)
	}
	ignoredRecordCount := (remaining + 65_580) / 65_581
	if remaining < ignoredRecordCount*46 {
		t.Fatalf("cannot represent remaining directory bytes")
	}
	extraRemaining := remaining - ignoredRecordCount*46
	for index := int64(0); index < ignoredRecordCount; index++ {
		extraLength := extraRemaining
		if extraLength > 65_535 {
			extraLength = 65_535
		}
		directory.Write(centralDirectoryRecord(nil, make([]byte, int(extraLength)), 0, zip.Store, 0))
		extraRemaining -= extraLength
	}
	if int64(directory.Len()) != target {
		t.Fatalf("directory length %d, want %d", directory.Len(), target)
	}

	return directory.Bytes(), uint64(4 + ignoredRecordCount)
}

func TestCentralDirectoryByteBoundary(t *testing.T) {
	tests := []struct {
		name    string
		size    int64
		wantErr bool
	}{
		{name: "exact ceiling", size: maxDirectoryBytes},
		{name: "plus one", size: maxDirectoryBytes + 1, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory, count := directoryWithExactSize(t, test.size)
			path := writeRawArchive(t, zip64ArchiveFromDirectory(directory, count))

			_, err := preflightArchive(path)

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
			if err != nil && !strings.Contains(err.Error(), "directory-bytes-exceeded") {
				t.Fatalf("unexpected error %v", err)
			}
		})
	}
}

func directoryWithRetainedNames(t *testing.T, target int64) ([]byte, uint16) {
	t.Helper()
	var directory bytes.Buffer
	var retained int64
	count := 0
	for _, name := range requiredNames("save") {
		directory.Write(centralDirectoryRecord(name, nil, 0, zip.Store, 0))
		retained += int64(len(name))
		count++
	}
	for retained < target {
		length := target - retained
		if length > 65_535 {
			length = 65_535
		}
		directory.Write(centralDirectoryRecord(bytes.Repeat([]byte{'n'}, int(length)), nil, 0, zip.Store, 0))
		retained += length
		count++
	}

	return directory.Bytes(), uint16(count)
}

func TestRetainedNameByteBoundary(t *testing.T) {
	tests := []struct {
		name    string
		size    int64
		wantErr bool
	}{
		{name: "exact ceiling", size: maxRetainedNameBytes},
		{name: "plus one", size: maxRetainedNameBytes + 1, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory, count := directoryWithRetainedNames(t, test.size)
			path := writeRawArchive(t, archiveFromDirectory(directory, count))

			_, err := preflightArchive(path)

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
			if err != nil && !strings.Contains(err.Error(), "retained-name-bytes-exceeded") {
				t.Fatalf("unexpected error %v", err)
			}
		})
	}
}

func TestRequiredMemberDeclaredByteBoundary(t *testing.T) {
	for _, extraByte := range []uint32{0, 1} {
		t.Run(string(rune('0'+extraByte)), func(t *testing.T) {
			var directory bytes.Buffer
			for index, name := range requiredNames("save") {
				size := uint32(0)
				if index == 0 {
					size = uint32(maxRequiredMemberBytes) + extraByte
				}
				directory.Write(centralDirectoryRecord(name, nil, 0, zip.Store, size))
			}
			path := writeRawArchive(t, archiveFromDirectory(directory.Bytes(), 4))

			_, err := preflightArchive(path)

			if (err != nil) != (extraByte == 1) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestRequiredMemberStreamedByteBoundary(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantErr bool
	}{
		{name: "exact ceiling", body: "abc"},
		{name: "plus one", body: "abcd", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Trusting only the declared uncompressed size or using a non-inclusive stream bound makes this fail.
			data, err := readBoundedRequiredMember(io.NopCloser(strings.NewReader(test.body)), 3)

			if (err != nil) != test.wantErr {
				t.Fatalf("data=%q error=%v wantErr=%t", data, err, test.wantErr)
			}
		})
	}
}

func TestZIP64MetadataValidation(t *testing.T) {
	directory := func() []byte {
		var buffer bytes.Buffer
		for _, name := range requiredNames("save") {
			buffer.Write(centralDirectoryRecord(name, nil, 0, zip.Store, 0))
		}

		return buffer.Bytes()
	}()
	valid := zip64ArchiveFromDirectory(directory, 4)
	tests := []struct {
		name    string
		mutate  func([]byte)
		wantErr bool
	}{
		{name: "valid", mutate: func([]byte) {}},
		{name: "missing locator", mutate: func(data []byte) { data[len(data)-42] = 0 }, wantErr: true},
		{name: "invalid record signature", mutate: func(data []byte) { data[len(directory)] = 0 }, wantErr: true},
		{name: "short record size", mutate: func(data []byte) { binary.LittleEndian.PutUint64(data[len(directory)+4:len(directory)+12], 43) }, wantErr: true},
		{name: "record overlaps locator", mutate: func(data []byte) { binary.LittleEndian.PutUint64(data[len(directory)+4:len(directory)+12], 60) }, wantErr: true},
		{name: "count mismatch", mutate: func(data []byte) { binary.LittleEndian.PutUint64(data[len(directory)+32:len(directory)+40], 5) }, wantErr: true},
		{name: "directory range overflow", mutate: func(data []byte) {
			binary.LittleEndian.PutUint64(data[len(directory)+48:len(directory)+56], math.MaxUint64)
		}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := append([]byte(nil), valid...)
			test.mutate(data)

			_, err := preflightArchive(writeRawArchive(t, data))

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

func TestZIP64EOCDConsistencyAndExactLayout(t *testing.T) {
	directory := func() []byte {
		var buffer bytes.Buffer
		for _, name := range requiredNames("save") {
			buffer.Write(centralDirectoryRecord(name, nil, 0, zip.Store, 0))
		}

		return buffer.Bytes()
	}()
	valid := zip64ArchiveFromDirectory(directory, 4)
	mutateEOCD := func(data []byte, mutate func([]byte)) {
		mutate(data[len(data)-22:])
	}
	withComment := func(data []byte, length int) []byte {
		result := append([]byte(nil), data...)
		binary.LittleEndian.PutUint16(result[len(result)-2:], uint16(length))

		return append(result, bytes.Repeat([]byte{'c'}, length)...)
	}
	tests := []struct {
		name    string
		mutate  func([]byte) []byte
		wantErr bool
	}{
		{
			name: "matching mixed sentinels",
			mutate: func(data []byte) []byte {
				mutateEOCD(data, func(eocd []byte) {
					binary.LittleEndian.PutUint16(eocd[8:10], 4)
					binary.LittleEndian.PutUint32(eocd[12:16], uint32(len(directory)))
				})

				return data
			},
		},
		{
			name: "matching disk-only sentinels",
			mutate: func(data []byte) []byte {
				mutateEOCD(data, func(eocd []byte) {
					binary.LittleEndian.PutUint16(eocd[4:6], 0xffff)
					binary.LittleEndian.PutUint16(eocd[6:8], 0xffff)
					binary.LittleEndian.PutUint16(eocd[8:10], 4)
					binary.LittleEndian.PutUint16(eocd[10:12], 4)
					binary.LittleEndian.PutUint32(eocd[12:16], uint32(len(directory)))
					binary.LittleEndian.PutUint32(eocd[16:20], 0)
				})

				return data
			},
		},
		{
			name: "contradictory disk",
			mutate: func(data []byte) []byte {
				mutateEOCD(data, func(eocd []byte) { binary.LittleEndian.PutUint16(eocd[4:6], 1) })

				return data
			},
			wantErr: true,
		},
		{
			name: "contradictory directory disk",
			mutate: func(data []byte) []byte {
				mutateEOCD(data, func(eocd []byte) { binary.LittleEndian.PutUint16(eocd[6:8], 1) })

				return data
			},
			wantErr: true,
		},
		{
			name: "contradictory disk count",
			mutate: func(data []byte) []byte {
				mutateEOCD(data, func(eocd []byte) { binary.LittleEndian.PutUint16(eocd[8:10], 3) })

				return data
			},
			wantErr: true,
		},
		{
			name: "contradictory total count",
			mutate: func(data []byte) []byte {
				mutateEOCD(data, func(eocd []byte) { binary.LittleEndian.PutUint16(eocd[10:12], 3) })

				return data
			},
			wantErr: true,
		},
		{
			name: "contradictory directory size",
			mutate: func(data []byte) []byte {
				mutateEOCD(data, func(eocd []byte) { binary.LittleEndian.PutUint32(eocd[12:16], uint32(len(directory)-1)) })

				return data
			},
			wantErr: true,
		},
		{
			name: "contradictory directory offset",
			mutate: func(data []byte) []byte {
				mutateEOCD(data, func(eocd []byte) { binary.LittleEndian.PutUint32(eocd[16:20], 1) })

				return data
			},
			wantErr: true,
		},
		{
			name: "gap before locator",
			mutate: func(data []byte) []byte {
				locatorOffset := len(directory) + 56
				result := append([]byte(nil), data[:locatorOffset]...)
				result = append(result, 0)

				return append(result, data[locatorOffset:]...)
			},
			wantErr: true,
		},
		{
			name: "short gap underflow",
			mutate: func(data []byte) []byte {
				locatorOffset := len(directory) + 56
				binary.LittleEndian.PutUint64(data[locatorOffset+8:locatorOffset+16], uint64(locatorOffset-8))

				return data
			},
			wantErr: true,
		},
		{name: "long comment valid", mutate: func(data []byte) []byte { return withComment(data, 60_000) }},
		{
			name: "long comment with record overlap",
			mutate: func(data []byte) []byte {
				binary.LittleEndian.PutUint64(data[len(directory)+4:len(directory)+12], 60)

				return withComment(data, 60_000)
			},
			wantErr: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := test.mutate(append([]byte(nil), valid...))

			_, err := preflightArchive(writeRawArchive(t, data))

			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

func TestRejectedPreflightNeverOpensZipReader(t *testing.T) {
	names := requiredNames("save")
	for index := 0; index < 2_000; index++ {
		names = append(names, []byte(strings.Repeat("n", 8_400)))
	}
	path := writeRawArchive(t, rawDirectoryArchive(names, 0, zip.Store, uint16(len(names))))
	original := openZipReader
	opened := false
	openZipReader = func(string) (*zip.ReadCloser, error) {
		opened = true

		return nil, errors.New("must not open")
	}
	t.Cleanup(func() { openZipReader = original })

	// Moving name-budget checks after archive/zip allocation makes this fail.
	_, err := readArchive(path)

	if err == nil || !strings.Contains(err.Error(), "retained-name-bytes-exceeded") {
		t.Fatalf("want retained-name budget error, got %v", err)
	}
	if opened {
		t.Fatal("zip.OpenReader reached after rejected preflight")
	}
}

func TestReadArchiveRequiredMembersAndIntegrity(t *testing.T) {
	path := writeZipFixture(t, requiredZipFixtures("nested/save"))
	// Dropping a required member read, source entry, byte length, or hash makes this fail.
	archive, err := readArchive(path)

	if err != nil {
		t.Fatal(err)
	}
	if string(archive.members.header) != `{"header":1}` || string(archive.members.world) != `{"world":2}` || string(archive.members.tlv) != "tlv" || string(archive.members.states) != "states" {
		t.Fatalf("members = %#v", archive.members)
	}
	if len(archive.entries) != 4 || archive.byteLength <= 0 || len(archive.contentSHA256) != 64 {
		t.Fatalf("entries=%#v length=%d hash=%q", archive.entries, archive.byteLength, archive.contentSHA256)
	}
}

func TestReadArchiveRejectsCRCFailure(t *testing.T) {
	path := writeZipFixture(t, requiredZipFixtures("save"))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	needle := []byte(`{"header":1}`)
	offset := bytes.Index(data, needle)
	if offset < 0 {
		t.Fatal("header body not found")
	}
	data[offset] ^= 0xff
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	// Ignoring streamed member or close integrity errors makes this fail.
	_, err = readArchive(path)

	if err == nil {
		t.Fatal("want CRC error")
	}
}

func TestReadArchiveRejectsPostPreflightMetadataChange(t *testing.T) {
	path := writeZipFixture(t, requiredZipFixtures("save"))
	original := openZipReader
	openZipReader = func(archivePath string) (*zip.ReadCloser, error) {
		data, err := os.ReadFile(archivePath)
		if err != nil {
			return nil, err
		}
		offset := bytes.Index(data, []byte{'P', 'K', 1, 2})
		if offset < 0 {
			return nil, errors.New("central directory not found")
		}
		data[offset+8] ^= 0x08
		if err := os.WriteFile(archivePath, data, 0o600); err != nil {
			return nil, err
		}

		return original(archivePath)
	}
	t.Cleanup(func() { openZipReader = original })

	// Omitting the post-open metadata consistency check reaches a later, less precise failure.
	_, err := readArchive(path)

	if err == nil || !strings.Contains(err.Error(), "directory-entry-metadata-changed") {
		t.Fatalf("want metadata-change error, got %v", err)
	}
}
