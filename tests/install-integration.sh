#!/usr/bin/env bash
# Run only on an isolated, disposable Linux runner: this installs a real service.
set -Eeuo pipefail
ROOT=/opt/asset-ledger
DATA=/var/lib/asset-ledger
PORT=3179
NODE="$ROOT/runtime/node-v24.15.0-linux-x64/bin/node"
bash install.sh --port "$PORT"
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
[[ $(readlink -f "$ROOT/current") != "$VERSION_BEFORE" ]]
VERSION_BEFORE=$(readlink -f "$ROOT/current")
ASSET_DATA_DIR="$DATA" "$NODE" --input-type=module <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
const db = new DatabaseSync(process.env.ASSET_DATA_DIR + '/ledger.sqlite');
assert.equal(db.prepare('SELECT value FROM settings WHERE owner=? AND key=?').get('integration-fixture','keep').value,'789');
db.close();
NODE
# A conflicting listener makes the new service unhealthy; the old port must recover.
python3 -m http.server 3180 --bind 127.0.0.1 >/tmp/asset-ledger-port-fixture.log 2>&1 &
LISTENER=$!
trap 'kill "$LISTENER" 2>/dev/null || true' EXIT
sleep 1
if bash install.sh --port 3180; then echo 'Expected failed upgrade' >&2; exit 1; fi
[[ $(readlink -f "$ROOT/current") == "$VERSION_BEFORE" ]]
[[ $(sha256sum "$DATA/config.json" | cut -d' ' -f1) == "$CONFIG_BEFORE" ]]
grep -qx "PORT=$PORT" "$ROOT/deploy.env"
systemctl is-active --quiet asset-ledger
curl --fail --retry 10 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$PORT/api/health"
assert_local_listener
[[ $(find "$ROOT/backups" -name ledger.sqlite | wc -l) -ge 2 ]]
echo 'Installer passed: loopback by default, legacy binding migration, preserved config/data, backup and rollback.'
