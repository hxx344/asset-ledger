#!/usr/bin/env bash
# Run only on an isolated, disposable Linux runner: this installs a real service.
set -Eeuo pipefail
# Keep source fallback coverage when the public installer defaults to CI archives.
export PROJECT_DEPLOY_MODE=source
ROOT=/opt/asset-ledger
DATA=/var/lib/asset-ledger
PORT=3179
NODE="$ROOT/runtime/node-v24.15.0-linux-x64/bin/node"
# Use this checkout and a local upstream, so fixture commits cannot touch GitHub.
FIXTURE=$(mktemp -d /tmp/asset-install-test.XXXXXX)
trap 'rm -rf --one-file-system -- "$FIXTURE"' EXIT
git -c safe.directory="$PWD" clone -q . "$FIXTURE/source"
git -C "$FIXTURE/source" checkout -q -B main
git -C "$FIXTURE/source" config user.name Fixture
git -C "$FIXTURE/source" config user.email fixture@example.invalid
git clone --bare -q "$FIXTURE/source" "$FIXTURE/upstream.git"
sed "s|^REPO_URL=.*|REPO_URL=$FIXTURE/upstream.git|" install.sh > "$FIXTURE/install.sh"
INSTALLER=$FIXTURE/install.sh
publish_fixture() {
  git -C "$FIXTURE/source" add .
  git -C "$FIXTURE/source" commit -qm "$1"
  git -C "$FIXTURE/source" push -q "$FIXTURE/upstream.git" HEAD:main
}
cat "$INSTALLER" | bash -s -- --port "$PORT"
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
bash "$INSTALLER" --port "$PORT"
[[ $(readlink -f "$ROOT/current") == "$VERSION_BEFORE" ]]
[[ $(systemctl show --property=MainPID --value asset-ledger) == "$PID_BEFORE" ]]
[[ $(find "$ROOT/backups" -mindepth 1 -maxdepth 1 -type d | wc -l) == "$BACKUPS_BEFORE" ]]
# Docs and test changes keep the running artifact, PID, backup count and version.
ARTIFACT_BEFORE=$(cat "$VERSION_BEFORE/.install-artifact-commit")
printf '\nDeployment fixture documentation.\n' >> "$FIXTURE/source/README.md"
printf '// Non-runtime fixture.\n' > "$FIXTURE/source/tests/deployment-fixture.ts"
publish_fixture docs-and-tests
bash "$INSTALLER" --port "$PORT" > "$FIXTURE/docs.log"
grep -q '已跳过依赖安装、构建、备份和重启' "$FIXTURE/docs.log"
[[ $(readlink -f "$ROOT/current") == "$VERSION_BEFORE" ]]
[[ $(systemctl show --property=MainPID --value asset-ledger) == "$PID_BEFORE" ]]
[[ $(find "$ROOT/backups" -mindepth 1 -maxdepth 1 -type d | wc -l) == "$BACKUPS_BEFORE" ]]
curl --fail --silent "http://127.0.0.1:$PORT/api/health" | grep -Fq "\"release\":\"$ARTIFACT_BEFORE\""
# Insert a fixture through the production SQLite driver, leaving real credentials unused.
ASSET_DATA_DIR="$DATA" "$NODE" --input-type=module <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.ASSET_DATA_DIR + '/ledger.sqlite');
db.prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?)').run('integration-fixture','keep','789');
db.close();
NODE
# Simulate a saved legacy public binding; --local must override it while preserving the port.
sed -i 's/^BIND=.*/BIND=0.0.0.0/' "$ROOT/deploy.env"
bash "$INSTALLER" --local
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
mkdir -p "$ROOT/releases/aaaaaaaaaaaa.OLD001/.next/standalone" "$ROOT/releases/bbbbbbbbbbbb.FAIL01" "$ROOT/releases/custom" "$FIXTURE/external"
touch "$ROOT/releases/aaaaaaaaaaaa.OLD001/.install-owned" "$ROOT/releases/aaaaaaaaaaaa.OLD001/.install-ready" "$ROOT/releases/aaaaaaaaaaaa.OLD001/.next/BUILD_ID" "$ROOT/releases/aaaaaaaaaaaa.OLD001/.next/standalone/server.js"
touch "$ROOT/releases/bbbbbbbbbbbb.FAIL01/.install-owned" "$FIXTURE/external/keep"
ln -s "$FIXTURE/external" "$ROOT/releases/cccccccccccc.LINK01"
PID_BEFORE=$(systemctl show --property=MainPID --value asset-ledger)
bash "$INSTALLER" --cleanup
[[ $(systemctl show --property=MainPID --value asset-ledger) == "$PID_BEFORE" ]]
[[ -d $ROOT/releases/aaaaaaaaaaaa.OLD001 && ! -d $ROOT/releases/bbbbbbbbbbbb.FAIL01 ]]
[[ -d $ROOT/releases/custom && -L $ROOT/releases/cccccccccccc.LINK01 && -f $FIXTURE/external/keep ]]
[[ $(sha256sum "$DATA/config.json" | cut -d' ' -f1) == "$CONFIG_BEFORE" ]]
# Mock only df; the actual installer must reject bytes/inodes before touching the service.
for resource in bytes inodes; do
  {
    printf 'df() { local free=999999999; if [[ "$1" == %q ]]; then free=0; fi; printf "Filesystem Blocks Used Available Ratio Mounted\\nfixture 999999999 0 %%s 0 /\\n" "$free"; }\n' "$([[ $resource == bytes ]] && printf %s -Pk || printf %s -Pi)"
    cat "$INSTALLER"
  } > "$FIXTURE/full-$resource.sh"
  if bash "$FIXTURE/full-$resource.sh" >"$FIXTURE/$resource.log" 2>&1; then echo 'Expected capacity rejection' >&2; exit 1; fi
  grep -Eq '空间不足|inode 不足' "$FIXTURE/$resource.log"
  [[ $(systemctl show --property=MainPID --value asset-ledger) == "$PID_BEFORE" ]]
done
# A build error after a new allocation must reclaim only that allocation.
printf '\n// Actual Next backend source change.\n' >> "$FIXTURE/source/app/api/health/route.ts"
publish_fixture backend-change
RELEASES_BEFORE=$(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d | sort)
sed 's/as_app npm run build)/false)/' "$INSTALLER" > "$FIXTURE/build-fails.sh"
if bash "$FIXTURE/build-fails.sh"; then echo 'Expected build failure' >&2; exit 1; fi
[[ $(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d | sort) == "$RELEASES_BEFORE" ]]
[[ $(systemctl show --property=MainPID --value asset-ledger) == "$PID_BEFORE" ]]
# The backend change builds with the same Next cache and independent dependencies.
CACHE_BEFORE=$(cat "$VERSION_BEFORE/.install-build-cache")
CACHE_DIR=$ROOT/build-cache/$CACHE_BEFORE
install -d -m 0750 -o asset-ledger -g asset-ledger "$CACHE_DIR"
touch "$CACHE_DIR/.install-cache" "$CACHE_DIR/integration-preserved"
bash "$INSTALLER" > "$FIXTURE/backend.log"
VERSION_AFTER=$(readlink -f "$ROOT/current")
[[ $VERSION_AFTER != "$VERSION_BEFORE" ]]
[[ $(cat "$VERSION_AFTER/.install-artifact-commit") == "$(git -C "$FIXTURE/source" rev-parse HEAD)" ]]
[[ $(cat "$VERSION_AFTER/.install-build-cache") == "$CACHE_BEFORE" && -f $CACHE_DIR/integration-preserved ]]
[[ $(cat "$VERSION_AFTER/.install-dependency-sizes") == "$(cat "$VERSION_BEFORE/.install-dependency-sizes")" ]]
[[ $(stat -c %i "$VERSION_AFTER/node_modules/.package-lock.json") != "$(stat -c %i "$VERSION_BEFORE/node_modules/.package-lock.json")" ]]
runuser -u asset-ledger -- test ! -w "$VERSION_AFTER/.next/standalone/server.js"
grep -q '依赖未变，复用独立副本' "$FIXTURE/backend.log"
[[ $(find "$ROOT/releases" -mindepth 2 -maxdepth 2 -name .install-ready | wc -l) -eq 2 ]]
[[ ! -d $ROOT/releases/aaaaaaaaaaaa.OLD001 ]]
# An environment-only build input change invalidates the build/cache, not dependencies.
export ASSET_BUILD_TEST=environment-change
bash "$INSTALLER" > "$FIXTURE/environment.log"
[[ $(readlink -f "$ROOT/current") != "$VERSION_AFTER" ]]
[[ $(cat "$ROOT/current/.install-build-cache") != "$CACHE_BEFORE" ]]
grep -q '依赖未变，复用独立副本' "$FIXTURE/environment.log"
[[ $(find "$ROOT/releases" -mindepth 2 -maxdepth 2 -name .install-ready | wc -l) -eq 2 ]]
VERSION_BEFORE=$(readlink -f "$ROOT/current")
# A conflicting listener makes the new service unhealthy; the old port must recover.
python3 -m http.server 3180 --bind 127.0.0.1 >/tmp/asset-ledger-port-fixture.log 2>&1 &
LISTENER=$!
trap 'kill "$LISTENER" 2>/dev/null || true; rm -rf --one-file-system -- "$FIXTURE"' EXIT
sleep 1
if bash "$INSTALLER" --port 3180; then echo 'Expected failed upgrade' >&2; exit 1; fi
[[ $(readlink -f "$ROOT/current") == "$VERSION_BEFORE" ]]
[[ $(sha256sum "$DATA/config.json" | cut -d' ' -f1) == "$CONFIG_BEFORE" ]]
grep -qx "PORT=$PORT" "$ROOT/deploy.env"
systemctl is-active --quiet asset-ledger
curl --fail --retry 10 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$PORT/api/health"
assert_local_listener
[[ $(find "$ROOT/backups" -name ledger.sqlite | wc -l) -ge 2 ]]
echo 'Installer passed: docs/test no-op, real artifact identity, backend/environment rebuilds, Next cache reuse, independent dependencies, capacity checks, preserved data and rollback.'
