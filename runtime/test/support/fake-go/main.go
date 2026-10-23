// Command fake-go stands in for go.exe in build-step tests. The build step runs it with a closed environment, so it reads
// its behavior from fake-go.json beside its own executable. Without that file it sleeps, which lets a copy of it serve
// as a running image that cannot be deleted.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

type config struct {
	Version  string `json:"version"`
	Build    string `json:"build"`
	CopyFrom string `json:"copyFrom"`
	JunkAt   string `json:"junkAt"`
	Marker   string `json:"marker"`
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		os.Exit(2)
	}
	bytes, err := os.ReadFile(filepath.Join(filepath.Dir(executable), "fake-go.json"))
	if err != nil {
		time.Sleep(10 * time.Minute)
		os.Exit(0)
	}
	var settings config
	if json.Unmarshal(bytes, &settings) != nil || len(os.Args) < 2 {
		os.Exit(2)
	}
	if os.Args[1] == "version" {
		fmt.Println(settings.Version)
		return
	}
	output := ""
	for index, argument := range os.Args {
		if argument == "-o" && index+1 < len(os.Args) {
			output = os.Args[index+1]
		}
	}
	if settings.Marker != "" {
		_ = os.WriteFile(settings.Marker, fmt.Append(nil, os.Getpid()), 0o600)
	}
	switch settings.Build {
	case "fail":
		os.Exit(1)
	case "junk":
		_ = os.WriteFile(output, []byte("not the pinned image"), 0o600)
	case "sleep":
		time.Sleep(10 * time.Minute)
	case "late":
		time.Sleep(3 * time.Second)
		if copyFile(settings.CopyFrom, output) != nil {
			os.Exit(1)
		}
	case "copy":
		if settings.JunkAt != "" {
			_ = os.WriteFile(settings.JunkAt, []byte("published meanwhile"), 0o600)
		}
		if copyFile(settings.CopyFrom, output) != nil {
			os.Exit(1)
		}
	default:
		os.Exit(2)
	}
}

func copyFile(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.Create(target)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return err
	}
	return output.Close()
}
