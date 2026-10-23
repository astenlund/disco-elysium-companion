// Command companion-helper is the runtime's native helper. "service <nonce> <companionRoot>" runs the long-lived request service over
// stdio; "broker" launches one supervised child inside its own kill-on-close job. Any other argument list exits 2.
package main

import (
	"os"

	"companion-helper/internal/broker"
	"companion-helper/internal/service"
)

func main() {
	switch {
	case len(os.Args) == 4 && os.Args[1] == "service":
		os.Exit(service.Run(os.Args[2], os.Args[3], os.Stdin, os.Stdout))
	case len(os.Args) == 2 && os.Args[1] == "broker":
		code, _ := broker.Run(os.Stdin, os.Stdout, os.Stderr)
		os.Exit(code)
	default:
		os.Exit(2)
	}
}
