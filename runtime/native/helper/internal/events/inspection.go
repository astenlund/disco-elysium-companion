package events

import (
	"errors"
	"time"

	j "companion-helper/internal/jsondoc"
	"companion-helper/internal/nativefs"
)

// ErrInspectionUnavailable is the inspection failure class.
var ErrInspectionUnavailable = errors.New("inspection unavailable")

const (
	maximumReplyBytes   = 65536
	maximumBatchRecords = 512
)

// ReadRequests inspects up to eight requested events or sources and returns one bounded reply.
func ReadRequests(root string, requestsJSON []byte, source bool) ([]byte, error) {
	if len(requestsJSON) > maximumReplyBytes {
		return nil, ErrInspectionUnavailable
	}
	requests, err := parseRequests(requestsJSON, 8)
	if err != nil {
		return nil, err
	}
	documents := make([][]byte, 0, len(requests.Items))
	for _, request := range requests.Items {
		document, _, err := inspect(root, request, source, 1<<62, false)
		if err != nil {
			return nil, err
		}
		documents = append(documents, document)
	}
	reply := replyDocuments(documents, len(documents), nil)
	if len(reply) > maximumReplyBytes {
		return nil, ErrInspectionUnavailable
	}
	return reply, nil
}

// ReadBatch inspects an ordered prefix of up to 512 requested events and returns the expanded reply, bounded by the
// config document budget. Unlike the one-shot script it does not compress the reply, because the service frame is not
// limited to 65,536 bytes.
func ReadBatch(root string, requestBytes []byte) ([]byte, error) {
	requests, err := parseRequests(requestBytes, maximumBatchRecords)
	if err != nil {
		return nil, err
	}
	requestSha := Sha256Hex(requestBytes)
	documents := [][]byte{}
	expanded := int64(len(replyDocuments(documents, 0, &requestSha)))
	remainingWork := int64(j.StateEvent.Bytes)
	for _, request := range requests.Items {
		document, observed, err := inspect(root, request, false, remainingWork, len(documents) > 0)
		if err != nil {
			return nil, err
		}
		if document == nil {
			break
		}
		remainingWork -= observed
		if len(documents) > 0 {
			expanded++
		}
		expanded += int64(len(document))
		if expanded > int64(j.Config.Bytes) {
			break
		}
		documents = append(documents, document)
		if remainingWork <= 0 {
			break
		}
	}
	for count := len(documents); count > 0; count /= 2 {
		reply := replyDocuments(documents, count, &requestSha)
		if j.Validate(reply, j.Config) == nil {
			return reply, nil
		}
	}
	return nil, ErrInspectionUnavailable
}

func parseRequests(data []byte, maximum int) (*j.Value, error) {
	document, err := j.Parse(data, j.Config)
	if err != nil || document.Kind != j.Array || len(document.Items) < 1 || len(document.Items) > maximum {
		return nil, ErrInspectionUnavailable
	}
	for _, request := range document.Items {
		if j.Fields(request, "path", "sequence") != nil {
			return nil, ErrInspectionUnavailable
		}
		if _, err := j.Text(request.Get("path")); err != nil {
			return nil, ErrInspectionUnavailable
		}
		if _, err := j.Integer(request.Get("sequence"), 0, j.MaximumSequence); err != nil {
			return nil, ErrInspectionUnavailable
		}
	}
	return document, nil
}

// inspect returns one document, or nil when a prefix must stop before a member too large for the remaining work.
func inspect(root string, request *j.Value, source bool, remainingWork int64, allowPrefix bool) ([]byte, int64, error) {
	path := request.Get("path").Str
	sequence, _ := j.Integer(request.Get("sequence"), 0, j.MaximumSequence)
	admitted, err := nativefs.AdmitWithin(root, path, true)
	if err != nil || admitted.IsDirectory {
		return nil, 0, ErrInspectionUnavailable
	}
	if admitted.Exists && allowPrefix {
		size, err := nativefs.SizeOf(admitted.Path)
		if err != nil {
			return nil, 0, ErrInspectionUnavailable
		}
		if size > remainingWork {
			return nil, 0, nil
		}
	}
	status := "absent"
	var sha256 *string
	var description []byte
	var observed int64
	if admitted.Exists {
		data, err := nativefs.ReadBounded(admitted.Path, j.StateEvent.Bytes)
		valid := false
		switch {
		case err == nil:
			observed = int64(len(data))
			hash := Sha256Hex(data)
			sha256 = &hash
			description, err = InspectFrozen(data, source, sequence)
			if err == nil && !source && sequence != 0 {
				var metadata *j.Value
				metadata, err = j.Parse(description, j.StateEvent)
				if err == nil {
					var actual int64
					actual, err = j.AnyInteger(metadata.Get("sequence"))
					if err == nil && actual != sequence {
						err = j.ErrInvalid
					}
				}
			}
			if err == nil {
				valid = true
			} else if !errors.Is(err, j.ErrInvalid) {
				return nil, 0, ErrInspectionUnavailable
			}
		case errors.Is(err, nativefs.ErrTooLarge):
		default:
			return nil, 0, ErrInspectionUnavailable
		}
		if valid {
			status = "valid"
		} else {
			if sha256 == nil {
				raw, err := nativefs.ObserveRaw(admitted.Path, 30*time.Second)
				if err != nil {
					return nil, 0, ErrInspectionUnavailable
				}
				sha256, observed = &raw.Sha256, raw.Bytes
			}
			current, err := nativefs.AdmitWithin(root, admitted.Path, false)
			if err != nil || current.IsDirectory || current.Volume != admitted.Volume || current.Identity != admitted.Identity {
				return nil, 0, ErrInspectionUnavailable
			}
			status, description = "invalid", nil
		}
	}
	out := j.NewObject().String("path", path).String("status", status).NullableString("sha256", sha256)
	if description == nil {
		out.Null("metadata")
	} else {
		out.Raw("metadata", description)
	}
	return out.Bytes(), observed, nil
}

func replyDocuments(documents [][]byte, count int, requestSha256 *string) []byte {
	out := j.NewObject()
	if requestSha256 != nil {
		out.String("requestSha256", *requestSha256)
	}
	list := j.NewArray()
	for index := 0; index < count; index++ {
		list.Raw(documents[index])
	}
	return out.Raw("documents", list.Bytes()).Bytes()
}
