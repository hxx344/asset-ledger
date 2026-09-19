#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

APP_ROOT=/opt/asset-ledger
DATA_DIR=/var/lib/asset-ledger
APP_USER=asset-ledger
REPO_URL=https://github.com/hxx344/asset-ledger.git
NODE_VERSION=24.15.0
PORT_ARG=''
BIND_ARG=''
DATA_FILE=''

usage() {
  cat <<'HELP'
用法：sudo bash install.sh [--port 5678] [--local] [--data-file /path/资产统计.xlsx]
Ubuntu 22.04/24.04、Debian 12/13，amd64/arm64，需 systemd。
首次安装自动生成登录密码。重复执行升级，保留配置、资产、历史和 API 加密密钥。
默认监听 0.0.0.0:5678；--local 仅监听本机。升级不指定端口时沿用原配置。
HELP
}
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --port) (($# >= 2)) || die '--port 缺少参数'; PORT_ARG=$2; shift 2 ;;
    --local) BIND_ARG=127.0.0.1; shift ;;
    --data-file) (($# >= 2)) || die '--data-file 缺少参数'; DATA_FILE=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done
[[ $EUID -eq 0 ]] || die '请使用 sudo 或 root 执行。'
[[ -d /run/systemd/system ]] || die '此脚本需要 systemd。'
# shellcheck source=/dev/null
. /etc/os-release
case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;; *) die '支持 Ubuntu 22.04/24.04 和 Debian 12/13。' ;; esac
case "$(uname -m)" in x86_64) NODE_ARCH=x64 ;; aarch64|arm64) NODE_ARCH=arm64 ;; *) die '仅支持 amd64 / arm64。' ;; esac
if [[ -n $DATA_FILE ]]; then
  [[ -f $DATA_FILE ]] || die '导入文件不存在。'
  DATA_FILE=$(realpath -- "$DATA_FILE")
  [[ ! -f $DATA_DIR/ledger.sqlite ]] || die '已有数据库，拒绝用导入文件覆盖现有资产。'
fi
install -d -m 0755 "$APP_ROOT"
exec 9>"$APP_ROOT/install.lock"
flock -n 9 || die '另一个安装或升级正在运行。'
PORT=5678
BIND=0.0.0.0
if [[ -f $APP_ROOT/deploy.env ]]; then
  [[ $(stat -c %u "$APP_ROOT/deploy.env") == 0 ]] || die '部署配置必须归 root 所有。'
  # shellcheck source=/dev/null
  . "$APP_ROOT/deploy.env"
fi
PORT=${PORT_ARG:-$PORT}
BIND=${BIND_ARG:-$BIND}
[[ $PORT =~ ^[1-9][0-9]{3,4}$ ]] && ((PORT >= 1024 && PORT <= 65535)) || die '端口需为 1024–65535。'
[[ $BIND == 0.0.0.0 || $BIND == 127.0.0.1 ]] || die '监听地址无效。'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git xz-utils
id "$APP_USER" &>/dev/null || useradd --system --user-group --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
install -d -m 0755 "$APP_ROOT/releases" "$APP_ROOT/runtime"
install -d -m 0700 "$APP_ROOT/backups"

NODE_DIST="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_HOME="$APP_ROOT/runtime/$NODE_DIST"
if [[ ! -x $NODE_HOME/bin/node ]]; then
  DOWNLOAD=$(mktemp -d "$APP_ROOT/runtime/download.XXXXXX")
  curl --fail --silent --show-error --location --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIST.tar.xz" -o "$DOWNLOAD/$NODE_DIST.tar.xz"
  curl --fail --silent --show-error --location --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$DOWNLOAD/SHASUMS256.txt"
  (cd "$DOWNLOAD" && grep -E "^[a-f0-9]{64}  ${NODE_DIST}\.tar\.xz$" SHASUMS256.txt | sha256sum --check --status) || die 'Node.js 下载校验失败。'
  tar -xJf "$DOWNLOAD/$NODE_DIST.tar.xz" -C "$APP_ROOT/runtime"
  rm -f -- "$DOWNLOAD/$NODE_DIST.tar.xz" "$DOWNLOAD/SHASUMS256.txt"
  rmdir -- "$DOWNLOAD"
fi
export PATH="$NODE_HOME/bin:$PATH"
if [[ ! -d $APP_ROOT/source.git ]]; then
  git clone --bare "$REPO_URL" "$APP_ROOT/source.git"
fi
[[ $(git --git-dir="$APP_ROOT/source.git" remote get-url origin) == "$REPO_URL" ]] || die '源码仓库地址不匹配。'
git --git-dir="$APP_ROOT/source.git" fetch --prune origin main
COMMIT=$(git --git-dir="$APP_ROOT/source.git" rev-parse --verify 'FETCH_HEAD^{commit}')
RELEASE=$(mktemp -d "$APP_ROOT/releases/${COMMIT:0:12}.XXXXXX")
git --git-dir="$APP_ROOT/source.git" archive "$COMMIT" | tar -x -C "$RELEASE"
chown -R "$APP_USER:$APP_USER" "$RELEASE"
as_app() { runuser -u "$APP_USER" -- env PATH="$PATH" HOME="$DATA_DIR" NEXT_TELEMETRY_DISABLED=1 ASSET_DATA_DIR="$DATA_DIR" "$@"; }
printf '正在安装依赖并构建 %s…\n' "${COMMIT:0:12}"
(cd "$RELEASE" && as_app npm ci --include=dev && as_app npm run build)
RUNTIME_APP="$RELEASE/.next/standalone"
[[ -f $RUNTIME_APP/server.js ]] || die '构建未生成独立服务。'
cp -a "$RELEASE/.next/static" "$RUNTIME_APP/.next/static"
cp -a "$RELEASE/public" "$RUNTIME_APP/public"
install -d "$RUNTIME_APP/drizzle"
cp -a "$RELEASE/drizzle/." "$RUNTIME_APP/drizzle/"
# The service account can write data, but cannot alter code used by privileged upgrade steps.
chown -R "root:$APP_USER" "$RELEASE"
chmod -R u=rwX,g=rX,o= "$RELEASE"
if [[ -n $DATA_FILE ]]; then
  case "$DATA_FILE" in
    *.xlsx) apt-get install -y -qq python3-openpyxl
      python3 "$RELEASE/scripts/import-workbook.py" "$DATA_FILE" "$(TZ=Asia/Shanghai date +%F)" "$DATA_DIR/imported-ledger.json" ;;
    *.json) install -m 0600 "$DATA_FILE" "$DATA_DIR/imported-ledger.json" ;;
    *) die '导入文件必须为 .xlsx 或 .json。' ;;
  esac
  chown "$APP_USER:$APP_USER" "$DATA_DIR/imported-ledger.json"
fi
as_app node "$RELEASE/scripts/configure.mjs"

PREVIOUS=$(readlink -f "$APP_ROOT/current" || true)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$APP_ROOT/backups/$STAMP"
install -d -m 0700 "$BACKUP"
cp -p "$DATA_DIR/config.json" "$BACKUP/config.json"
if [[ -f $APP_ROOT/deploy.env ]]; then cp -p "$APP_ROOT/deploy.env" "$BACKUP/deploy.env"; fi
if [[ -f /etc/systemd/system/asset-ledger.service ]]; then cp -p /etc/systemd/system/asset-ledger.service "$BACKUP/asset-ledger.service"; fi
WAS_ACTIVE=0
systemctl is-active --quiet asset-ledger && WAS_ACTIVE=1
SWITCHED=0
rollback() {
  local code=$?
  trap - ERR
  if ((SWITCHED)); then
    systemctl stop asset-ledger || true
    if [[ -f $BACKUP/ledger.sqlite ]]; then
      rm -f -- "$DATA_DIR/ledger.sqlite-wal" "$DATA_DIR/ledger.sqlite-shm"
      install -m 0600 -o "$APP_USER" -g "$APP_USER" "$BACKUP/ledger.sqlite" "$DATA_DIR/ledger.sqlite"
    fi
    if [[ -n $PREVIOUS && -d $PREVIOUS ]]; then
      ln -sfn "$PREVIOUS" "$APP_ROOT/current"
      if [[ -f $BACKUP/deploy.env ]]; then cp -p "$BACKUP/deploy.env" "$APP_ROOT/deploy.env"; fi
      if [[ -f $BACKUP/asset-ledger.service ]]; then cp -p "$BACKUP/asset-ledger.service" /etc/systemd/system/asset-ledger.service; fi
      systemctl daemon-reload
      if ((WAS_ACTIVE)); then systemctl start asset-ledger || true; fi
      printf '升级未通过健康检查，已恢复上一版本和数据库。\n' >&2
    else
      printf '首次启动未通过检查，请查看 journalctl -u asset-ledger。\n' >&2
    fi
  fi
  exit "$code"
}
trap rollback ERR
if ((WAS_ACTIVE)); then systemctl stop asset-ledger; fi
SWITCHED=1
as_app node "$RELEASE/scripts/backup.mjs" "$DATA_DIR/.upgrade-$STAMP.sqlite"
if [[ -f $DATA_DIR/.upgrade-$STAMP.sqlite ]]; then
  mv -- "$DATA_DIR/.upgrade-$STAMP.sqlite" "$BACKUP/ledger.sqlite"
  chown root:root "$BACKUP/ledger.sqlite"
  chmod 0600 "$BACKUP/ledger.sqlite"
fi
printf 'PORT=%s\nBIND=%s\n' "$PORT" "$BIND" > "$APP_ROOT/deploy.env"
chmod 0600 "$APP_ROOT/deploy.env"
ln -sfn "$RELEASE" "$APP_ROOT/current"
cat > /etc/systemd/system/asset-ledger.service <<UNIT
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
Environment=ASSET_RELEASE=$COMMIT
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
systemctl daemon-reload
systemctl enable asset-ledger
systemctl restart asset-ledger
HEALTHY=0
for ((attempt=0; attempt<30; attempt++)); do
  if systemctl is-active --quiet asset-ledger && curl --fail --silent --max-time 2 "http://127.0.0.1:$PORT/api/health" | grep -Fq "\"release\":\"$COMMIT\""; then HEALTHY=1; break; fi
  sleep 2
done
((HEALTHY)) || false
trap - ERR
printf '\n部署成功，提交：%s\n访问：http://服务器IP:%s\n数据目录：%s\n备份目录：%s\n管理：systemctl status asset-ledger\n重复执行同一命令即可升级。\n' "${COMMIT:0:12}" "$PORT" "$DATA_DIR" "$BACKUP"
if [[ $BIND == 127.0.0.1 ]]; then printf '当前仅监听本机 127.0.0.1。\n'; fi
printf '使用 IP 直连时为 HTTP；服务器安全组需允许所选端口。\n'
