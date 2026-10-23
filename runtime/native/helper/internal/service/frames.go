// Package service is the long-lived helper service: a strict framed request loop over stdio that serves the runtime's
// native operations concurrently, holding no target handle or observation between requests.
package service

import (
	"encoding/binary"
	"errors"
	"io"
)

// MaximumFrame bounds every request and reply frame.
const MaximumFrame = 2097152

var errFrame = errors.New("invalid frame")

// ReadFrame reads one four-byte big-endian length followed by that many bytes. A clean end before any header byte is
// io.EOF; anything else incomplete or out of bounds is a framing error.
func ReadFrame(input io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(input, header[:]); err != nil {
		if err == io.EOF {
			return nil, io.EOF
		}
		return nil, errFrame
	}
	length := binary.BigEndian.Uint32(header[:])
	if length < 1 || length > MaximumFrame {
		return nil, errFrame
	}
	frame := make([]byte, length)
	if _, err := io.ReadFull(input, frame); err != nil {
		return nil, errFrame
	}
	return frame, nil
}

// WriteFrame writes one bounded frame in a single write.
func WriteFrame(output io.Writer, body []byte) error {
	if len(body) < 1 || len(body) > MaximumFrame {
		return errFrame
	}
	frame := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(frame, uint32(len(body)))
	copy(frame[4:], body)
	written, err := output.Write(frame)
	if err != nil || written != len(frame) {
		return errFrame
	}
	return nil
}
