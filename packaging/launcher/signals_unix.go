//go:build !windows

package main

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

func startSignalForwarding(command *exec.Cmd) func() {
	signals := make(chan os.Signal, 2)
	stopped := make(chan struct{})
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		for {
			select {
			case received := <-signals:
				if command.Process != nil {
					_ = command.Process.Signal(received)
				}
			case <-stopped:
				return
			}
		}
	}()
	return func() {
		signal.Stop(signals)
		close(stopped)
	}
}
