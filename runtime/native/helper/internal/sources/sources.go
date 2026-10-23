// Package sources computes the source evidence of the retained PowerShell core-reply worker, exactly as the retired
// Get-StartupWorkerSource script computed it, so the worker's handshake digest stays comparable.
package sources

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"path/filepath"

	j "companion-helper/internal/jsondoc"
	"companion-helper/internal/nativefs"
)

// ErrUnavailable is the single source-evidence failure class.
var ErrUnavailable = errors.New("source evidence unavailable")

const maximumSourceBytes = 1048576

// CoreReplyRuntimeNames lists the runtime/scripts files of the core-reply bundle, in hashing order.
var CoreReplyRuntimeNames = []string{"StartupCoreReplyWorker.ps1", "StartupWorkerProtocol.ps1", "Read-CoreReply.ps1",
	"CoreReplyValidation.ps1", "NativeFiles.cs", "JsonDocuments.cs", "EventDocuments.cs",
	"PayloadCodec.cs", "RuntimeFilePublication.cs", "RuntimeCodec.cs"}

// CoreNames lists the core files of the core-reply bundle, in hashing order.
var CoreNames = []string{"DigestDiff.psm1", "private/CompanionJson.ps1", "private/SourceIdentity.ps1",
	"private/DocumentValidation.ps1", "private/AdapterConfig.ps1", "private/DiffEngine.ps1",
	"private/ProcessRunner.ps1", "private/Acquisition.ps1", "private/StateFiles.ps1",
	"private/Consumption.ps1", "private/TurnContext.ps1", "private/StateEvents.ps1",
	"private/StateEventStorage.ps1", "private/Watcher.ps1", "private/WalkProtocol.ps1"}

// CoreReplySource returns {status: absent} when the companion .tmp directory is absent, otherwise the scope binding
// digest and the core-reply bundle digest.
func CoreReplySource(companionRoot, dataRoot, sourceRoot string) ([]byte, error) {
	temp, err := nativefs.AdmitWithin(companionRoot, filepath.Join(companionRoot, ".tmp"), true)
	if err != nil {
		return nil, ErrUnavailable
	}
	if !temp.Exists {
		return []byte(`{"status":"absent"}`), nil
	}
	if !temp.IsDirectory {
		return nil, ErrUnavailable
	}
	scope, err := readAdmitted(companionRoot, filepath.Join(dataRoot, "scope.json"))
	if err != nil {
		return nil, err
	}
	bundle := &bytes.Buffer{}
	for _, name := range CoreReplyRuntimeNames {
		if err := addFile(bundle, sourceRoot, filepath.Join(sourceRoot, "runtime", "scripts", filepath.FromSlash(name))); err != nil {
			return nil, err
		}
	}
	for _, name := range CoreNames {
		if err := addFile(bundle, companionRoot, filepath.Join(companionRoot, "core", filepath.FromSlash(name))); err != nil {
			return nil, err
		}
	}
	scopeSum := sha256.Sum256(scope)
	bundleSum := sha256.Sum256(bundle.Bytes())
	return j.NewObject().String("status", "present").String("scopeSha256", hex.EncodeToString(scopeSum[:])).
		String("coreReplySha256", hex.EncodeToString(bundleSum[:])).Bytes(), nil
}

func addFile(bundle *bytes.Buffer, root, target string) error {
	data, err := readAdmitted(root, target)
	if err != nil {
		return err
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	bundle.Write(header[:])
	bundle.Write(data)
	return nil
}

// readAdmitted reads a singly linked file twice under one admitted identity and requires identical bytes.
func readAdmitted(root, target string) ([]byte, error) {
	before, err := nativefs.AdmitWithin(root, target, false)
	if err != nil || !before.Exists || before.IsDirectory || before.Links != 1 {
		return nil, ErrUnavailable
	}
	data, err := nativefs.ReadBounded(before.Path, maximumSourceBytes)
	if err != nil {
		return nil, ErrUnavailable
	}
	after, err := nativefs.AdmitWithin(root, target, false)
	if err != nil || !after.Exists || after.IsDirectory || after.Links != 1 || before.Volume != after.Volume || before.Identity != after.Identity {
		return nil, ErrUnavailable
	}
	again, err := nativefs.ReadBounded(after.Path, maximumSourceBytes)
	if err != nil || !bytes.Equal(data, again) {
		return nil, ErrUnavailable
	}
	return data, nil
}
