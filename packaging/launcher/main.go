package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

const managedRestartExitCode = 75

var version = "dev"

type launcherCommand struct {
	script  string
	args    []string
	restart bool
}

func main() {
	os.Exit(run())
}

func run() int {
	root, err := executableRoot()
	if err != nil {
		return fail(err)
	}
	if err := os.Chdir(root); err != nil {
		return fail(fmt.Errorf("cannot enter release directory %q: %w", root, err))
	}

	arguments := os.Args[1:]
	commandName := "start"
	if len(arguments) > 0 {
		commandName = arguments[0]
		arguments = arguments[1:]
	}

	switch commandName {
	case "version", "--version", "-v":
		fmt.Println(version)
		return 0
	case "help", "--help", "-h":
		printUsage()
		return 0
	}

	command, err := resolveCommand(commandName, arguments)
	if err != nil {
		printUsage()
		return fail(err)
	}

	nodePath := bundledNodePath(root)
	if _, err := os.Stat(nodePath); err != nil {
		return fail(fmt.Errorf("bundled Node.js runtime is unavailable at %q: %w", nodePath, err))
	}
	envFile := os.Getenv("RELAY_MONITOR_ENV_FILE")
	if envFile == "" {
		envFile = filepath.Join(root, ".env")
	} else if !filepath.IsAbs(envFile) {
		envFile = filepath.Join(root, envFile)
	}
	envFile, err = filepath.Abs(envFile)
	if err != nil {
		return fail(fmt.Errorf("cannot resolve environment file: %w", err))
	}
	if _, err := os.Stat(envFile); err != nil {
		return fail(fmt.Errorf("environment file is unavailable at %q; run the setup script first: %w", envFile, err))
	}

	nodeArguments := []string{"--env-file=" + envFile, command.script}
	nodeArguments = append(nodeArguments, command.args...)
	for {
		exitCode, err := runChild(nodePath, nodeArguments, root)
		if err != nil {
			return fail(err)
		}
		if !command.restart || exitCode != managedRestartExitCode {
			return exitCode
		}
		fmt.Fprintln(os.Stderr, "Relay Monitor requested a managed restart; restarting in one second.")
		time.Sleep(time.Second)
	}
}

func executableRoot() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("cannot locate launcher executable: %w", err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return "", fmt.Errorf("cannot resolve launcher executable: %w", err)
	}
	return filepath.Dir(executable), nil
}

func bundledNodePath(root string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(root, "runtime", "node.exe")
	}
	return filepath.Join(root, "runtime", "bin", "node")
}

func resolveCommand(name string, args []string) (launcherCommand, error) {
	switch name {
	case "start":
		if len(args) != 0 {
			return launcherCommand{}, errors.New("start does not accept arguments")
		}
		return launcherCommand{
			script:  filepath.FromSlash("dist/server/backend/server.js"),
			restart: true,
		}, nil
	case "migrate":
		return launcherCommand{
			script: filepath.FromSlash("dist/server/backend/cli/migrate.js"),
			args:   args,
		}, nil
	case "admin":
		return launcherCommand{
			script: filepath.FromSlash("dist/server/backend/cli/admin.js"),
			args:   args,
		}, nil
	case "master-key":
		return launcherCommand{
			script: filepath.FromSlash("dist/server/backend/cli/master-key.js"),
			args:   args,
		}, nil
	default:
		return launcherCommand{}, fmt.Errorf("unknown command %q", name)
	}
}

func runChild(executable string, args []string, root string) (int, error) {
	command := exec.Command(executable, args...)
	command.Dir = root
	command.Env = os.Environ()
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return 1, fmt.Errorf("cannot start bundled Node.js runtime: %w", err)
	}
	stopForwarding := startSignalForwarding(command)
	err := command.Wait()
	stopForwarding()
	if err == nil {
		return 0, nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		exitCode := exitError.ExitCode()
		if exitCode >= 0 {
			return exitCode, nil
		}
		return 1, nil
	}
	return 1, fmt.Errorf("bundled Node.js process failed: %w", err)
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "Usage: RelayMonitor [start|migrate|admin|master-key|version]")
	fmt.Fprintln(os.Stderr, "  start                         Start Relay Monitor (default)")
	fmt.Fprintln(os.Stderr, "  migrate                       Apply database migrations")
	fmt.Fprintln(os.Stderr, "  admin <create|reset-password> Manage the administrator")
	fmt.Fprintln(os.Stderr, "  master-key <rotate|finalize>  Manage the credential master key")
	fmt.Fprintln(os.Stderr, "  version                       Print the release version")
}

func fail(err error) int {
	fmt.Fprintf(os.Stderr, "Relay Monitor: %v\n", err)
	return 1
}
