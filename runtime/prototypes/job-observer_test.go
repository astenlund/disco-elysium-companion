package main

import (
	"testing"
)

func TestDecodeRequestRejectsDuplicateAndIncompleteIdentity(t *testing.T) {
	valid := `{"names":["first"],"owned":{"name":"first","processId":123,"brokerId":456,"created":"1","brokerCreated":"2"}}`
	if _, err := decodeRequest([]byte(valid)); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	invalid := []string{
		`{"names":[],"names":[]}`,
		`{"names":[],"owned":{"name":"first","processId":123,"brokerId":456,"created":"1","brokerCreated":"2","brokerCreated":"3"}}`,
		`{"names":[],"owned":{"name":"first","processId":123,"brokerId":456,"created":"1"}}`,
		`{"names":[],"owned":null}`,
		`{"names":[],"extra":1}`,
		`{"names":[]} {"names":[]}`,
	}
	for _, input := range invalid {
		if _, err := decodeRequest([]byte(input)); err == nil {
			t.Fatalf("invalid request accepted: %s", input)
		}
	}
}

func TestCreationTokenRejectsMissingAndReusedIdentity(t *testing.T) {
	if !validCreationToken("133700000000000000") {
		t.Fatal("valid creation token rejected")
	}
	for _, value := range []string{"", "0", "01", "-1", "1.5", "18446744073709551616"} {
		if validCreationToken(value) {
			t.Fatalf("invalid creation token accepted: %q", value)
		}
	}
}
