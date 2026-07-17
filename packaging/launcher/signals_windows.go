//go:build windows

package main

import "os/exec"

func startSignalForwarding(_ *exec.Cmd) func() {
	// The child shares the launcher's console and receives Windows console events directly.
	return func() {}
}
