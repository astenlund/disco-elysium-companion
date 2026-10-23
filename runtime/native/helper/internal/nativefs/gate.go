package nativefs

import (
	"errors"
	"time"
)

// ErrDeadline reports that a request ran out of time before its commit point, so nothing was committed.
var ErrDeadline = errors.New("deadline exceeded before commit")

// Gate is consulted immediately before a request's first change to a target. A nil error lets the commit proceed;
// once a commit has started, the request completes regardless of time.
type Gate func() error

// NoDeadline never refuses; callers without a deadline use it.
var NoDeadline Gate = func() error { return nil }

// Until refuses once the deadline has passed.
func Until(deadline time.Time) Gate {
	return func() error {
		if !time.Now().Before(deadline) {
			return ErrDeadline
		}
		return nil
	}
}
