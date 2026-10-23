// Command job-holder stands in for a process another runtime release left in a named job. It creates the job named by
// its argument, or opens it when it already exists, assigns itself to it, prints "ready" and waits until its input closes.
package main

import (
	"fmt"
	"io"
	"os"
	"syscall"
	"unsafe"
)

var (
	kernel32          = syscall.NewLazyDLL("kernel32.dll")
	createJobObject   = kernel32.NewProc("CreateJobObjectW")
	assignProcess     = kernel32.NewProc("AssignProcessToJobObject")
	getCurrentProcess = kernel32.NewProc("GetCurrentProcess")
)

func main() {
	if len(os.Args) != 2 {
		os.Exit(2)
	}
	name, err := syscall.UTF16PtrFromString(os.Args[1])
	if err != nil {
		os.Exit(2)
	}
	job, _, _ := createJobObject.Call(0, uintptr(unsafe.Pointer(name)))
	if job == 0 {
		os.Exit(3)
	}
	self, _, _ := getCurrentProcess.Call()
	if ok, _, _ := assignProcess.Call(job, self); ok == 0 {
		os.Exit(4)
	}
	fmt.Println("ready")
	_, _ = io.Copy(io.Discard, os.Stdin)
}
