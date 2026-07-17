#!/usr/bin/env bash
set -euo pipefail

version=''
output_directory='artifacts'
node_version='22.23.1'
skip_application_build=0

usage() {
  echo 'Usage: build-linux.sh --version <version> [--output-dir <directory>] [--node-version <22.x.y>] [--skip-application-build]' >&2
}

while (($# > 0)); do
  case "$1" in
    --version)
      (($# >= 2)) || { usage; exit 2; }
      version=$2
      shift 2
      ;;
    --output-dir)
      (($# >= 2)) || { usage; exit 2; }
      output_directory=$2
      shift 2
      ;;
    --node-version)
      (($# >= 2)) || { usage; exit 2; }
      node_version=$2
      shift 2
      ;;
    --skip-application-build)
      skip_application_build=1
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

[[ $version =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || { echo "Unsupported version: $version" >&2; exit 2; }
[[ $node_version =~ ^22\.[0-9]+\.[0-9]+$ ]] || { echo "Node version must be a Node.js 22 release: $node_version" >&2; exit 2; }
[[ $(uname -m) == 'x86_64' ]] || { echo 'Linux x64 release must be built on x86_64' >&2; exit 1; }
build_node_version=$(node -p 'process.versions.node')
if [[ $build_node_version =~ ^22\.([0-9]+)\.[0-9]+$ ]]; then
  build_node_minor=${BASH_REMATCH[1]}
else
  build_node_minor=0
fi
if ((10#$build_node_minor < 19)); then
  echo "Release builds require Node.js 22.19 or newer in the 22.x line; found $build_node_version" >&2
  exit 1
fi

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ $output_directory != /* ]]; then
  output_directory="$repository_root/$output_directory"
fi
mkdir -p "$output_directory"
output_directory=$(cd -- "$output_directory" && pwd)

package_name="relay-monitor-$version-linux-x64"
artifact_path="$output_directory/$package_name.tar.gz"
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/relay-monitor-release.XXXXXXXX")
stage="$temporary_root/$package_name"
trap 'rm -rf -- "$temporary_root"' EXIT
mkdir -p "$stage/service" "$stage/runtime/bin"

if ((skip_application_build == 0)); then
  (cd "$repository_root" && corepack pnpm build)
fi

for required in dist package.json pnpm-lock.yaml pnpm-workspace.yaml; do
  [[ -e "$repository_root/$required" ]] || { echo "Missing release input: $required" >&2; exit 1; }
done
cp -R "$repository_root/dist" "$stage/dist"
cp "$repository_root/package.json" "$repository_root/pnpm-lock.yaml" "$repository_root/pnpm-workspace.yaml" "$stage/"
cp "$repository_root/packaging/portable.env.example" "$stage/.env.example"
cp "$repository_root/packaging/README.md" "$stage/README.md"
cp "$repository_root/packaging/linux/setup.sh" "$stage/setup.sh"
cp "$repository_root/packaging/linux/relay-monitor.service.example" "$stage/service/relay-monitor.service.example"
cp "$repository_root/packaging/linux/monitor.env.service.example" "$stage/service/monitor.env.example"
[[ ! -f "$repository_root/LICENSE" ]] || cp "$repository_root/LICENSE" "$stage/LICENSE"
printf '%s\n' "$version" > "$stage/VERSION"
find "$stage/dist" -type f -name '*.map' -delete

(
  cd "$stage"
  corepack pnpm install --prod --frozen-lockfile \
    --config.node-linker=hoisted --config.package-import-method=copy
)
find "$stage" -type f -name '*.map' -delete

runtime_archive_name="node-v$node_version-linux-x64.tar.xz"
runtime_archive="$temporary_root/$runtime_archive_name"
checksums_file="$temporary_root/SHASUMS256.txt"
curl --fail --silent --show-error --location \
  "https://nodejs.org/dist/v$node_version/$runtime_archive_name" \
  --output "$runtime_archive"
curl --fail --silent --show-error --location \
  "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" \
  --output "$checksums_file"
expected_checksum=$(awk -v name="$runtime_archive_name" '$2 == name || $2 == "*" name { print $1; exit }' "$checksums_file")
[[ -n $expected_checksum ]] || { echo "Official checksum for $runtime_archive_name was not found" >&2; exit 1; }
actual_checksum=$(sha256sum "$runtime_archive" | awk '{print $1}')
[[ $actual_checksum == "$expected_checksum" ]] || { echo "Node.js runtime checksum mismatch" >&2; exit 1; }
tar -xJf "$runtime_archive" -C "$temporary_root"
extracted_runtime="$temporary_root/node-v$node_version-linux-x64"
cp "$extracted_runtime/bin/node" "$stage/runtime/bin/node"
cp "$extracted_runtime/LICENSE" "$stage/runtime/LICENSE.node.txt"
printf '%s\n' "$node_version" > "$stage/runtime/VERSION"

(
  cd "$repository_root/packaging/launcher"
  CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$version" \
    -o "$stage/relay-monitor" .
)
chmod 755 "$stage/relay-monitor" "$stage/runtime/bin/node" "$stage/setup.sh"

[[ ! -e "$stage/.env" ]] || { echo 'Release staging unexpectedly contains .env' >&2; exit 1; }
[[ ! -e "$stage/data" ]] || { echo 'Release staging unexpectedly contains data' >&2; exit 1; }
if find "$stage" -type f -name '*.map' -print -quit | grep -q .; then
  echo 'Release staging unexpectedly contains source maps' >&2
  exit 1
fi

rm -f -- "$artifact_path"
tar -C "$temporary_root" -czf "$artifact_path" "$package_name"
echo "Created $artifact_path"
