#!/usr/bin/env bash
# Isolated filesystem fixtures; no service, system directory or real database is touched.
set -Eeuo pipefail
SCRIPT_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# Load only definitions, without the final entrypoint.
source <(sed '$d' "$SCRIPT_ROOT/install.sh")
ORIGINAL_READ_PROTECTION=$(declare -f read_protection)
TEST_BASE=$(realpath -- "${TMPDIR:-/tmp}")
FIXTURE=$(mktemp -d "$TEST_BASE/asset-storage.XXXXXX")
cleanup_fixture() {
  [[ $FIXTURE == "$TEST_BASE/asset-storage."* && $(realpath -- "$FIXTURE") == "$FIXTURE" ]] || return 1
  rm -rf --one-file-system -- "$FIXTURE"
}
trap cleanup_fixture EXIT
APP_ROOT=$FIXTURE/app
DATA_DIR=$FIXTURE/data
mkdir -p "$APP_ROOT/releases" "$APP_ROOT/backups" "$DATA_DIR"
read_mounts() { :; }
read_protection() { :; }
assert_exists() { [[ -e $1 ]] || { printf 'Missing protected path: %s\n' "$1" >&2; exit 1; }; }
assert_absent() { [[ ! -e $1 ]] || { printf 'Unexpected retained path: %s\n' "$1" >&2; exit 1; }; }
make_release() {
  local path=$APP_ROOT/releases/$1
  mkdir -p "$path/.next/standalone"
  touch "$path/.install-owned" "$path/.next/BUILD_ID" "$path/.next/standalone/server.js"
  if [[ ${2:-ready} == ready ]]; then touch "$path/.install-ready"; fi
}
make_release aaaaaaaaaaaa.CUR001
make_release bbbbbbbbbbbb.RUN001
make_release cccccccccccc.OLD001
make_release dddddddddddd.FAIL01 failed
make_release eeeeeeeeeeee.SRC001
make_release ffffffffffff.DATA01
make_release 111111111111.MOUNT1
make_release 222222222222.NEW001 failed
mkdir -p "$APP_ROOT/releases/notes"
CURRENT=$APP_ROOT/releases/aaaaaaaaaaaa.CUR001
PREVIOUS=$APP_ROOT/releases/cccccccccccc.OLD001
RUNNING=$APP_ROOT/releases/bbbbbbbbbbbb.RUN001/.next/standalone
SOURCE_DIR=$APP_ROOT/releases/eeeeeeeeeeee.SRC001/scripts
DATA_DIR=$APP_ROOT/releases/ffffffffffff.DATA01/data
NEW_RELEASE=$APP_ROOT/releases/222222222222.NEW001
MOUNT_TARGETS=$APP_ROOT/releases/111111111111.MOUNT1/external
prune_releases
for name in aaaaaaaaaaaa.CUR001 bbbbbbbbbbbb.RUN001 cccccccccccc.OLD001 eeeeeeeeeeee.SRC001 ffffffffffff.DATA01 111111111111.MOUNT1 222222222222.NEW001 notes; do assert_exists "$APP_ROOT/releases/$name"; done
assert_absent "$APP_ROOT/releases/dddddddddddd.FAIL01"
# Protect releases below a data root as well as those containing it.
DATA_DIR=$APP_ROOT/releases
RUNNING='' SOURCE_DIR='' NEW_RELEASE='' MOUNT_TARGETS=''
prune_releases
assert_exists "$APP_ROOT/releases/eeeeeeeeeeee.SRC001"
DATA_DIR=$FIXTURE/data
make_release 333333333333.OLD002
prune_releases
assert_absent "$APP_ROOT/releases/333333333333.OLD002"

# Seven complete backups + a referenced old backup; incomplete attempts do not count.
for number in 01 02 03 04 05 06 07 08 09; do
  path=$APP_ROOT/backups/202601${number}T000000Z.ABCDEF
  mkdir -p "$path"
  touch "$path/.install-owned" "$path/.install-complete" "$path/ledger.sqlite"
done
printf '%s\n' 20260101T000000Z.ABCDEF > "$CURRENT/.install-rollback-backup"
mkdir -p "$APP_ROOT/backups/20260201T000000Z.FAILED" "$APP_ROOT/backups/custom"
touch "$APP_ROOT/backups/20260201T000000Z.FAILED/.install-owned"
prune_backups
assert_exists "$APP_ROOT/backups/20260101T000000Z.ABCDEF"
assert_absent "$APP_ROOT/backups/20260102T000000Z.ABCDEF"
assert_absent "$APP_ROOT/backups/20260201T000000Z.FAILED"
assert_exists "$APP_ROOT/backups/custom"
[[ $(find "$APP_ROOT/backups" -name .install-complete | wc -l) -eq 8 ]]

# A data directory located inside a backup must survive retention.
DATA_DIR=$APP_ROOT/backups/20260103T000000Z.ABCDEF/data
BACKUP_KEEP=1
prune_backups
assert_exists "$APP_ROOT/backups/20260103T000000Z.ABCDEF"
DATA_DIR=$FIXTURE/data
mkdir -p "$DATA_DIR/.npm/_cacache" "$DATA_DIR/backups" "$CURRENT/.next/cache/webpack" "$CURRENT/.next/cache/images"
touch "$DATA_DIR/ledger.sqlite" "$DATA_DIR/config.json" "$DATA_DIR/backups/keep.sqlite"
reclaim_caches
assert_absent "$DATA_DIR/.npm/_cacache"
assert_absent "$CURRENT/.next/cache/webpack"
assert_exists "$CURRENT/.next/cache/images"
assert_exists "$DATA_DIR/ledger.sqlite"
assert_exists "$DATA_DIR/config.json"
assert_exists "$DATA_DIR/backups/keep.sqlite"
if [[ $(uname -s) == Linux ]]; then
  mkdir -p "$FIXTURE/external"
  touch "$FIXTURE/external/keep"
  ln -s "$FIXTURE/external" "$APP_ROOT/releases/444444444444.LINK01"
  prune_releases
  [[ -L $APP_ROOT/releases/444444444444.LINK01 ]]
  assert_exists "$FIXTURE/external/keep"
fi
# Both exhaustion paths fail before proceeding; no actual filesystem is filled.
reclaim_caches() { :; }
storage_stats() { FREE_KB=0; FREE_INODES=999999; }
if (require_space "$APP_ROOT" 1024 10) 2>"$FIXTURE/error"; then exit 1; fi
grep -q '空间不足' "$FIXTURE/error"
storage_stats() { FREE_KB=999999; FREE_INODES=0; }
if (require_space "$APP_ROOT" 1024 10) 2>"$FIXTURE/error"; then exit 1; fi
grep -q 'inode 不足' "$FIXTURE/error"
# An invalid process query must never authorize deletion of a possibly running release.
if (eval "$ORIGINAL_READ_PROTECTION"; systemctl() { printf '?\n'; }; read_protection) 2>"$FIXTURE/error"; then exit 1; fi
grep -q '无法确认服务进程' "$FIXTURE/error"
printf 'Storage helpers passed: bounded releases/backups, protection, cache cleanup, space/inode failures.\n'
