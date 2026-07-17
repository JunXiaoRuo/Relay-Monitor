#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
environment_example="$root/.env.example"
environment_file="$root/.env"
launcher="$root/relay-monitor"
web_origin=''

usage() {
  echo "Usage: ./setup.sh [--web-origin <origin>] [--non-interactive]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --web-origin)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      web_origin=$2
      shift 2
      ;;
    --non-interactive)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[ -f "$environment_example" ] || { echo "Missing $environment_example" >&2; exit 1; }
[ -x "$launcher" ] || { echo "Missing executable launcher at $launcher" >&2; exit 1; }
[ -x "$root/runtime/bin/node" ] || { echo "Missing bundled Node.js runtime" >&2; exit 1; }

if [ ! -f "$environment_file" ]; then
  cp "$environment_example" "$environment_file"
fi

if [ -n "$web_origin" ]; then
  "$root/runtime/bin/node" -e '
    const value = process.argv[1];
    const file = process.argv[2];
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("WEB_ORIGIN must contain only HTTP(S) protocol, host, and optional port");
    }
    const fs = require("node:fs");
    let contents = fs.readFileSync(file, "utf8");
    contents = /^WEB_ORIGIN=.*$/m.test(contents)
      ? contents.replace(/^WEB_ORIGIN=.*$/m, `WEB_ORIGIN=${value}`)
      : `${contents.replace(/[\r\n]+$/, "")}\nWEB_ORIGIN=${value}\n`;
    fs.writeFileSync(file, contents, { mode: 0o600 });
  ' "$web_origin" "$environment_file"
fi
chmod 600 "$environment_file"

configured_key_path=$(sed -n 's/^MASTER_KEY_FILE=//p' "$environment_file" | tail -n 1 | tr -d '\r')
configured_key_path=$(printf '%s' "$configured_key_path" | sed 's/^['"'"'"]//;s/['"'"'"]$//')
[ -n "$configured_key_path" ] || { echo 'MASTER_KEY_FILE is missing from .env' >&2; exit 1; }
case "$configured_key_path" in
  /*) key_path=$configured_key_path ;;
  *) key_path="$root/$configured_key_path" ;;
esac
key_directory=$(dirname -- "$key_path")
umask 077
mkdir -p "$key_directory"
chmod 700 "$key_directory"
created_key=0
if [ -L "$key_path" ]; then
  echo "Master key path must not be a symbolic link: $key_path" >&2
  exit 1
fi
if [ -e "$key_path" ] && [ ! -f "$key_path" ]; then
  echo "Master key path must be a regular file: $key_path" >&2
  exit 1
fi
if [ ! -e "$key_path" ]; then
  "$root/runtime/bin/node" -e '
    const fs = require("node:fs");
    const { randomBytes } = require("node:crypto");
    const key = randomBytes(32);
    try {
      fs.writeFileSync(process.argv[1], key, { flag: "wx", mode: 0o600 });
    } finally {
      key.fill(0);
    }
  ' "$key_path"
  created_key=1
fi
chmod 600 "$key_path"
"$root/runtime/bin/node" --input-type=module -e '
  import { pathToFileURL } from "node:url";
  try {
    const modulePath = process.argv[1];
    const keyPath = process.argv[2];
    const { loadMasterKeyRing } = await import(pathToFileURL(modulePath).href);
    const keyring = loadMasterKeyRing({ filePath: keyPath, environment: "production" }, 1);
    for (const key of keyring.keys.values()) key.fill(0);
    keyring.keys.clear();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Master key validation failed");
    process.exitCode = 1;
  }
' "$root/dist/server/backend/core/vault.js" "$key_path"
if [ "$created_key" -eq 1 ]; then
  echo "A new master key was created and validated at $key_path"
else
  echo "Keeping the validated master key at $key_path"
fi

"$launcher" migrate
echo 'Setup complete.'
echo 'Create the first administrator with:'
echo '  ./relay-monitor admin create --username admin --display-name "Administrator"'
echo 'Start Relay Monitor with:'
echo '  ./relay-monitor start'
