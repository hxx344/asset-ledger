#!/usr/bin/env bash
# Run only on an isolated, disposable Linux runner: this installs a real service.
set -Eeuo pipefail
ROOT=/opt/asset-ledger
DATA=/var/lib/asset-ledger
PORT=3179
NODE="$ROOT/runtime/node-v24.15.0-linux-x64/bin/node"
cat install.sh | bash -s -- --port "$PORT"
systemctl is-active --quiet asset-ledger
assert_local_listener() {
  grep -qx 'BIND=127.0.0.1' "$ROOT/deploy.env"
  local listeners
  listeners=$(ss -H -ltn "sport = :$PORT" | awk '{print $4}')
  [[ $listeners == "127.0.0.1:$PORT" ]] || { echo "Unexpected listener: $listeners" >&2; return 1; }
}
assert_local_listener
CONFIG_BEFORE=$(sha256sum "$DATA/config.json" | cut -d' ' -f1)
VERSION_BEFORE=$(readlink -f "$ROOT/current")
PID_BEFORE=$(systemctl show --property=MainPID --value asset-ledger)
BACKUPS_BEFORE=$(find "$ROOT/backups" -mindepth 1 -maxdepth 1 -type d | wc -l)
bash install.sh --port "$PORT"
[[ $(readlink -f "$ROOT/current") == "$VERSION_BEFORE" ]]
[[ $(systemctl show --property=MainPID --value asset-ledger) == "$PID_BEFORE" ]]
[[ $(find "$ROOT/backups" -mindepth 1 -maxdepth 1 -type d | wc -l) == "$BACKUPS_BEFORE" ]]
# Insert a fixture through the production SQLite driver, leaving real credentials unused.
ASSET_DATA_DIR="$DATA" "$NODE" --input-type=module <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.ASSET_DATA_DIR + '/ledger.sqlite');
db.prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?)').run('integration-fixture','keep','789');
db.close();
NODE
# Simulate a saved legacy public binding; --local must override it while preserving the port.
sed -i 's/^BIND=.*/BIND=0.0.0.0/' "$ROOT/deploy.env"
bash install.sh --local
systemctl is-active --quiet asset-ledger
assert_local_listener
[[ $(sha256sum "$DATA/config.json" | cut -d' ' -f1) == "$CONFIG_BEFORE" ]]
grep -qx "PORT=$PORT" "$ROOT/deploy.env"
[[ $(readlink -f "$ROOT/current") == "$VERSION_BEFORE" ]]
VERSION_BEFORE=$(readlink -f "$ROOT/current")
ASSET_DATA_DIR="$DATA" "$NODE" --input-type=module <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
const db = new DatabaseSync(process.env.ASSET_DATA_DIR + '/ledger.sqlite');
assert.equal(db.prepare('SELECT value FROM settings WHERE owner=? AND key=?').get('integration-fixture','keep').value,'789');
db.close();
NODE
# Prepare old installer-owned releases, an unknown directory and an external symlink.
FIXTURE=$(mktemp -d /tmp/asset-install-test.XXXXXX)
trap 'rm -rf --one-file-system -- "$FIXTURE"' EXIT
mkdir -p "$ROOT/releases/aaaaaaaaaaaa.OLD001/.next/standalone" "$ROOT/releases/bbbbbbbbbbbb.FAIL01" "$ROOT/releases/custom" "$FIXTURE/external"
touch "$ROOT/releases/aaaaaaaaaaaa.OLD001/.install-owned" "$ROOT/releases/aaaaaaaaaaaa.OLD001/.install-ready" "$ROOT/releases/aaaaaaaaaaaa.OLD001/.next/BUILD_ID" "$ROOT/releases/aaaaaaaaaaaa.OLD001/.next/standalone/server.js"
touch "$ROOT/releases/bbbbbbbbbbbb.FAIL01/.install-owned" "$FIXTURE/external/keep"
ln -s "$FIXTURE/external" "$ROOT/releases/cccccccccccc.LINK01"
PID_BEFORE=$(systemctl show --property=MainPID --value asset-ledger)
bash install.sh --cleanup
[[ $(systemctl show --property=MainPID --value asset-ledger) == "$PID_BEFORE" ]]
[[ -d $ROOT/releases/aaaaaaaaaaaa.OLD001 && ! -d $ROOT/releases/bbbbbbbbbbbb.FAIL01 ]]
[[ -d $ROOT/releases/custom && -L $ROOT/releases/cccccccccccc.LINK01 && -f $FIXTURE/external/keep ]]
[[ $(sha256sum "$DATA/config.json" | cut -d' ' -f1) == "$CONFIG_BEFORE" ]]
# Mock only df; the actual installer must reject bytes/inodes before touching the service.
for resource in bytes inodes; do
  {
    printf 'df() { local free=999999999; if [[ "$1" == %q ]]; then free=0; fi; printf "Filesystem Blocks Used Available Ratio Mounted\\nfixture 999999999 0 %%s 0 /\\n" "$free"; }\n' "$([[ $resource == bytes ]] && printf %s -Pk || printf %s -Pi)"
    cat install.sh
  } > "$FIXTURE/full-$resource.sh"
  if bash "$FIXTURE/full-$resource.sh" >"$FIXTURE/$resource.log" 2>&1; then echo 'Expected capacity rejection' >&2; exit 1; fi
  grep -Eq '空间不足|inode 不足' "$FIXTURE/$resource.log"
  [[ $(systemctl show --property=MainPID --value asset-ledger) == "$PID_BEFORE" ]]
done
# A build error after a new allocation must reclaim only that allocation.
RELEASES_BEFORE=$(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d | sort)
sed 's/as_app npm run build)/false)/' install.sh > "$FIXTURE/build-fails.sh"
if bash "$FIXTURE/build-fails.sh"; then echo 'Expected build failure' >&2; exit 1; fi
[[ $(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d | sort) == "$RELEASES_BEFORE" ]]
[[ $(systemctl show --property=MainPID --value asset-ledger) == "$PID_BEFORE" ]]
# Two changed deployment fingerprints exercise promotion and bounded rollback retention.
for generation in one two; do
  sed "s/^main() {/main() {\n: integration-release-$generation/" install.sh > "$FIXTURE/upgrade-$generation.sh"
  bash "$FIXTURE/upgrade-$generation.sh"
  [[ $(find "$ROOT/releases" -mindepth 2 -maxdepth 2 -name .install-ready | wc -l) -eq 2 ]]
  [[ ! -d $ROOT/releases/aaaaaaaaaaaa.OLD001 ]]
done
VERSION_BEFORE=$(readlink -f "$ROOT/current")
# A conflicting listener makes the new service unhealthy; the old port must recover.
python3 -m http.server 3180 --bind 127.0.0.1 >/tmp/asset-ledger-port-fixture.log 2>&1 &
LISTENER=$!
trap 'kill "$LISTENER" 2>/dev/null || true; rm -rf --one-file-system -- "$FIXTURE"' EXIT
sleep 1
if bash "$FIXTURE/upgrade-two.sh" --port 3180; then echo 'Expected failed upgrade' >&2; exit 1; fi
[[ $(readlink -f "$ROOT/current") == "$VERSION_BEFORE" ]]
[[ $(sha256sum "$DATA/config.json" | cut -d' ' -f1) == "$CONFIG_BEFORE" ]]
grep -qx "PORT=$PORT" "$ROOT/deploy.env"
systemctl is-active --quiet asset-ledger
curl --fail --retry 10 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$PORT/api/health"
assert_local_listener
[[ $(find "$ROOT/backups" -name ledger.sqlite | wc -l) -ge 2 ]]
echo 'Installer passed: piped entrypoint, no-op reuse, bounded releases, capacity checks, failed-build cleanup, preserved config/data and rollback.'
