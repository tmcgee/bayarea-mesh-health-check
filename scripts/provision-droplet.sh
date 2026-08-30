#!/usr/bin/env bash
#
# provision-droplet.sh -- turn a fresh DigitalOcean droplet into a durable home
# for the Bay Area MeshCore Health Check.
#
# Target:  Ubuntu 24.04 LTS, Basic (shared CPU) droplet, 1 GiB / 1 vCPU / 25 GiB
#          in SFO3.  $6/mo.  The 512 MiB / $4 plan is NOT enough: `npm ci` gets
#          OOM-killed during dependency extraction even with dev deps omitted.
#
# Run as root on the droplet:
#     curl -fsSLo provision-droplet.sh <raw url>   # or scp it up
#     chmod +x provision-droplet.sh
#     DOMAIN=healthcheck.sonomamesh.com \
#     SOURCE_MODE=archive ARCHIVE=/root/mhc-deploy.zip \
#     TLS_MODE=origin-ca ADMIN_SSH_CIDR=203.0.113.4/32 \
#       ./provision-droplet.sh
#
# The script is idempotent: run it again after a config change, a Node bump, or
# a repo update and it converges rather than duplicating work.  It never
# overwrites .env and never touches data/.
#
# One caveat on "idempotent": section 10 runs `ufw --force reset`, which is how
# the firewall converges instead of accumulating duplicate rules -- but it also
# discards any rule you added to ufw by hand.  Add extra rules here, not there.
#
# ADMIN_SSH_CIDR is the one setting that can lock you out of the droplet, so the
# preflight refuses to continue unless this SSH session's own client address is
# inside it.  Override with ALLOW_SSH_LOCKOUT=1 only if you are willing to fall
# back to the DigitalOcean web console.
#
# What it replaces, permanently:
#   /tmp/app-supervise.sh      -> systemd Restart=always
#   /tmp/named-tunnel.sh       -> a real public IPv4
#   /tmp/named-tunnel-b.sh     -> (no second tunnel replica needed)
#   /tmp/tunnel-watchdog.sh    -> nothing to watch; no tunnel to wedge
#   cloudflared + its protocol/edge-ip-version quoting traps -> Caddy
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration.  Override any of these in the environment.
# ---------------------------------------------------------------------------
DOMAIN="${DOMAIN:-healthcheck.sonomamesh.com}"
APP_USER="${APP_USER:-mesh}"
APP_DIR="${APP_DIR:-/opt/mesh-health-check}"
APP_PORT="${APP_PORT:-3090}"
# Node 20 reached end-of-life on 2026-04-30 and receives no further security
# patches.  24.x is Active LTS through 2028-04-30.  Verified: `npm ci --omit=dev`
# is clean, `npm run check` passes, and the app boots and reaches the broker on
# 24.20.0.  Every dependency is pure JS -- there is nothing to rebuild.
NODE_MAJOR="${NODE_MAJOR:-24}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

# A fresh droplet is UTC.  OBSERVER_RESEED_HOUR and the unattended-upgrade
# reboot window are both interpreted in LOCAL time, so leaving the box on UTC
# silently moves the "04:00" reseed pass to 21:00 Pacific the previous day.
TIMEZONE="${TIMEZONE:-America/Los_Angeles}"

# Where the source comes from.
#   archive -> unpack a zip/tarball already on the box (no credentials needed)
#   git     -> clone GIT_REPO, optionally with a GitLab deploy token
SOURCE_MODE="${SOURCE_MODE:-archive}"
ARCHIVE="${ARCHIVE:-/root/mhc-deploy.zip}"
GIT_REPO="${GIT_REPO:-https://gitlab.com/tmcgee/bayarea-mesh-health-check.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"
GIT_TOKEN_USER="${GIT_TOKEN_USER:-}"   # deploy-token username
GIT_TOKEN="${GIT_TOKEN:-}"             # deploy-token secret (read_repository)

# How TLS is terminated.
#   origin-ca  -> Caddy serves a Cloudflare Origin CA cert; keep the orange
#                 cloud on and set Cloudflare SSL mode to Full (strict).
#                 Requires ORIGIN_CERT and ORIGIN_KEY to exist on the box.
#   letsencrypt-> Caddy gets its own cert via ACME.  DNS must be grey-cloud
#                 (DNS only) or ACME HTTP-01 will be answered by Cloudflare.
#   none       -> plain HTTP on APP_PORT, firewalled.  Testing only.
TLS_MODE="${TLS_MODE:-origin-ca}"
ORIGIN_CERT="${ORIGIN_CERT:-/etc/caddy/origin.pem}"
ORIGIN_KEY="${ORIGIN_KEY:-/etc/caddy/origin.key}"
ACME_EMAIL="${ACME_EMAIL:-cloudflare@mmconsult.com}"

# Restrict inbound 80/443 to Cloudflare's published ranges.  Only correct when
# the record is proxied (orange cloud); set to false for grey-cloud DNS.
CF_PROXY_ONLY="${CF_PROXY_ONLY:-auto}"   # auto | true | false
# Restrict inbound 22 to one CIDR.  Empty = any address.  If you connect over
# IPv6 this must be an IPv6 CIDR; the preflight check will tell you which
# address you actually arrived from rather than letting you find out afterwards.
ADMIN_SSH_CIDR="${ADMIN_SSH_CIDR:-}"     # e.g. 203.0.113.4/32; empty = any

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
log "Preflight"
[[ $EUID -eq 0 ]] || die "run as root (sudo -i)"
[[ -r /etc/os-release ]] || die "cannot read /etc/os-release"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || warn "tested on Ubuntu 24.04; found ${PRETTY_NAME:-unknown}"

if [[ "$CF_PROXY_ONLY" == "auto" ]]; then
  if [[ "$TLS_MODE" == "origin-ca" ]]; then CF_PROXY_ONLY=true; else CF_PROXY_ONLY=false; fi
fi

case "$SOURCE_MODE" in
  archive) [[ -f "$ARCHIVE" ]] || die "SOURCE_MODE=archive but $ARCHIVE not found" ;;
  git)     : ;;
  *)       die "SOURCE_MODE must be 'archive' or 'git'" ;;
esac

if [[ "$TLS_MODE" == "origin-ca" ]]; then
  if [[ ! -s "$ORIGIN_CERT" || ! -s "$ORIGIN_KEY" ]]; then
    warn "TLS_MODE=origin-ca but $ORIGIN_CERT / $ORIGIN_KEY are missing."
    warn "Create them in Cloudflare (SSL/TLS -> Origin Server -> Create"
    warn "Certificate, 15 years, hostnames: $DOMAIN) and paste them in, then"
    warn "re-run this script. Continuing; Caddy will not start until they exist."
  fi
fi
# Lockout guard.  Section 10 ends with `ufw --force enable`, and when
# ADMIN_SSH_CIDR is set the ONLY way back in is port 22 from that CIDR.  A typo
# there, or an SSH session that arrived over IPv6 while the CIDR is IPv4-only,
# bricks access to the droplet the moment the firewall comes up.  Refuse to
# proceed unless this session's own client address is inside the CIDR.  The DO
# web console still works, so this is recoverable -- but only if you know.
if [[ -n "$ADMIN_SSH_CIDR" && "${ALLOW_SSH_LOCKOUT:-0}" != "1" ]]; then
  ssh_client="${SSH_CONNECTION%% *}"
  if [[ -z "$ssh_client" ]]; then
    warn "ADMIN_SSH_CIDR is set but this is not an SSH session; cannot verify"
    warn "you will still be able to log in. Set ALLOW_SSH_LOCKOUT=1 to silence."
  elif python3 - "$ssh_client" "$ADMIN_SSH_CIDR" <<'PY'
import ipaddress, sys
try:
    addr = ipaddress.ip_address(sys.argv[1])
    net = ipaddress.ip_network(sys.argv[2], strict=False)
except ValueError:
    sys.exit(2)
sys.exit(0 if addr in net else 1)
PY
  then
    ok "ssh client $ssh_client is inside ADMIN_SSH_CIDR"
  else
    rc=$?
    [[ $rc -eq 2 ]] && die "ADMIN_SSH_CIDR=$ADMIN_SSH_CIDR is not a valid CIDR"
    die "you are connected from $ssh_client, which is OUTSIDE
     ADMIN_SSH_CIDR=$ADMIN_SSH_CIDR. Enabling the firewall would lock you out.
     Fix the CIDR (note $ssh_client -- an IPv6 session needs an IPv6 CIDR), or
     re-run with ALLOW_SSH_LOCKOUT=1 if you have DO console access and mean it."
  fi
fi

ok "domain=$DOMAIN tls=$TLS_MODE source=$SOURCE_MODE cf_proxy_only=$CF_PROXY_ONLY"

# Timezone before anything schedules itself against the wall clock.
if [[ "$(timedatectl show -p Timezone --value 2>/dev/null || echo)" == "$TIMEZONE" ]]; then
  ok "timezone already $TIMEZONE"
else
  timedatectl set-timezone "$TIMEZONE"
  ok "timezone set to $TIMEZONE (was UTC on a fresh droplet)"
fi

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# 1. Swap.  Do this FIRST -- npm and apt both need it on a 1 GiB box.
# ---------------------------------------------------------------------------
log "Swap"
# Compare against the requested size, not merely "is any swap on".  A droplet
# rebuilt from an image with a token 256 MiB swap would otherwise satisfy the
# check and leave npm to be OOM-killed.
want_bytes="$(numfmt --from=iec "$SWAP_SIZE")"
have_bytes="$(awk 'NR>1 {s+=$3} END {printf "%d", s*1024}' /proc/swaps)"
if [[ "$have_bytes" -ge $(( want_bytes * 9 / 10 )) ]]; then
  ok "swap already active: $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
else
  # Keep the dd fallback the same size as the fallocate attempt.
  swap_mib="$(numfmt --from=iec "$SWAP_SIZE" | awk '{printf "%d", $1/1048576}')"
  fallocate -l "$SWAP_SIZE" /swapfile \
    || dd if=/dev/zero of=/swapfile bs=1M count="$swap_mib" status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  ok "created $SWAP_SIZE /swapfile"
fi
# Prefer RAM but allow the kernel to page out the idle Node heap rather than
# OOM-killing during npm installs.
sysctl -qw vm.swappiness=10
printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-mesh-swappiness.conf

# ---------------------------------------------------------------------------
# 2. Base packages
# ---------------------------------------------------------------------------
log "Base packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg git unzip rsync python3 ufw fail2ban \
  unattended-upgrades chrony jq
ok "installed"

# ---------------------------------------------------------------------------
# 3. Node.js from NodeSource
# ---------------------------------------------------------------------------
log "Node.js ${NODE_MAJOR}.x"
have_node=false
if command -v node >/dev/null 2>&1; then
  cur="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  # Accept anything at or above the target so a re-run does not DOWNGRADE a box
  # that has already been moved to a newer LTS by hand.
  [[ "$cur" =~ ^[0-9]+$ && "$cur" -ge "$NODE_MAJOR" ]] && have_node=true
fi
if [[ "$have_node" == true ]]; then
  ok "node $(node -v) already installed"
else
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
  ok "node $(node -v), npm $(npm -v)"
fi
# The unit hardcodes /usr/bin/node; make sure that is what we just installed.
[[ -x /usr/bin/node ]] || die "/usr/bin/node missing after install (unit expects it)"

# ---------------------------------------------------------------------------
# 4. Service account
# ---------------------------------------------------------------------------
log "Service account: $APP_USER"
if id -u "$APP_USER" >/dev/null 2>&1; then
  ok "exists"
else
  # A real home under /home so git credentials can live outside APP_DIR --
  # ProtectSystem=strict makes APP_DIR read-only to the service anyway.
  adduser --system --group --shell /usr/sbin/nologin \
          --home "/home/$APP_USER" "$APP_USER" >/dev/null
  install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER"
  ok "created"
fi

# ---------------------------------------------------------------------------
# 5. Source
# ---------------------------------------------------------------------------
log "Application source -> $APP_DIR"
install -d -m 0755 "$APP_DIR"

if [[ "$SOURCE_MODE" == "archive" ]]; then
  tmp="$(mktemp -d)"
  case "$ARCHIVE" in
    *.zip)              unzip -q -o "$ARCHIVE" -d "$tmp" ;;
    *.tar.gz|*.tgz)     tar -xzf "$ARCHIVE" -C "$tmp" ;;
    *) die "unrecognised archive type: $ARCHIVE" ;;
  esac
  # The zip may or may not have a single top-level directory.
  src="$tmp"
  if [[ ! -f "$tmp/package.json" ]]; then
    # No `| head -1`: head exits early, find takes SIGPIPE, and `pipefail` turns
    # that into a failed assignment under `set -e`.
    inner="$(find "$tmp" -maxdepth 2 -name package.json -printf '%h\n' -quit)"
    [[ -n "$inner" ]] || die "no package.json inside $ARCHIVE"
    src="$inner"
  fi
  # Preserve .env and data/ across re-runs.
  # --delete removes files dropped upstream, but .env and data/ are excluded so
  # a re-run never destroys config or observer state.
  rsync -a --delete \
        --exclude '.env' --exclude 'data/' --exclude 'node_modules/' \
        "$src"/ "$APP_DIR"/
  rm -rf "$tmp"
  ok "unpacked $(basename "$ARCHIVE")"
else
  remote="$GIT_REPO"
  if [[ -n "$GIT_TOKEN" && -n "$GIT_TOKEN_USER" ]]; then
    # Store the token in the service account's credential file rather than the
    # remote URL, so it never lands in .git/config or `git remote -v` output.
    host="$(printf '%s' "$GIT_REPO" | sed -E 's#^https://([^/]+)/.*#\1#')"
    printf 'https://%s:%s@%s\n' "$GIT_TOKEN_USER" "$GIT_TOKEN" "$host" \
      >"/home/$APP_USER/.git-credentials"
    chmod 600 "/home/$APP_USER/.git-credentials"
    chown "$APP_USER:$APP_USER" "/home/$APP_USER/.git-credentials"
    sudo -u "$APP_USER" HOME="/home/$APP_USER" git config --global credential.helper store
  fi
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  if [[ -d "$APP_DIR/.git" ]]; then
    sudo -u "$APP_USER" HOME="/home/$APP_USER" git -C "$APP_DIR" fetch --depth 1 origin "$GIT_BRANCH"
    sudo -u "$APP_USER" HOME="/home/$APP_USER" git -C "$APP_DIR" reset --hard "origin/$GIT_BRANCH"
    ok "updated to origin/$GIT_BRANCH"
  else
    sudo -u "$APP_USER" HOME="/home/$APP_USER" \
      git clone --depth 1 --branch "$GIT_BRANCH" "$remote" "$APP_DIR"
    ok "cloned $GIT_BRANCH"
  fi
fi

install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------------------------------------------------------------------------
# 6. Dependencies
# ---------------------------------------------------------------------------
log "npm ci --omit=dev"
# --omit=dev skips @playwright/test, which is ~400 MB of browsers and the single
# reason a 512 MiB droplet cannot build this app.  Run the smoke tests elsewhere.
# postinstall (scripts/patch-meshcore-decoder.js) still runs -- it must.
sudo -u "$APP_USER" HOME="/home/$APP_USER" \
  npm --prefix "$APP_DIR" ci --omit=dev --no-audit --fund=false
ok "production dependencies installed ($(du -sh "$APP_DIR/node_modules" | cut -f1) in node_modules)"

# ---------------------------------------------------------------------------
# 7. Configuration
# ---------------------------------------------------------------------------
log "Configuration"
if [[ -f "$APP_DIR/.env" ]]; then
  ok ".env present, left untouched"
else
  [[ -f "$APP_DIR/.env.bayarea.example" ]] \
    || die "no .env and no .env.bayarea.example in $APP_DIR -- wrong archive?"
  cp "$APP_DIR/.env.bayarea.example" "$APP_DIR/.env"
  # We already know the hostname and the port; do not make the operator retype
  # them.  First-match-only seds so a later commented example line cannot be
  # rewritten by accident.
  sed -i -e "0,/^SITE_URL=/s#^SITE_URL=.*#SITE_URL=https://$DOMAIN#" \
         -e "0,/^PORT=/s#^PORT=.*#PORT=$APP_PORT#" "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  warn "created .env from .env.bayarea.example -- it will NOT work as-is."
  warn "Fill in, at minimum:"
  warn "  MQTT_PASSWORD        (GoMesh subscriber credential)"
  warn "  CARTO_BASEMAP_KEY    (else the map falls back to plain OSM tiles)"
  warn "  TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY"
  warn "  ADMIN_TOKEN          (openssl rand -hex 24)"
  ok   "SITE_URL=https://$DOMAIN and PORT=$APP_PORT filled in for you"
  warn "Keep every comment on its own line: the parser takes everything after"
  warn "the first '=' as the value, inline '#' included."
fi
# TRUST_PROXY must be on, or every session lands under Caddy's 127.0.0.1 and
# the per-IP rate limiter throttles the whole internet as one client.
if grep -qE '^TRUST_PROXY=1[[:space:]]*$' "$APP_DIR/.env"; then
  ok "TRUST_PROXY=1"
else
  warn "TRUST_PROXY is not 1 -- behind Caddy, set it or rate limiting sees one client"
fi
chmod 600 "$APP_DIR/.env"

# ---------------------------------------------------------------------------
# 8. systemd unit
# ---------------------------------------------------------------------------
log "systemd unit"
unit_src="$SCRIPT_DIR/mesh-health-check.service"
[[ -f "$unit_src" ]] || unit_src="$APP_DIR/scripts/mesh-health-check.service"
[[ -f "$unit_src" ]] || die "mesh-health-check.service not found next to this script"
# Honour non-default APP_DIR / APP_USER without editing the unit by hand.
sed -e "s#/opt/mesh-health-check#$APP_DIR#g" \
    -e "s#^User=mesh\$#User=$APP_USER#" \
    -e "s#^Group=mesh\$#Group=$APP_USER#" \
    "$unit_src" >/etc/systemd/system/mesh-health-check.service
chmod 0644 /etc/systemd/system/mesh-health-check.service
systemctl daemon-reload
systemctl enable --quiet mesh-health-check.service
systemctl restart mesh-health-check.service
ok "enabled and started"

# ---------------------------------------------------------------------------
# 9. Reverse proxy / TLS
# ---------------------------------------------------------------------------
if [[ "$TLS_MODE" != "none" ]]; then
  log "Caddy ($TLS_MODE)"
  if ! command -v caddy >/dev/null 2>&1; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -qq
    apt-get install -y -qq caddy
  fi
  if [[ "$TLS_MODE" == "origin-ca" ]]; then
    chown root:caddy "$ORIGIN_CERT" "$ORIGIN_KEY" 2>/dev/null || true
    chmod 640 "$ORIGIN_CERT" "$ORIGIN_KEY" 2>/dev/null || true
    tls_line="tls $ORIGIN_CERT $ORIGIN_KEY"
    email_line=""
  else
    tls_line=""
    email_line="email $ACME_EMAIL"
  fi
  cat >/etc/caddy/Caddyfile <<CADDY
# Managed by provision-droplet.sh. Local edits are overwritten on re-run.
{
	$email_line
	admin off
}

$DOMAIN {
	$tls_line
	encode zstd gzip

	# WebSocket upgrades for the live session feed pass through untouched;
	# Caddy 2 handles them natively, no special directive needed.
	reverse_proxy 127.0.0.1:$APP_PORT {
		header_up X-Forwarded-Proto https
	}

	log {
		output file /var/log/caddy/access.log {
			roll_size 10MiB
			roll_keep 5
		}
	}
}
CADDY
  # Must exist before `caddy validate` runs: the log directive is provisioned
  # during validation and fails outright if the directory is not there.
  install -d -m 0755 -o caddy -g caddy /var/log/caddy
  # An unset $tls_line or $email_line leaves a blank line inside a block, which
  # Caddy accepts but complains about on every start. Normalise it.
  caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    systemctl enable --quiet caddy
    systemctl restart caddy
    ok "Caddy serving $DOMAIN"
  else
    warn "Caddyfile failed validation; Caddy not restarted. Run:"
    warn "  caddy validate --config /etc/caddy/Caddyfile"
    if [[ "$TLS_MODE" == "origin-ca" ]]; then
      warn "Most likely cause: $ORIGIN_CERT / $ORIGIN_KEY do not exist yet."
      warn "Validation provisions the TLS loader, so a missing cert is a hard"
      warn "failure, not a warning. Install the pair and re-run this script."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 10. Firewall
# ---------------------------------------------------------------------------
log "Firewall (ufw)"
# `reset` is what makes this section converge instead of stacking duplicate
# rules on every re-run -- but it is genuinely destructive: any rule you added
# by hand is discarded, so add extra rules to this script, not to ufw directly.
# It also drops a timestamped backup into /etc/ufw each time; keep the last 3.
ufw --force reset >/dev/null
find /etc/ufw -maxdepth 1 -name '*.rules.*' -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n +4 | cut -d' ' -f2- | xargs -r rm -f
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null   # MQTT to mqtt.gomesh.dev:443 lives here

if [[ -n "$ADMIN_SSH_CIDR" ]]; then
  ufw allow from "$ADMIN_SSH_CIDR" to any port 22 proto tcp >/dev/null
  ok "ssh restricted to $ADMIN_SSH_CIDR"
else
  ufw limit 22/tcp >/dev/null
  warn "ssh open to the world (rate-limited). Set ADMIN_SSH_CIDR to narrow it."
fi

if [[ "$TLS_MODE" != "none" ]]; then
  if [[ "$CF_PROXY_ONLY" == "true" ]]; then
    n=0
    for u in https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6; do
      while read -r cidr; do
        [[ -n "$cidr" ]] || continue
        ufw allow from "$cidr" to any port 443 proto tcp >/dev/null
        n=$((n + 1))
      done < <(curl -fsS --max-time 20 "$u" || true)
    done
    if [[ "$n" -gt 0 ]]; then
      ok "443 restricted to $n Cloudflare ranges (origin IP is unreachable directly)"
    else
      warn "could not fetch Cloudflare ranges; opening 443 to all"
      ufw allow 443/tcp >/dev/null
    fi
    # Port 80 stays shut: with the orange cloud on, Cloudflare speaks 443 to the
    # origin and handles the http->https redirect at the edge.
  else
    ufw allow 80/tcp >/dev/null    # ACME HTTP-01 + redirect
    ufw allow 443/tcp >/dev/null
    ok "80 and 443 open (grey-cloud / direct)"
  fi
fi
# APP_PORT is deliberately never opened. server.js calls listen(PORT) with no
# host argument, so it binds 0.0.0.0 -- the firewall is what keeps :3090 private.
ufw --force enable >/dev/null
ok "$(ufw status | sed -n 1p)"

# ---------------------------------------------------------------------------
# 11. Unattended security updates
# ---------------------------------------------------------------------------
log "Unattended upgrades"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'AUTO'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUTO
cat >/etc/apt/apt.conf.d/51mesh-unattended <<'UNATT'
// Reboot for kernel updates at 04:30 local -- after the 04:00 reseed pass has
// finished, so a restart never lands mid-write on observer.json.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
UNATT
systemctl enable --quiet unattended-upgrades 2>/dev/null || true
ok "security updates automatic, reboot window 04:30 $TIMEZONE"

# Ubuntu's fail2ban package ships jail.d/defaults-debian.conf with sshd enabled,
# but installing a package does not guarantee the unit is enabled+running on
# every image. Be explicit rather than assuming.
systemctl enable --now --quiet fail2ban 2>/dev/null || true
if systemctl is-active --quiet fail2ban; then ok "fail2ban active (sshd jail)"
else warn "fail2ban installed but not active"; fi

# ---------------------------------------------------------------------------
# 12. Verify
# ---------------------------------------------------------------------------
log "Verification"
fail=0
for _ in $(seq 1 20); do
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' \
          "http://127.0.0.1:$APP_PORT/api/bootstrap" || true)"
  [[ "$code" == "200" ]] && break
  sleep 2
done
if [[ "${code:-}" == "200" ]]; then
  ok "app: 200 on http://127.0.0.1:$APP_PORT/api/bootstrap"
else
  warn "app did not answer 200 (last: ${code:-none}). journalctl -u mesh-health-check -n 50"
  fail=1
fi

if systemctl is-active --quiet mesh-health-check; then ok "service active"
else warn "service not active"; fail=1; fi

if [[ "$TLS_MODE" != "none" ]]; then
  if systemctl is-active --quiet caddy; then ok "caddy active"
  else warn "caddy not active"; fail=1; fi
fi

# Does the app actually see the broker?  A 200 on /api/bootstrap only proves the
# HTTP layer is up; MQTT can be silently unauthenticated.
# The exact line server.js emits is `[mqtt] connected <broker>`; match that and
# nothing else.  A loose 'mqtt.*connect' also matches the error path, which logs
# `[mqtt] <error message>` -- "connection refused" would then read as success.
if journalctl -u mesh-health-check --since '-2min' --no-pager 2>/dev/null \
     | grep -qF '[mqtt] connected'; then
  ok "MQTT connection logged"
else
  warn "no MQTT connect line yet -- check MQTT_USERNAME / MQTT_PASSWORD in .env"
fi

echo
log "Summary"
cat <<SUMMARY
  app dir      $APP_DIR   (owner $APP_USER, .env mode 600)
  service      systemctl {status,restart} mesh-health-check
  logs         journalctl -u mesh-health-check -f
  data         $APP_DIR/data   (the only state that is not in git)
  public       https://$DOMAIN
  tls          $TLS_MODE
  swap         $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')

  Next:
   1. Point Cloudflare at this box: replace the tunnel CNAME for $DOMAIN with
      an A record -> $(curl -fsS --max-time 3 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<this droplet IP>')
      $( [[ "$CF_PROXY_ONLY" == "true" ]] && echo 'Keep the orange cloud ON, SSL mode Full (strict).' || echo 'Set the record to DNS only (grey cloud) for ACME to work.')
   2. Delete the tunnel once the A record resolves and the site answers:
      cloudflared tunnel delete bayarea-mesh-health-check
   3. Retire the sandbox supervisors: /tmp/app-supervise.sh,
      /tmp/named-tunnel.sh, /tmp/named-tunnel-b.sh, /tmp/tunnel-watchdog.sh
   4. UptimeRobot monitor 803863215 needs no change -- same hostname.
   5. Enable weekly droplet backups (+20%, ~\$1.20/mo) in the DO control panel.
SUMMARY

exit "$fail"
