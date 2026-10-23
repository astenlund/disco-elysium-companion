package nativefs

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"path/filepath"
	"time"

	j "companion-helper/internal/jsondoc"
)

// ReadHashes hashes a batch of admitted files under root, optionally bracketed by an immutable scope check. Hashes
// identify exact bytes only; they never admit payload or control semantics. An absent file hashes to null.
func ReadHashes(root string, request []byte, scopeSha256 *string) ([]byte, error) {
	started := time.Now()
	if len(request) > j.Config.Bytes {
		return nil, ErrUnavailable
	}
	document, err := j.Parse(request, j.Config)
	if err != nil || document.Kind != j.Array || len(document.Items) < 1 || len(document.Items) > 512 {
		return nil, ErrUnavailable
	}
	if scopeSha256 != nil && !j.IsHex(*scopeSha256, 64) {
		return nil, ErrUnavailable
	}
	scopePath := filepath.Join(root, "scope.json")
	checkScope := func() error {
		if scopeSha256 == nil {
			return nil
		}
		observed, err := observeHash(root, scopePath, started)
		if err != nil || observed == nil || *observed != *scopeSha256 {
			return ErrUnavailable
		}
		return nil
	}
	if err := checkScope(); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(request)
	hashes := j.NewArray()
	for _, target := range document.Items {
		if target.Kind != j.String || target.Str == "" {
			return nil, ErrUnavailable
		}
		observed, err := observeHash(root, target.Str, started)
		if err != nil {
			return nil, err
		}
		hashes.NullableString(observed)
	}
	reply := j.NewObject().String("requestSha256", hex.EncodeToString(sum[:])).Raw("sha256", hashes.Bytes()).Bytes()
	if err := checkScope(); err != nil {
		return nil, err
	}
	if len(reply) > 65536 || time.Since(started) >= 30*time.Second {
		return nil, ErrUnavailable
	}
	return reply, nil
}

func observeHash(root, path string, started time.Time) (*string, error) {
	admitted, err := AdmitWithin(root, path, true)
	if err != nil || admitted.IsDirectory {
		return nil, ErrUnavailable
	}
	remaining := 30000 - int64(math.Ceil(float64(time.Since(started).Microseconds())/1000))
	if remaining <= 0 {
		return nil, ErrUnavailable
	}
	if !admitted.Exists {
		return nil, nil
	}
	raw, err := ObserveRaw(admitted.Path, time.Duration(remaining)*time.Millisecond)
	if err != nil {
		return nil, ErrUnavailable
	}
	current, err := AdmitWithin(root, admitted.Path, false)
	if err != nil || current.IsDirectory || current.Volume != admitted.Volume || current.Identity != admitted.Identity {
		return nil, ErrUnavailable
	}
	return &raw.Sha256, nil
}

// FileAction moves or removes one owned file after verifying its exact bytes. gate is consulted immediately before
// the move or removal, the action's commit point.
func FileAction(root, action, source, target, sha256Hex string, gate Gate) error {
	admitted, err := exactFile(root, source, sha256Hex)
	if err != nil {
		return err
	}
	switch action {
	case "Move":
		destination, err := AdmitWithin(root, target, true)
		if err != nil || destination.Exists || len(destination.Missing) != 1 || !EqualOrdinalIgnoreCase(filepath.VolumeName(admitted.Path), filepath.VolumeName(destination.Path)) {
			return ErrUnavailable
		}
		if err := gate(); err != nil {
			return err
		}
		if err := moveNoReplace(admitted.Path, destination.Path); err != nil {
			return ErrUnavailable
		}
		if _, err := exactFile(root, destination.Path, sha256Hex); err != nil {
			return err
		}
	case "Remove":
		if err := gate(); err != nil {
			return err
		}
		if err := DeleteFile(admitted.Path); err != nil {
			return ErrUnavailable
		}
	default:
		return ErrUnavailable
	}
	remaining, err := AdmitWithin(root, admitted.Path, true)
	if err != nil || remaining.Exists {
		return ErrUnavailable
	}
	return nil
}

func exactFile(root, path, sha256Hex string) (Admission, error) {
	source, err := AdmitWithin(root, path, false)
	if err != nil || source.IsDirectory || !j.IsHex(sha256Hex, 64) {
		return Admission{}, ErrUnavailable
	}
	observation, err := ObserveRaw(source.Path, 30*time.Second)
	if err != nil {
		return Admission{}, ErrUnavailable
	}
	current, err := AdmitWithin(root, source.Path, false)
	if err != nil || current.IsDirectory || current.Volume != source.Volume || current.Identity != source.Identity || observation.Sha256 != sha256Hex {
		return Admission{}, ErrUnavailable
	}
	return source, nil
}
