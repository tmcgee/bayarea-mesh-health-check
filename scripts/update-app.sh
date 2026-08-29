#!/usr/bin/env bash
#
# update-app.sh -- deploy a new version onto the droplet without losing state.
#
#   sudo ./update-app.sh                       # git pull mode
#   sudo ARCHIVE=/root/mhc-deploy.zip ./update-app.sh   # archive mode
#
# Snapshots data/ first, so a bad deploy is one command from recovery.
#
set -euo pipefail

APP_USER="${APP_USER:-mesh}"
APP_DIR="${APP_DIR:-/opt/mesh-health-check}"
APP_PORT="${APP_PORT:-3090}"
GIT_BRANCH="${GIT_BRANCH:-main}"
ARCHIVE="${ARCHIVE:-}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mesh-health-check}"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
[[ -d "$APP_DIR" ]] || die "$APP_DIR does not exist -- run provision-droplet.sh first"

stamp="$(date -u +%Y%m%d-%H%M%S)"
log "Snapshot data/ and .env -> $BACKUP_DIR/$stamp"
install -d -m 0700 "$BACKUP_DIR/$stamp"
cp -a "$APP_DIR/data" "$BACKUP_DIR/$stamp/data"
cp -a "$APP_DIR/.env" "$BACKUP_DIR/$stamp/.env" 2>/dev/null || warn "no .env to back up"
# Keep the last 10 snapshots; data/ is a few MB, but the droplet is 25 GiB.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d | sort | head -n -10 \
  | while read -r old; do rm -rf "$old"; done
ok "snapshot taken"

log "Stopping service"
systemctl stop mesh-health-check
ok "stopped"

if [[ -n "$ARCHIVE" ]]; then
  log "Unpacking $ARCHIVE"
  [[ -f "$ARCHIVE" ]] || die "$ARCHIVE not found"
  tmp="$(mktemp -d)"
  case "$ARCHIVE" in
    *.zip)          unzip -q -o "$ARCHIVE" -d "$tmp" ;;
    *.tar.gz|*.tgz) tar -xzf "$ARCHIVE" -C "$tmp" ;;
    *) die "unrecognised archive type: $ARCHIVE" ;;
  esac
  src="$tmp"
  if [[ ! -f "$tmp/package.json" ]]; then
    src="$(find "$tmp" -maxdepth 2 -name package.json -printf '%h\n' | head -1)"
    [[ -n "$src" ]] || die "no package.json inside $ARCHIVE"
  fi
  rsync -a --delete --exclude '.env' --exclude 'data/' --exclude 'node_modules/' \
    "$src"/ "$APP_DIR"/
  rm -rf "$tmp"
  ok "unpacked"
else
  log "git fetch origin/$GIT_BRANCH"
  sudo -u "$APP_USER" HOME="/home/$APP_USER" git -C "$APP_DIR" fetch --depth 1 origin "$GIT_BRANCH"
  before="$(git -C "$APP_DIR" rev-parse --short HEAD)"
  sudo -u "$APP_USER" HOME="/home/$APP_USER" git -C "$APP_DIR" reset --hard "origin/$GIT_BRANCH"
  after="$(git -C "$APP_DIR" rev-parse --short HEAD)"
  ok "$before -> $after"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env" 2>/dev/null || true

log "npm ci --omit=dev"
sudo -u "$APP_USER" HOME="/home/$APP_USER" \
  npm --prefix "$APP_DIR" ci --omit=dev --no-audit --fund=false
ok "dependencies installed"

log "Syntax check"
sudo -u "$APP_USER" npm --prefix "$APP_DIR" run --silent check
ok "check clean"

log "Starting service"
systemctl start mesh-health-check
code=""
for _ in $(seq 1 20); do
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' \
          "http://127.0.0.1:$APP_PORT/api/bootstrap" || true)"
  [[ "$code" == "200" ]] && break
  sleep 2
done
if [[ "$code" == "200" ]]; then
  ok "app healthy on :$APP_PORT"
else
  warn "app not answering 200 (last: ${code:-none})"
  warn "roll back with:"
  warn "  systemctl stop mesh-health-check"
  warn "  rm -rf $APP_DIR/data && cp -a $BACKUP_DIR/$stamp/data $APP_DIR/data"
  warn "  chown -R $APP_USER:$APP_USER $APP_DIR/data"
  warn "  git -C $APP_DIR reset --hard ${before:-<previous sha>} && systemctl start mesh-health-check"
  exit 1
fi

# server.js reads public/index.html once at boot, so a template change without a
# restart is invisible. The restart above already covers it -- this just says so.
log "Done. HTML/.env/server.js changes are live (the restart picked them up)."
