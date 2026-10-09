#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

# BEGIN CI RELEASE HELPERS -- keep embedded copies identical to deploy/release-common.sh
# Only discovery uses latest; the archive is always fetched from its immutable commit tag.
ci_release_resolve() {
  local repository=$1 workspace=$2 manifest values
  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  CI_RELEASE_REPOSITORY=$repository
  # shellcheck disable=SC2034 # Part of the shared installer interface.
  CI_RELEASE_WORK=$workspace
  mkdir -p -- "$workspace" || return 1
  manifest="$workspace/release-manifest.json"
  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --connect-timeout 15 --max-time 90 --max-filesize 1048576 \
    "https://github.com/$repository/releases/latest/download/release-manifest.json" -o "$manifest"; then
    printf '[CI] %s 暂无可用部署清单或下载失败；现有服务保持原样。\n' "$repository" >&2
    return 1
  fi
  values=$(python3 - "$manifest" "$repository" "$(uname -m)" <<'CI_MANIFEST_PY'
import json, re, sys
from pathlib import Path
def require(condition, message):
    if not condition:
        raise ValueError(message)
try:
    data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    architecture = {'x86_64': 'linux-x64', 'aarch64': 'linux-arm64', 'arm64': 'linux-arm64'}[sys.argv[3]]
    require(type(data['schema']) is int and data['schema'] == 1 and data['repository'] == sys.argv[2], 'repository/schema mismatch')
    commit = data['commit']
    require(re.fullmatch(r'[a-f0-9]{40}', commit), 'invalid commit')
    require(data['tag'] == 'deploy-' + commit, 'tag/commit mismatch')
    item = data['artifacts'][architecture]
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz', item['file']), 'invalid archive name')
    for key in ('sha256', 'application_key'):
        require(re.fullmatch(r'[a-f0-9]{64}', item[key]), 'invalid ' + key)
    node = data.get('node_version', '')
    require(not node or re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', node), 'invalid Node version')
    print('\n'.join([commit, data['tag'], item['file'], item['sha256'], item['application_key'], node]))
except (OSError, ValueError, KeyError, TypeError, AssertionError) as error:
    print('[CI] Invalid deployment manifest: ' + str(error), file=sys.stderr)
    sys.exit(1)
CI_MANIFEST_PY
  ) || return 1
  local -a fields
  mapfile -t fields <<< "$values"
  CI_RELEASE_COMMIT=${fields[0]}
  CI_RELEASE_TAG=${fields[1]}
  CI_RELEASE_FILE=${fields[2]}
  CI_RELEASE_SHA256=${fields[3]}
  CI_RELEASE_APPLICATION_KEY=${fields[4]}
  # shellcheck disable=SC2034 # Python applications do not consume the Node version.
  CI_RELEASE_NODE_VERSION=${fields[5]:-}
  printf '[CI] %s 最新可用部署包：%s。\n' "$repository" "${CI_RELEASE_COMMIT:0:12}"
}

ci_release_extract() {
  local cache=$1 destination=$2 archive temporary actual
  [[ ! -L "$cache" && ( ! -e "$cache" || -d "$cache" ) ]] || { printf '[CI] Invalid archive cache.\n' >&2; return 1; }
  mkdir -p -- "$cache" || return 1
  [[ $(stat -c %u "$cache") == "$EUID" ]] || { printf '[CI] Archive cache has an unexpected owner.\n' >&2; return 1; }
  archive="$cache/$CI_RELEASE_SHA256.tar.gz"
  [[ ! -L "$archive" && ( ! -e "$archive" || -f "$archive" ) ]] || return 1
  actual=''
  if [[ -f "$archive" ]]; then actual=$(sha256sum "$archive" | cut -d ' ' -f1) || return 1; fi
  if [[ "$actual" != "$CI_RELEASE_SHA256" ]]; then
    temporary=$(mktemp "$cache/.download.XXXXXXXX") || return 1
    if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --retry 3 --connect-timeout 15 --max-time 600 --max-filesize 2147483648 \
      "https://github.com/$CI_RELEASE_REPOSITORY/releases/download/$CI_RELEASE_TAG/$CI_RELEASE_FILE" -o "$temporary"; then
      rm -f -- "$temporary"
      return 1
    fi
    actual=$(sha256sum "$temporary" | cut -d ' ' -f1) || { rm -f -- "$temporary"; return 1; }
    if [[ "$actual" != "$CI_RELEASE_SHA256" ]]; then
      printf '[CI] 部署包校验失败；现有服务保持原样。\n' >&2
      rm -f -- "$temporary"
      return 1
    fi
    chmod 0644 "$temporary" || { rm -f -- "$temporary"; return 1; }
    mv -f -- "$temporary" "$archive" || return 1
  else
    printf '[CI] 部署包已缓存且校验通过，跳过下载。\n'
  fi
  python3 - "$archive" "$destination" "$CI_RELEASE_COMMIT" "$CI_RELEASE_APPLICATION_KEY" <<'CI_EXTRACT_PY'
import os, shutil, sys, tarfile
from pathlib import Path, PurePosixPath
def require(condition, message):
    if not condition:
        raise ValueError(message)
try:
    destination = Path(sys.argv[2])
    require(not destination.is_symlink(), 'destination cannot be a symlink')
    destination.mkdir(parents=True, exist_ok=True)
    require(not any(destination.iterdir()), 'destination must be empty')
    with tarfile.open(sys.argv[1], 'r:gz') as archive:
        members = []
        names, total = set(), 0
        for member in archive:
            require(len(members) < 200000, 'too many archive entries')
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and '..' not in path.parts and '\\' not in member.name and ':' not in member.name, 'unsafe archive path')
            require(member.isdir() or member.isfile(), 'archive links and special files are forbidden')
            name = str(path)
            require(name not in names, 'duplicate archive entry')
            names.add(name)
            total += member.size
            require(0 <= member.size and total <= 2147483648, 'archive too large')
            members.append(member)
        for member in members:
            path = destination.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
                path.chmod(0o755)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, path.open('xb') as target:
                    shutil.copyfileobj(source, target)
                path.chmod(0o755 if member.mode & 0o111 else 0o644)
    destination.chmod(0o755)
    for directory in destination.rglob('*'):
        if directory.is_dir():
            directory.chmod(0o755)
    require((destination / '.release-commit').read_text().strip() == sys.argv[3], 'archive commit mismatch')
    require((destination / '.release-application-key').read_text().strip() == sys.argv[4], 'archive application key mismatch')
except (OSError, ValueError, EOFError, tarfile.TarError, AssertionError) as error:
    print('[CI] Invalid deployment archive: ' + str(error), file=sys.stderr)
    sys.exit(1)
CI_EXTRACT_PY
}
# END CI RELEASE HELPERS

APP_ROOT=/opt/asset-ledger
DATA_DIR=/var/lib/asset-ledger
APP_USER=asset-ledger
REPO_URL=https://github.com/hxx344/asset-ledger.git
NODE_VERSION=24.15.0
PORT_ARG=''
BIND_ARG=''
DATA_FILE=''
BACKUP_KEEP_ARG=''
BACKUP_KEEP=7
CLEANUP_ONLY=0
DEPLOY_MODE=${PROJECT_DEPLOY_MODE:-source}
REBUILD=0
RELEASE='' NEW_RELEASE='' PREVIOUS='' BACKUP='' DOWNLOAD='' SWITCHED=0 WAS_ACTIVE=0
CURRENT='' RUNNING='' SOURCE_DIR='' KEEP_RELEASE=''
MOUNT_TARGETS='' BUILD_CACHE='' ARTIFACT_COMMIT=''

# Increment only when the produced release format changes, not for installer edits.
BUILD_RECIPE=asset-standalone-v2
atomic_stamp() {
  local target=$1 value=$2 temporary
  temporary=$(mktemp "${target}.XXXXXX")
  printf '%s\n' "$value" > "$temporary"
  chmod 0640 "$temporary"
  mv -f -- "$temporary" "$target"
}
build_environment_key() {
  # Match the actual build account/environment, but ignore invocation-only context.
  # Only the digest is persisted; environment values (including secrets) stay private.
  as_app node --input-type=module -e '
    import { createHash } from "node:crypto";
    const context = new Set([
      "PWD", "OLDPWD", "SHLVL", "_", "SUDO_COMMAND", "SUDO_USER", "SUDO_UID", "SUDO_GID", "SUDO_PS1",
      "TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "VTE_VERSION", "LS_COLORS", "LESSOPEN", "LESSCLOSE",
      "SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_TTY",
      "XDG_SESSION_ID", "XDG_SESSION_CLASS", "XDG_SESSION_TYPE", "XDG_SEAT", "XDG_VTNR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
      "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "WINDOWID", "WT_SESSION", "WT_PROFILE_ID", "SESSIONNAME", "TMUX", "TMUX_PANE", "STY", "WINDOW"
    ]);
    const values = Object.entries(process.env).filter(([key]) => !context.has(key)).sort(([a], [b]) => a.localeCompare(b));
    console.log(createHash("sha256").update(JSON.stringify(values)).digest("hex"));'
}
calculate_keys() {
  local environment_key=$1 configuration_key
  dependency_key=$({
    printf '%s\n' "$NODE_DIST" "$(node --version)" "$(npm --version)"
    git --git-dir="$APP_ROOT/source.git" ls-tree -r "$COMMIT" -- package.json package-lock.json .npmrc scripts/prepare-ledger.mjs
  } | sha256sum | cut -d' ' -f1)
  configuration_key=$(git --git-dir="$APP_ROOT/source.git" ls-tree -r "$COMMIT" | awk -F '\t' '$2 ~ /^(next|postcss|tailwind)\.config\./ || $2 ~ /^tsconfig/ || $2 ~ /^\.env/' | sha256sum | cut -d' ' -f1)
  # Default to including tracked inputs, including future source folders and build
  # configuration. Only known non-runtime paths are excluded.
  source_key=$({
    printf '%s\n' "$BUILD_RECIPE" "$dependency_key" "$environment_key"
    git --git-dir="$APP_ROOT/source.git" ls-tree -r "$COMMIT" | awk -F '\t' '$2 != "README.md" && $2 != "install.sh" && $2 !~ /^(docs|tests|\.github)\//'
  } | sha256sum | cut -d' ' -f1)
  cache_key=$(printf '%s\n' "$BUILD_RECIPE" "$dependency_key" "$configuration_key" "$environment_key" | sha256sum | cut -d' ' -f1)
}
dependency_sizes() {
  local path=$1 expected=$2 key kb inodes extra
  [[ -f $path/.install-dependency-sizes ]] || return 1
  read -r key kb inodes extra < "$path/.install-dependency-sizes" || return 1
  [[ $key == "$expected" && $kb =~ ^[1-9][0-9]*$ && $inodes =~ ^[1-9][0-9]*$ && -z $extra ]] || return 1
  DEPENDENCY_KB=$kb DEPENDENCY_INODES=$inodes
}
prepare_build_cache() {
  local root=$APP_ROOT/build-cache
  [[ ! -L $root ]] || die '构建缓存根目录不应为符号链接。'
  install -d -m 0755 "$root"
  BUILD_CACHE=$root/$cache_key
  [[ ! -L $BUILD_CACHE && ( ! -e $BUILD_CACHE || -d $BUILD_CACHE ) ]] || die '构建缓存路径无效。'
  [[ $(realpath -m -- "$BUILD_CACHE") == "$BUILD_CACHE" ]] || die '构建缓存路径无效。'
  install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$BUILD_CACHE"
  touch "$BUILD_CACHE/.install-cache"
  as_app mkdir -p "$RELEASE/.next"
  as_app ln -s "$BUILD_CACHE" "$RELEASE/.next/cache"
  printf 'Next 构建缓存：%s（按依赖、运行时、配置和环境分区）。\n' "$cache_key"
}

read_mounts() {
  MOUNT_TARGETS=$(findmnt --raw --noheadings --output TARGET) || die '无法确认挂载点，已停止清理。'
}
contains_mount() {
  local path=$1 target
  while IFS= read -r target; do
    printf -v target '%b' "$target"
    [[ $target != "$path" && $target != "$path/"* ]] || return 0
  done <<< "$MOUNT_TARGETS"
  return 1
}

# Cleanup only accepts installer-owned real directories; symlinks and unknown files stay.
managed_release() {
  local path=$1 name=${1##*/}
  [[ $name =~ ^[0-9a-f]{12}\.[A-Za-z0-9]{6}$ && -d $path && ! -L $path && ${path%/*} == "$APP_ROOT/releases" && $(realpath -- "$path") == "$path" ]] || return 1
  ! contains_mount "$path" || return 1
  [[ -f $path/.install-owned || ( -f $path/package-lock.json && -f $path/scripts/backup.mjs && -f $path/install.sh ) ]]
}
ready_release() {
  [[ -f $1/.next/standalone/server.js && -f $1/.next/BUILD_ID ]] || return 1
  [[ -f $1/.install-ready || ! -f $1/.install-owned ]]
}
protects_path() {
  local path=$1 protected
  for protected in "$CURRENT" "$RUNNING" "$SOURCE_DIR" "$DATA_FILE" "$NEW_RELEASE"; do
    [[ -z $protected || ( $protected != "$path" && $protected != "$path/"* ) ]] || return 0
  done
  # Data ancestors and descendants must both survive cleanup.
  [[ $DATA_DIR == / || $path == "$DATA_DIR" || $path == "$DATA_DIR/"* || $DATA_DIR == "$path/"* ]]
}
read_protection() {
  local pid
  CURRENT=$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)
  RUNNING=''
  if ! pid=$(systemctl show --property=MainPID --value asset-ledger.service 2>/dev/null); then
    [[ ! -f /etc/systemd/system/asset-ledger.service ]] || die '无法确认服务进程，已停止清理。'
    pid=0
  fi
  [[ -n $pid || -f /etc/systemd/system/asset-ledger.service ]] || pid=0
  [[ $pid =~ ^[0-9]+$ ]] || die '无法确认服务进程，已停止清理。'
  if [[ $pid =~ ^[1-9][0-9]*$ ]]; then
    RUNNING=$(readlink -f "/proc/$pid/cwd") || die '无法确认运行版本，已停止清理。'
  fi
}
prune_releases() {
  local path stamp newest=-1 removed=0
  KEEP_RELEASE=''
  [[ ! -d $APP_ROOT/releases ]] && return 0
  [[ ! -L $APP_ROOT/releases && $(realpath -- "$APP_ROOT/releases") == "$APP_ROOT/releases" ]] || die '版本目录不应为符号链接。'
  read_protection
  if [[ -n $PREVIOUS && $PREVIOUS != "$CURRENT" ]] && managed_release "$PREVIOUS" && ready_release "$PREVIOUS"; then
    KEEP_RELEASE=$PREVIOUS
  else
    for path in "$APP_ROOT/releases/"*; do
      managed_release "$path" && ready_release "$path" && [[ $path != "$CURRENT" ]] || continue
      stamp=$(stat -c %Y "$path/.install-ready" 2>/dev/null || stat -c %Y "$path/.next/BUILD_ID")
      if ((stamp > newest)); then newest=$stamp; KEEP_RELEASE=$path; fi
    done
  fi
  for path in "$APP_ROOT/releases/"*; do
    managed_release "$path" || continue
    [[ $path != "$KEEP_RELEASE" ]] && ! protects_path "$path" || continue
    rm -rf --one-file-system -- "$path"
    removed=$((removed + 1))
  done
  printf '已回收 %s 个旧版本；当前、运行中和回退版本已保留。\n' "$removed"
}
managed_backup() {
  local path=$1 name=${1##*/}
  [[ $name =~ ^[0-9]{8}T[0-9]{6}Z(\.[A-Za-z0-9]{6})?$ && -d $path && ! -L $path && ${path%/*} == "$APP_ROOT/backups" && $(realpath -- "$path") == "$path" ]] || return 1
  ! contains_mount "$path" || return 1
  [[ -f $path/.install-owned || ( -f $path/config.json && -f $path/ledger.sqlite && -f $path/deploy.env && -f $path/asset-ledger.service ) ]]
}
backup_referenced() {
  local path=$1 release reference
  [[ $path != "$BACKUP" ]] || return 0
  for release in "$APP_ROOT/releases/"*; do
    managed_release "$release" || continue
    [[ -f $release/.install-rollback-backup ]] || continue
    reference=$(cat "$release/.install-rollback-backup")
    [[ $reference != "${path##*/}" ]] || return 0
  done
  return 1
}
prune_backups() {
  local path count=0 removed=0
  [[ ! -d $APP_ROOT/backups ]] && return 0
  [[ ! -L $APP_ROOT/backups && $(realpath -- "$APP_ROOT/backups") == "$APP_ROOT/backups" ]] || die '备份目录不应为符号链接。'
  while IFS= read -r path; do
    managed_backup "$path" || continue
    if [[ -f $path/.install-owned && ! -f $path/.install-complete ]]; then
      protects_path "$path" && continue
      backup_referenced "$path" && continue
      rm -rf --one-file-system -- "$path"
      removed=$((removed + 1))
      continue
    fi
    count=$((count + 1))
    ((count > BACKUP_KEEP)) || continue
    protects_path "$path" && continue
    backup_referenced "$path" && continue
    rm -rf --one-file-system -- "$path"
    removed=$((removed + 1))
  done < <(printf '%s\n' "$APP_ROOT/backups/"* | LC_ALL=C sort -r)
  printf '已回收 %s 份旧部署备份；保留最近 %s 份及回滚所需备份。\n' "$removed" "$BACKUP_KEEP"
}
reclaim_caches() {
  local path release
  read_mounts
  for path in "$DATA_DIR/.npm/_cacache" "$DATA_DIR/.npm/_logs" "$DATA_DIR/.npm/_npx"; do
    [[ -d $path && ! -L $path && $(realpath -- "$path") == "$path" ]] || continue
    contains_mount "$path" && continue
    # Named npm caches are disposable; other data and import backups never are.
    [[ -z $DATA_FILE || ( $DATA_FILE != "$path" && $DATA_FILE != "$path/"* ) ]] || continue
    [[ -z $SOURCE_DIR || ( $SOURCE_DIR != "$path" && $SOURCE_DIR != "$path/"* ) ]] || continue
    rm -rf --one-file-system -- "$path"
  done
  for release in "$APP_ROOT/releases/"*; do
    managed_release "$release" || continue
    path=$release/.next/cache/webpack
    [[ -d $path && ! -L $path && $(realpath -- "$path") == "$path" ]] || continue
    contains_mount "$path" && continue
    protects_path "$path" && continue
    rm -rf --one-file-system -- "$path"
  done
  for path in "$APP_ROOT/build-cache/"*; do
    [[ ${path##*/} =~ ^[a-f0-9]{64}$ && -d $path && ! -L $path && -f $path/.install-cache && $path != "$BUILD_CACHE" ]] || continue
    [[ $(realpath -- "$path") == "$path" ]] || continue
    contains_mount "$path" && continue
    protects_path "$path" && continue
    rm -rf --one-file-system -- "$path"
  done
}
storage_stats() {
  local path=$1
  while [[ ! -d $path ]]; do path=${path%/*}; [[ -n $path ]] || path=/; done
  FREE_KB=$(df -Pk -- "$path" | awk 'END { print $4 }')
  FREE_INODES=$(df -Pi -- "$path" | awk 'END { print $4 }')
  [[ $FREE_KB =~ ^[0-9]+$ && ( $FREE_INODES =~ ^[0-9]+$ || $FREE_INODES == - ) ]] || die '无法读取剩余空间。'
}
require_space() {
  local path=$1 kb=$2 inodes=$3
  storage_stats "$path"
  if ((FREE_KB < kb)) || { [[ $FREE_INODES != - ]] && ((FREE_INODES < inodes)); }; then reclaim_caches; storage_stats "$path"; fi
  ((FREE_KB >= kb)) || die "空间不足：$path 剩余 $((FREE_KB / 1024)) MiB，至少需要 $((kb / 1024)) MiB；原服务未切换。"
  [[ $FREE_INODES == - ]] || ((FREE_INODES >= inodes)) || die "inode 不足：$path 剩余 $FREE_INODES 个，至少需要 $inodes 个；原服务未切换。"
}
check_build_space() {
  local kb=1048576 inodes=100000 build_kb=524288 value
  if [[ -n $PREVIOUS ]] && dependency_sizes "$PREVIOUS" "$dependency_key"; then
    kb=$DEPENDENCY_KB inodes=$DEPENDENCY_INODES
  fi
  if [[ -n $PREVIOUS && -f $PREVIOUS/.install-build-kb ]]; then
    value=$(cat "$PREVIOUS/.install-build-kb")
    if [[ $value =~ ^[1-9][0-9]*$ ]] && ((value > build_kb)); then build_kb=$value; fi
  fi
  require_space "$APP_ROOT/releases" "$((kb + build_kb + 786432))" "$((inodes + 25000))"
  require_space "$DATA_DIR" 524288 5000
}
check_backup_space() {
  local kb=65536 path
  for path in "$DATA_DIR/ledger.sqlite" "$DATA_DIR/ledger.sqlite-wal"; do
    [[ ! -f $path ]] || kb=$((kb + $(du --apparent-size -k -- "$path" | awk '{print $1}')))
  done
  # Temporary SQLite backup + destination, including when both share a filesystem.
  require_space "$APP_ROOT/backups" "$((kb * 2))" 128
  require_space "$DATA_DIR" "$((kb * 2))" 128
}
digest() { sha256sum "$1" | cut -d' ' -f1; }
probe_running() {
  local pid
  systemctl is-active --quiet asset-ledger || return 1
  [[ $(systemctl show --property=NeedDaemonReload --value asset-ledger.service) == no ]] || return 1
  pid=$(systemctl show --property=MainPID --value asset-ledger.service)
  [[ $pid =~ ^[1-9][0-9]*$ && $(readlink -f "/proc/$pid/cwd") == "$RELEASE/.next/standalone" ]] || return 1
  curl --fail --silent --max-time 3 "http://127.0.0.1:$PORT/api/health" | grep -Fq "\"release\":\"$ARTIFACT_COMMIT\""
}
service_unit() {
cat <<UNIT
[Unit]
Description=Personal Asset Ledger
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_ROOT/current/.next/standalone
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
Environment=ASSET_DATA_DIR=$DATA_DIR
Environment=HOSTNAME=$BIND
Environment=PORT=$PORT
Environment=ASSET_RELEASE=$ARTIFACT_COMMIT
ExecStart=$NODE_HOME/bin/node $APP_ROOT/current/.next/standalone/server.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
}
rollback() {
  systemctl stop asset-ledger || return 1
  if [[ -f $BACKUP/ledger.sqlite ]]; then
    rm -f -- "$DATA_DIR/ledger.sqlite-wal" "$DATA_DIR/ledger.sqlite-shm"
    install -m 0600 -o "$APP_USER" -g "$APP_USER" "$BACKUP/ledger.sqlite" "$DATA_DIR/ledger.sqlite" || return 1
  fi
  if [[ -n $PREVIOUS && -d $PREVIOUS ]]; then ln -sfn "$PREVIOUS" "$APP_ROOT/current" || return 1
  else rm -f -- "$APP_ROOT/current" || return 1; fi
  if [[ -f $BACKUP/deploy.env ]]; then cp -p "$BACKUP/deploy.env" "$APP_ROOT/deploy.env" || return 1
  else rm -f -- "$APP_ROOT/deploy.env" || return 1; fi
  if [[ -f $BACKUP/asset-ledger.service ]]; then cp -p "$BACKUP/asset-ledger.service" /etc/systemd/system/asset-ledger.service || return 1
  else rm -f -- /etc/systemd/system/asset-ledger.service || return 1; fi
  systemctl daemon-reload || return 1
  if ((WAS_ACTIVE)); then systemctl start asset-ledger || return 1; fi
  printf '升级失败，已恢复原版本、部署配置和数据库。\n' >&2
}
finish() {
  local status=$? recovered=1
  trap - EXIT INT TERM
  set +e
  if ((status != 0 && SWITCHED)); then rollback || { recovered=0; printf '自动恢复未完成，请查看 systemctl status asset-ledger。\n' >&2; }; fi
  if ((status != 0 && recovered)) && [[ -n $NEW_RELEASE ]] && managed_release "$NEW_RELEASE"; then
    # Only this invocation's allocation is removable, never a reused existing version.
    if ( NEW_RELEASE=''; read_mounts; read_protection; ! contains_mount "$RELEASE" && ! protects_path "$RELEASE" ); then rm -rf --one-file-system -- "$RELEASE"; fi
  fi
  if ((recovered)) && [[ -n $BACKUP && -f $DATA_DIR/.upgrade-${BACKUP##*/}.sqlite ]]; then rm -f -- "$DATA_DIR/.upgrade-${BACKUP##*/}.sqlite"; fi
  if [[ -n $DOWNLOAD && $DOWNLOAD == "$APP_ROOT/runtime/download."* && -d $DOWNLOAD && ! -L $DOWNLOAD ]]; then rm -rf --one-file-system -- "$DOWNLOAD"; fi
  exit "$status"
}

usage() {
  cat <<'HELP'
用法：sudo bash install.sh [--port 5678] [--local] [--data-file /path/资产统计.xlsx] [--backup-keep 7] [--cleanup]
Ubuntu 22.04/24.04、Debian 12/13，amd64/arm64，需 systemd。
首次安装自动生成登录密码。重复执行升级，保留配置、资产、历史和 API 加密密钥。
首次安装默认监听 127.0.0.1:5678，通过 SSH 隧道访问。
升级默认沿用原配置；旧版公网监听请加 --local 切换为仅本机。
自动保留当前版本和一份成功回退；备份保留最近 7 份及保留版本所需的回滚备份。
--backup-keep 设置并保存备份保留数量（1–365）；--cleanup 仅清理旧版本、旧部署备份及可重建缓存，不部署、不重启。
HELP
}
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
main() {
local old_port old_bind package missing=0 reused=0 built=0 dependency_key source_key cache_key unit_key
while (($#)); do
  case "$1" in
    --port) (($# >= 2)) || die '--port 缺少参数'; PORT_ARG=$2; shift 2 ;;
    --local) BIND_ARG=127.0.0.1; shift ;;
    --data-file) (($# >= 2)) || die '--data-file 缺少参数'; DATA_FILE=$2; shift 2 ;;
    --backup-keep) (($# >= 2)) || die '--backup-keep 缺少数量'; BACKUP_KEEP_ARG=$2; shift 2 ;;
    --cleanup) CLEANUP_ONLY=1; shift ;;
    --rebuild) REBUILD=1; DEPLOY_MODE=source; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done
[[ $DEPLOY_MODE == source || $DEPLOY_MODE == ci ]] || die "PROJECT_DEPLOY_MODE must be ci or source"
[[ $EUID -eq 0 ]] || die '请使用 sudo 或 root 执行。'
[[ -d /run/systemd/system ]] || die '此脚本需要 systemd。'
# shellcheck source=/dev/null
. /etc/os-release
case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;; *) die '支持 Ubuntu 22.04/24.04 和 Debian 12/13。' ;; esac
case "$(uname -m)" in x86_64) NODE_ARCH=x64 ;; aarch64|arm64) NODE_ARCH=arm64 ;; *) die '仅支持 amd64 / arm64。' ;; esac
[[ ! -e $APP_ROOT/current || -L $APP_ROOT/current ]] || die 'current 必须是安装器管理的符号链接。'
if [[ -n $DATA_FILE ]]; then
  [[ -f $DATA_FILE ]] || die '导入文件不存在。'
  DATA_FILE=$(realpath -- "$DATA_FILE")
  [[ ! -f $DATA_DIR/ledger.sqlite ]] || die '已有数据库，请去掉 --data-file 升级，再在账本页面点击「导入原表数据」选择原表 JSON 文件。'
fi
install -d -m 0755 "$APP_ROOT"
[[ ! -L $APP_ROOT && $(realpath -- "$APP_ROOT") == "$APP_ROOT" ]] || die '安装根目录不应为符号链接。'
DATA_DIR=$(realpath -m -- "$DATA_DIR")
[[ ! -f ${BASH_SOURCE[0]:-} ]] || SOURCE_DIR=$(realpath -- "$(dirname -- "${BASH_SOURCE[0]}")")
exec 9>"$APP_ROOT/install.lock"
flock -n 9 || die '另一个安装或升级正在运行。'
PORT=5678
BIND=127.0.0.1
if [[ -f $APP_ROOT/deploy.env ]]; then
  [[ $(stat -c %u "$APP_ROOT/deploy.env") == 0 ]] || die '部署配置必须归 root 所有。'
  # shellcheck source=/dev/null
  . "$APP_ROOT/deploy.env"
fi
if [[ -f $APP_ROOT/backup-keep ]]; then BACKUP_KEEP=$(cat "$APP_ROOT/backup-keep"); fi
BACKUP_KEEP=${BACKUP_KEEP_ARG:-$BACKUP_KEEP}
[[ $BACKUP_KEEP =~ ^[1-9][0-9]{0,2}$ ]] && ((BACKUP_KEEP <= 365)) || die '备份保留数量需为 1–365。'
old_port=$PORT old_bind=$BIND
PORT=${PORT_ARG:-$PORT}
BIND=${BIND_ARG:-$BIND}
[[ $PORT =~ ^[1-9][0-9]{3,4}$ ]] && ((PORT >= 1024 && PORT <= 65535)) || die '端口需为 1024–65535。'
[[ $BIND == 0.0.0.0 || $BIND == 127.0.0.1 ]] || die '监听地址无效。'
PREVIOUS=$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ((CLEANUP_ONLY)) || [[ -n $BACKUP_KEEP_ARG ]]; then
  read_mounts
  prune_releases
  prune_backups
fi
if [[ -n $BACKUP_KEEP_ARG ]]; then printf '%s\n' "$BACKUP_KEEP" > "$APP_ROOT/backup-keep"; chmod 0600 "$APP_ROOT/backup-keep"; fi
if ((CLEANUP_ONLY)); then
  reclaim_caches
  df -h -- "$APP_ROOT" /var /tmp
  df -i -- "$APP_ROOT" /var /tmp
  printf '清理完成；未部署、未重启，配置和数据已保留。\n'
  return
fi
export DEBIAN_FRONTEND=noninteractive
local -a packages=(ca-certificates curl tar xz-utils python3)
[[ $DEPLOY_MODE == ci ]] || packages+=(git)
for package in "${packages[@]}"; do [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null) == 'install ok installed' ]] || missing=1; done
if ((missing)); then
  require_space /var 524288 5000
  apt-get update -qq
  apt-get install -y -qq "${packages[@]}"
fi
id "$APP_USER" &>/dev/null || useradd --system --user-group --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
install -d -m 0755 "$APP_ROOT/releases" "$APP_ROOT/runtime"
install -d -m 0700 "$APP_ROOT/backups"

NODE_DIST="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_HOME="$APP_ROOT/runtime/$NODE_DIST"
if [[ ! -x $NODE_HOME/bin/node ]]; then
  require_space "$APP_ROOT/runtime" 524288 10000
  DOWNLOAD=$(mktemp -d "$APP_ROOT/runtime/download.XXXXXX")
  curl --fail --silent --show-error --location --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIST.tar.xz" -o "$DOWNLOAD/$NODE_DIST.tar.xz"
  curl --fail --silent --show-error --location --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$DOWNLOAD/SHASUMS256.txt"
  (cd "$DOWNLOAD" && grep -E "^[a-f0-9]{64}  ${NODE_DIST}\.tar\.xz$" SHASUMS256.txt | sha256sum --check --status) || die 'Node.js 下载校验失败。'
  tar -xJf "$DOWNLOAD/$NODE_DIST.tar.xz" -C "$DOWNLOAD"
  mv -- "$DOWNLOAD/$NODE_DIST" "$NODE_HOME"
  rm -rf --one-file-system -- "$DOWNLOAD"
  DOWNLOAD=''
fi
export PATH="$NODE_HOME/bin:$PATH"
[[ $(node --version) == "v$NODE_VERSION" ]] || die '专用 Node.js 版本不匹配。'
as_app() { runuser -u "$APP_USER" -- env PATH="$PATH" HOME="$DATA_DIR" NEXT_TELEMETRY_DISABLED=1 ASSET_DATA_DIR="$DATA_DIR" "$@"; }
if [[ $DEPLOY_MODE == ci ]]; then
  DOWNLOAD=$(mktemp -d "$APP_ROOT/runtime/download.XXXXXX")
  ci_release_resolve hxx344/asset-ledger "$DOWNLOAD" || die 'CI manifest unavailable.'
  [[ $CI_RELEASE_NODE_VERSION == "$NODE_VERSION" ]] || die 'CI Node.js version mismatch.'
  COMMIT=$CI_RELEASE_COMMIT
  dependency_key=$CI_RELEASE_APPLICATION_KEY
  source_key=$(printf '%s\n' "$dependency_key" "$NODE_DIST" ci-runtime-v1 | sha256sum | cut -d' ' -f1)
  cache_key=$source_key
else
require_space "$APP_ROOT" 65536 1024
if [[ ! -d $APP_ROOT/source.git ]]; then
  git clone --bare "$REPO_URL" "$APP_ROOT/source.git"
fi
[[ $(git --git-dir="$APP_ROOT/source.git" remote get-url origin) == "$REPO_URL" ]] || die '源码仓库地址不匹配。'
git --git-dir="$APP_ROOT/source.git" fetch --prune origin main
COMMIT=$(git --git-dir="$APP_ROOT/source.git" rev-parse --verify 'FETCH_HEAD^{commit}')
calculate_keys "$(build_environment_key)"
fi
ARTIFACT_COMMIT=$COMMIT
if (( ! REBUILD )) && [[ -n $PREVIOUS && -f $PREVIOUS/.install-build && $(cat "$PREVIOUS/.install-build") == "$source_key" && -f $PREVIOUS/.install-artifact-commit ]] && ready_release "$PREVIOUS"; then
  RELEASE=$PREVIOUS
  ARTIFACT_COMMIT=$(cat "$RELEASE/.install-artifact-commit")
  [[ $ARTIFACT_COMMIT =~ ^[a-f0-9]{40}$ ]] || die '运行产物版本标记无效。'
  unit_key=$(service_unit | sha256sum | cut -d' ' -f1)
  if [[ $PORT == "$old_port" && $BIND == "$old_bind" && -f /etc/systemd/system/asset-ledger.service && $unit_key == "$(digest /etc/systemd/system/asset-ledger.service)" ]] && probe_running; then
    systemctl is-enabled --quiet asset-ledger || systemctl enable asset-ledger
    printf '应用、环境和配置未变，服务健康；已跳过依赖安装、构建、备份和重启。运行产物：%s；已检查源码：%s。\n' "${ARTIFACT_COMMIT:0:12}" "${COMMIT:0:12}"
    return
  fi
  printf '版本未变，复用已验证构建，仅应用配置或恢复服务。\n'
else
read_mounts
prune_releases
prune_backups
if [[ $DEPLOY_MODE == ci ]]; then
  require_space "$APP_ROOT/releases" 1048576 50000
  ci_release_extract "$APP_ROOT/archive-cache" "$DOWNLOAD/package" || die "CI archive download or extraction failed."
else check_build_space; fi
RELEASE=$(mktemp -d "$APP_ROOT/releases/${COMMIT:0:12}.XXXXXX")
NEW_RELEASE=$RELEASE
touch "$RELEASE/.install-owned"
if [[ $DEPLOY_MODE == ci ]]; then
  cp -a --reflink=auto "$DOWNLOAD/package/." "$RELEASE/"
  [[ -f $RELEASE/.next/standalone/server.js && -f $RELEASE/.next/BUILD_ID && -f $RELEASE/scripts/configure.mjs && -f $RELEASE/scripts/backup.mjs ]] || die 'Incomplete CI runtime archive.'
  printf '已校验并解包 CI 运行版本，跳过项目依赖安装和现场构建。\n'
else
chown "$APP_USER:$APP_USER" "$RELEASE"
git --git-dir="$APP_ROOT/source.git" archive "$COMMIT" | as_app tar -x --no-same-owner -C "$RELEASE"
if (( ! REBUILD )) && [[ -n $PREVIOUS && -f $PREVIOUS/.install-dependencies && $(cat "$PREVIOUS/.install-dependencies") == "$dependency_key" && -f $PREVIOUS/node_modules/.package-lock.json && -x $PREVIOUS/node_modules/.bin/next && ! -L $PREVIOUS/node_modules ]]; then
  as_app cp -a --no-preserve=ownership --reflink=auto "$PREVIOUS/node_modules" "$RELEASE/node_modules"
  reused=1
  printf '依赖未变，复用独立副本。\n'
fi
prepare_build_cache
printf '正在安装依赖并构建 %s…\n' "${COMMIT:0:12}"
(cd "$RELEASE"; if ((reused)); then as_app npm run prepare; else as_app npm ci --include=dev --prefer-offline --no-audit --no-fund; fi; as_app npm run build)
RUNTIME_APP="$RELEASE/.next/standalone"
[[ -f $RUNTIME_APP/server.js ]] || die '构建未生成独立服务。'
cp -a "$RELEASE/.next/static" "$RUNTIME_APP/.next/static"
cp -a "$RELEASE/public" "$RUNTIME_APP/public"
install -d "$RUNTIME_APP/drizzle"
cp -a "$RELEASE/drizzle/." "$RUNTIME_APP/drizzle/"
fi
# The service account can write data, but cannot alter code used by privileged upgrade steps.
# One traversal; do not follow the shared build-cache or package symlinks.
find "$RELEASE" -xdev -exec chown -h "root:$APP_USER" {} + ! -type l -exec chmod u=rwX,g=rX,o= {} +
built=1
fi
if [[ -n $DATA_FILE ]]; then
  case "$DATA_FILE" in
    *.xlsx) require_space /var 262144 2000; apt-get install -y -qq python3-openpyxl
      python3 "$RELEASE/scripts/import-workbook.py" "$DATA_FILE" "$(TZ=Asia/Shanghai date +%F)" "$DATA_DIR/imported-ledger.json" ;;
    *.json) install -m 0600 "$DATA_FILE" "$DATA_DIR/imported-ledger.json" ;;
    *) die '导入文件必须为 .xlsx 或 .json。' ;;
  esac
  chown "$APP_USER:$APP_USER" "$DATA_DIR/imported-ledger.json"
fi
as_app node "$RELEASE/scripts/configure.mjs"

check_backup_space
BACKUP=$(mktemp -d "$APP_ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
touch "$BACKUP/.install-owned"
cp -p "$DATA_DIR/config.json" "$BACKUP/config.json"
if [[ -f $APP_ROOT/deploy.env ]]; then cp -p "$APP_ROOT/deploy.env" "$BACKUP/deploy.env"; fi
if [[ -f /etc/systemd/system/asset-ledger.service ]]; then cp -p /etc/systemd/system/asset-ledger.service "$BACKUP/asset-ledger.service"; fi
systemctl is-active --quiet asset-ledger && WAS_ACTIVE=1
SWITCHED=1
if ((WAS_ACTIVE)); then systemctl stop asset-ledger; fi
as_app node "$RELEASE/scripts/backup.mjs" "$DATA_DIR/.upgrade-${BACKUP##*/}.sqlite"
if [[ -f $DATA_DIR/.upgrade-${BACKUP##*/}.sqlite ]]; then
  mv -- "$DATA_DIR/.upgrade-${BACKUP##*/}.sqlite" "$BACKUP/ledger.sqlite"
  chown root:root "$BACKUP/ledger.sqlite"
  chmod 0600 "$BACKUP/ledger.sqlite"
fi
touch "$BACKUP/.install-complete"
printf 'PORT=%s\nBIND=%s\n' "$PORT" "$BIND" > "$APP_ROOT/deploy.env"
chmod 0600 "$APP_ROOT/deploy.env"
ln -sfn "$RELEASE" "$APP_ROOT/current"
unit_key=$(service_unit | sha256sum | cut -d' ' -f1)
if [[ ! -f /etc/systemd/system/asset-ledger.service || $unit_key != "$(digest /etc/systemd/system/asset-ledger.service)" ]]; then
  service_unit > /etc/systemd/system/asset-ledger.service
  systemctl daemon-reload
elif [[ $(systemctl show --property=NeedDaemonReload --value asset-ledger.service) != no ]]; then
  systemctl daemon-reload
fi
systemctl is-enabled --quiet asset-ledger || systemctl enable asset-ledger
systemctl restart asset-ledger
HEALTHY=0
for ((attempt=0; attempt<30; attempt++)); do
  if probe_running; then HEALTHY=1; break; fi
  sleep 2
done
((HEALTHY)) || die '新服务未通过健康检查。'
if ((built)); then
  if ! ((reused)) || ! dependency_sizes "$PREVIOUS" "$dependency_key"; then
    local dependencies="$RELEASE/node_modules"
    [[ $DEPLOY_MODE != ci ]] || dependencies="$RELEASE/.next/standalone/node_modules"
    DEPENDENCY_KB=$(du -sk -- "$dependencies" | awk '{print $1}')
    DEPENDENCY_INODES=$(du --inodes -s -- "$dependencies" | awk '{print $1}')
  fi
  atomic_stamp "$RELEASE/.install-dependency-sizes" "$dependency_key $DEPENDENCY_KB $DEPENDENCY_INODES"
  atomic_stamp "$RELEASE/.install-build-kb" "$(du -sk --exclude=cache -- "$RELEASE/.next" | awk '{print $1}')"
  atomic_stamp "$RELEASE/.install-dependencies" "$dependency_key"
  atomic_stamp "$RELEASE/.install-build-cache" "$cache_key"
  atomic_stamp "$RELEASE/.install-artifact-commit" "$ARTIFACT_COMMIT"
  atomic_stamp "$RELEASE/.install-build" "$source_key"
fi
atomic_stamp "$RELEASE/.install-rollback-backup" "${BACKUP##*/}"
atomic_stamp "$RELEASE/.install-unit" "$(digest /etc/systemd/system/asset-ledger.service)"
atomic_stamp "$RELEASE/.install-ready" ready
SWITCHED=0
NEW_RELEASE=''
read_mounts
prune_releases
prune_backups
printf '\n部署成功，运行产物：%s；已检查源码：%s\n数据目录：%s\n备份目录：%s\n管理：systemctl status asset-ledger\n重复执行同一命令即可升级。\n' "${ARTIFACT_COMMIT:0:12}" "${COMMIT:0:12}" "$DATA_DIR" "$BACKUP"
if [[ $BIND == 127.0.0.1 ]]; then
  printf '当前仅监听服务器本机 127.0.0.1:%s，无需对公网开放此端口。\n' "$PORT"
  printf '在自己的电脑上执行（替换用户名和服务器 IP）：\n'
  printf 'ssh -N -L 127.0.0.1:%s:127.0.0.1:%s -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 USER@SERVER_IP\n' "$PORT" "$PORT"
  printf '保持 SSH 窗口运行，然后在本机浏览器打开 http://127.0.0.1:%s\n' "$PORT"
else
  printf '沿用原公网监听配置，访问：http://服务器IP:%s（HTTP）。\n' "$PORT"
  printf '切换为 SSH 隧道访问：重新执行安装命令并加 --local。\n'
fi
}

main "$@"
