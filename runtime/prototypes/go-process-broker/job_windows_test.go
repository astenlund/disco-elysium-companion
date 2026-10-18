package broker

import "testing"

func TestJobNameAdmission(t *testing.T) {
	prefix := "Global" + string(rune(92)) + "game-companion-process-"
	identity := "0123456789abcdef0123456789abcdef"
	for role := range processRoles {
		if !validJobName(prefix + identity + "-" + role) {
			t.Fatalf("valid role %s rejected", role)
		}
	}
	invalid := []string{
		prefix + identity + "-foreign",
		prefix + "0123456789ABCDEF0123456789abcdef-core",
		prefix + identity[:31] + "-core",
		prefix + identity + "-core-extra",
		"Local" + string(rune(92)) + "game-companion-process-" + identity + "-core",
	}
	for _, name := range invalid {
		if validJobName(name) {
			t.Fatal("invalid job name accepted")
		}
	}
}
