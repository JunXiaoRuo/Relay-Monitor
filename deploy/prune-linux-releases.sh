#!/usr/bin/env bash
set -euo pipefail

releases_dir="${RELAY_MONITOR_RELEASES_DIR:-/opt/relay-monitor/releases}"
current_link="${RELAY_MONITOR_CURRENT_LINK:-/opt/relay-monitor/current}"
keep_count="${RELAY_MONITOR_KEEP_RELEASES:-2}"
apply=false

if [[ "${1:-}" == "--apply" ]]; then
  apply=true
elif [[ -n "${1:-}" ]]; then
  echo "用法: $0 [--apply]" >&2
  exit 2
fi

if [[ ! "$keep_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "RELAY_MONITOR_KEEP_RELEASES 必须是正整数" >&2
  exit 2
fi

releases_root="$(readlink -f -- "$releases_dir")"
current_release="$(readlink -f -- "$current_link")"
if [[ -z "$releases_root" || -z "$current_release" || ! -d "$releases_root" || ! -d "$current_release" ]]; then
  echo "版本目录或 current 软链接无效" >&2
  exit 1
fi
case "$current_release/" in
  "$releases_root"/*/) ;;
  *) echo "current 不在版本目录内，拒绝清理" >&2; exit 1 ;;
esac

mapfile -d '' releases < <(
  find "$releases_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\0' \
    | sort -z -nr \
    | cut -z -d' ' -f2-
)

declare -A retained=(["$current_release"]=1)
retained_count=1
for release in "${releases[@]}"; do
  resolved="$(readlink -f -- "$release")"
  [[ "$resolved" == "$current_release" ]] && continue
  if (( retained_count < keep_count )); then
    retained["$resolved"]=1
    ((retained_count += 1))
  fi
done

for release in "${releases[@]}"; do
  resolved="$(readlink -f -- "$release")"
  case "$resolved/" in
    "$releases_root"/*/) ;;
    *) echo "跳过版本目录外路径: $resolved" >&2; continue ;;
  esac
  if [[ -n "${retained[$resolved]:-}" ]]; then
    echo "保留: $resolved"
  elif $apply; then
    rm -rf -- "$resolved"
    echo "已删除: $resolved"
  else
    echo "待删除: $resolved"
  fi
done

if ! $apply; then
  echo "当前为预览；确认后使用 --apply 执行。"
fi
