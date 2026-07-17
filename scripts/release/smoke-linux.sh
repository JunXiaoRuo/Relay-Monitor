#!/usr/bin/env bash
set -euo pipefail

archive=''
expected_version=''
expected_node_version='22.23.1'

usage() {
  echo 'Usage: smoke-linux.sh --archive <path> --expected-version <version> [--expected-node-version <version>]' >&2
}

while (($# > 0)); do
  case "$1" in
    --archive)
      (($# >= 2)) || { usage; exit 2; }
      archive=$2
      shift 2
      ;;
    --expected-version)
      (($# >= 2)) || { usage; exit 2; }
      expected_version=$2
      shift 2
      ;;
    --expected-node-version)
      (($# >= 2)) || { usage; exit 2; }
      expected_node_version=$2
      shift 2
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

[[ -f $archive && -n $expected_version ]] || { usage; exit 2; }
archive=$(cd -- "$(dirname -- "$archive")" && pwd)/$(basename -- "$archive")
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/relay-monitor-smoke.XXXXXXXX")
extract_directory="$temporary_root/extract"
server_pid=''
mkdir -p "$extract_directory"

cleanup() {
  if [[ -n $server_pid ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    for _ in {1..60}; do
      kill -0 "$server_pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$server_pid" 2>/dev/null; then
      kill -KILL "$server_pid" 2>/dev/null || true
    fi
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

archive_entries=$(tar -tzf "$archive")
if printf '%s\n' "$archive_entries" | grep -Eq '^[^/]+/\.env$|^[^/]+/data(/|$)|\.map$'; then
  echo 'Release archive contains .env, data, or source maps' >&2
  exit 1
fi
tar -xzf "$archive" -C "$extract_directory"
mapfile -t roots < <(find "$extract_directory" -mindepth 1 -maxdepth 1 -type d)
((${#roots[@]} == 1)) || { echo "Expected one package directory, found ${#roots[@]}" >&2; exit 1; }
root=${roots[0]}
launcher="$root/relay-monitor"
node="$root/runtime/bin/node"

for required in \
  "$launcher" \
  "$node" \
  "$root/runtime/LICENSE.node.txt" \
  "$root/dist/web/index.html" \
  "$root/dist/server/backend/server.js" \
  "$root/dist/server/backend/db/migrations/meta/_journal.json" \
  "$root/.env.example" \
  "$root/README.md" \
  "$root/VERSION" \
  "$root/service/monitor.env.example" \
  "$root/service/relay-monitor.service.example" \
  "$root/setup.sh"; do
  [[ -f $required ]] || { echo "Missing packaged file: $required" >&2; exit 1; }
done
[[ -x $launcher && -x $node && -x $root/setup.sh ]] || { echo 'Packaged executables lost their execute bit' >&2; exit 1; }

actual_version=$($launcher version)
[[ $actual_version == "$expected_version" ]] || { echo "Launcher version mismatch: $actual_version" >&2; exit 1; }
actual_node_version=$($node --version)
actual_node_version=${actual_node_version#v}
[[ $actual_node_version == "$expected_node_version" ]] || { echo "Node.js version mismatch: $actual_node_version" >&2; exit 1; }

(
  cd "$root"
  "$node" -e 'const argon2=require("argon2");const Database=require("better-sqlite3");(async()=>{const hash=await argon2.hash("release-smoke-password");if(!await argon2.verify(hash,"release-smoke-password"))throw new Error("argon2 verification failed");const db=new Database(":memory:");db.exec("create table smoke(value integer);insert into smoke values (1)");if(db.prepare("select value from smoke").get().value!==1)throw new Error("better-sqlite3 query failed");db.close()})().catch(error=>{console.error(error);process.exit(1)})'
  ./setup.sh --non-interactive
)

port=$($node -e 'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close()})')
$node -e '
  const fs=require("node:fs");
  const file=process.argv[1];
  const port=process.argv[2];
  let value=fs.readFileSync(file,"utf8");
  value=value.replace(/^HOST=.*$/m,"HOST=127.0.0.1")
    .replace(/^PORT=.*$/m,`PORT=${port}`);
  fs.writeFileSync(file,value,{mode:0o600});
' "$root/.env" "$port"

(
  cd "$root"
  exec ./relay-monitor start >"$temporary_root/server.stdout.log" 2>"$temporary_root/server.stderr.log"
) &
server_pid=$!
ready=0
for _ in {1..120}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  if curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if ((ready == 0)); then
  echo 'Relay Monitor did not become ready' >&2
  echo 'STDOUT:' >&2
  cat "$temporary_root/server.stdout.log" >&2 || true
  echo 'STDERR:' >&2
  cat "$temporary_root/server.stderr.log" >&2 || true
  exit 1
fi
curl --fail --silent --show-error --max-time 5 \
  "http://127.0.0.1:$port/" --output "$temporary_root/index.html"
grep -qi '<!doctype html' "$temporary_root/index.html"

kill -TERM "$server_pid"
for _ in {1..60}; do
  kill -0 "$server_pid" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$server_pid" 2>/dev/null; then
  kill -KILL "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  server_pid=''
  echo 'Relay Monitor did not stop cleanly after SIGTERM' >&2
  exit 1
fi
set +e
wait "$server_pid"
server_exit_code=$?
set -e
server_pid=''
if ((server_exit_code != 0)); then
  echo "Relay Monitor exited with code $server_exit_code after SIGTERM" >&2
  cat "$temporary_root/server.stdout.log" >&2 || true
  cat "$temporary_root/server.stderr.log" >&2 || true
  exit 1
fi

(
  cd "$root"
  "$node" -e 'const Database=require("better-sqlite3");const db=new Database("./data/monitor.db",{readonly:true});const quick=db.pragma("quick_check");if(quick.some(row=>Object.values(row)[0]!=="ok"))throw new Error("SQLite quick_check failed");if(db.pragma("foreign_key_check").length)throw new Error("SQLite foreign_key_check failed");db.close()'
)
echo "Linux release smoke test passed: $archive"
