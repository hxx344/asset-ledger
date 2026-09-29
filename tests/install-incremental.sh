#!/usr/bin/env bash
# Git/content/cache fixtures only. Works in native Git Bash and Linux; no services.
set -Eeuo pipefail
SCRIPT_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source <(sed '$d' "$SCRIPT_ROOT/install.sh")
TEST_BASE=$(realpath -- "${TMPDIR:-/tmp}")
FIXTURE=$(mktemp -d "$TEST_BASE/asset-incremental.XXXXXX")
cleanup_fixture() {
  [[ $FIXTURE == "$TEST_BASE/asset-incremental."* && $(realpath -- "$FIXTURE") == "$FIXTURE" ]] || return 1
  rm -rf --one-file-system -- "$FIXTURE"
}
trap cleanup_fixture EXIT
APP_ROOT=$FIXTURE/app
mkdir -p "$APP_ROOT" "$FIXTURE/source/app/api/health" "$FIXTURE/source/lib" "$FIXTURE/source/tests" "$FIXTURE/source/docs" "$FIXTURE/source/.github"
git -C "$FIXTURE/source" init -q
git -C "$FIXTURE/source" config core.autocrlf false
git -C "$FIXTURE/source" config user.name Fixture
git -C "$FIXTURE/source" config user.email fixture@example.invalid
printf '{}\n' > "$FIXTURE/source/package.json"
printf '{}\n' > "$FIXTURE/source/package-lock.json"
printf 'export default {};\n' > "$FIXTURE/source/next.config.ts"
printf 'export const GET = () => "ok";\n' > "$FIXTURE/source/app/api/health/route.ts"
printf 'export const value = 1;\n' > "$FIXTURE/source/lib/store.ts"
printf 'initial\n' > "$FIXTURE/source/README.md"
git -C "$FIXTURE/source" add .
git -C "$FIXTURE/source" commit -qm initial
git clone --bare -q "$FIXTURE/source" "$APP_ROOT/source.git"
NODE_DIST=fixture-node
as_app() { "$@"; }
next_revision() {
  git -C "$FIXTURE/source" add .
  git -C "$FIXTURE/source" commit -qm "$1"
  git --git-dir="$APP_ROOT/source.git" fetch -q origin
  COMMIT=$(git -C "$FIXTURE/source" rev-parse HEAD)
}
COMMIT=$(git -C "$FIXTURE/source" rev-parse HEAD)
environment=$(build_environment_key)
session_one=$(export SSH_CLIENT='192.0.2.1 12345 22' SSH_CONNECTION='192.0.2.1 12345 192.0.2.2 22' SSH_TTY=/dev/pts/1 XDG_SESSION_ID=12 LS_COLORS='di=01;34'; build_environment_key)
session_two=$(export SSH_CLIENT='192.0.2.3 23456 22' SSH_CONNECTION='192.0.2.3 23456 192.0.2.2 22' SSH_TTY=/dev/pts/2 XDG_SESSION_ID=24 LS_COLORS='di=01;35'; build_environment_key)
[[ $session_one == "$environment" && $session_two == "$environment" ]]
public_environment=$(export NEXT_PUBLIC_DEPLOYMENT_FIXTURE=changed; build_environment_key)
node_environment=$(export NODE_OPTIONS=--max-old-space-size=2048; build_environment_key)
[[ $public_environment != "$environment" && $node_environment != "$environment" ]]
calculate_keys "$environment"
application=$source_key dependencies=$dependency_key cache=$cache_key
printf 'changed docs\n' >> "$FIXTURE/source/README.md"
printf 'test fixture\n' > "$FIXTURE/source/tests/fixture.ts"
printf 'manual\n' > "$FIXTURE/source/docs/manual.md"
printf 'ci\n' > "$FIXTURE/source/.github/verify.yml"
printf '# installer change\n' > "$FIXTURE/source/install.sh"
next_revision docs-tests-installer
calculate_keys "$environment"
[[ $source_key == "$application" && $dependency_key == "$dependencies" && $cache_key == "$cache" ]]
printf '// backend change\n' >> "$FIXTURE/source/app/api/health/route.ts"
next_revision backend
calculate_keys "$environment"
[[ $source_key != "$application" && $dependency_key == "$dependencies" && $cache_key == "$cache" ]]
application=$source_key
printf '// shared logic change\n' >> "$FIXTURE/source/lib/store.ts"
next_revision shared-library
calculate_keys "$environment"
[[ $source_key != "$application" && $cache_key == "$cache" ]]
application=$source_key
export ASSET_INCREMENTAL_BUILD_INPUT=changed
changed_environment=$(build_environment_key)
[[ $changed_environment != "$environment" ]]
calculate_keys "$changed_environment"
[[ $source_key != "$application" && $dependency_key == "$dependencies" && $cache_key != "$cache" ]]
unset ASSET_INCREMENTAL_BUILD_INPUT
calculate_keys "$environment"
printf '// build config\n' >> "$FIXTURE/source/next.config.ts"
next_revision build-configuration
calculate_keys "$environment"
[[ $cache_key != "$cache" && $dependency_key == "$dependencies" ]]
printf '{"lockfileVersion":3}\n' > "$FIXTURE/source/package-lock.json"
next_revision dependency
calculate_keys "$environment"
[[ $dependency_key != "$dependencies" ]]

# Statistics are accepted only for matching dependencies; malformed stamps miss.
mkdir -p "$FIXTURE/release"
atomic_stamp "$FIXTURE/release/.install-dependency-sizes" "$dependencies 1200 45"
dependency_sizes "$FIXTURE/release" "$dependencies"
[[ $DEPENDENCY_KB == 1200 && $DEPENDENCY_INODES == 45 ]]
if dependency_sizes "$FIXTURE/release" wrong; then exit 1; fi
atomic_stamp "$FIXTURE/release/.install-dependency-sizes" "$dependencies 1200 45 injected"
if dependency_sizes "$FIXTURE/release" "$dependencies"; then exit 1; fi
[[ $(find "$FIXTURE/release" -type f | wc -l) -eq 1 ]]

# Changing the deployment port changes the unit, not the build input/version.
ARTIFACT_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
NODE_HOME=/fixture/node DATA_DIR=/fixture/data PORT=5678 BIND=127.0.0.1
before=$(service_unit)
PORT=5679
after=$(service_unit)
[[ $before != "$after" ]]
grep -q "ASSET_RELEASE=$ARTIFACT_COMMIT" <<< "$after"
printf 'Incremental helpers passed: docs/test/installer reuse, backend rebuild, cache partition, environment, stamps and deployment-only settings.\n'
