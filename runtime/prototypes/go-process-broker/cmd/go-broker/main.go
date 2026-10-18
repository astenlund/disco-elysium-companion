package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	broker "companion-go-process-broker-prototype"
)

func main() {
	name := strings.TrimSuffix(filepath.Base(os.Args[0]), filepath.Ext(os.Args[0]))
	code, err := broker.Run(os.Stdin, os.Stdout, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, name+": owned-process-failed")
		os.Exit(125)
	}
	os.Exit(code)
}
