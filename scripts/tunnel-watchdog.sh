#!/bin/bash
# End-to-end tunnel watchdog. Pure bash, no agent, no credits.
#
# Why this exists: on 2026-08-29 at 17:38Z Cloudflare deregistered every
# connection of the tunnel while BOTH local cloudflared processes still
# reported {"readyConnections":4} and logged nothing at all. Their sockets to
# 198.41.x.x:7844 were ESTAB with empty queues - half-open TCP that this
# sandbox's NAT never tore down, so cloudflared had no reason to reconnect.
# The site served 530 / error 1033 for 30 minutes with the app healthy on
# :3090. Neither the respawn supervisors (the process never exits) nor
# /ready (it is the wedged process's own opinion of itself) can see this.
# The only trustworthy signal is the public URL.
#
# Rules: never kill a supervisor, never touch node. Kill the cloudflared
# children by exact PID and let their own respawn loops bring them back.
URL="${TUNNEL_PROBE_URL:-https://healthcheck.example.com/api/bootstrap}"
LOCAL="http://localhost:3090/api/bootstrap"
AUTH="${TUNNEL_PROBE_AUTH:-}"   # user:pass, only if the site sits behind Basic auth
LOG=/tmp/tunnel-watchdog.log
INTERVAL=60
FAILS_BEFORE_ACTION=2
fails=0

log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
log "watchdog started (pid $$), probing every ${INTERVAL}s, acting after ${FAILS_BEFORE_ACTION} consecutive failures"

while true; do
  pub=$(curl -s -o /dev/null -m 15 ${AUTH:+-u "$AUTH"} -w '%{http_code}' "$URL" 2>/dev/null)
  if [ "$pub" = "200" ]; then
    [ "$fails" -gt 0 ] && log "public recovered ($pub) after $fails failed probe(s)"
    fails=0
    sleep "$INTERVAL"
    continue
  fi

  loc=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$LOCAL" 2>/dev/null)
  if [ "$loc" != "200" ]; then
    log "public $pub but local is also $loc - app problem, not the tunnel; leaving it to the app supervisor"
    fails=0
    sleep "$INTERVAL"
    continue
  fi

  fails=$((fails + 1))
  log "public $pub while local 200 (consecutive failure $fails)"

  if [ "$fails" -ge "$FAILS_BEFORE_ACTION" ]; then
    # Match only the connector binary itself, anchored at the start of args,
    # so no shell command that merely mentions cloudflared can be killed.
    pids=$(ps -eo pid,args --no-headers | awk '$2 == "/tmp/cloudflared" && /tunnel run$/ {print $1}')
    if [ -z "$pids" ]; then
      log "no cloudflared child found - supervisors should be respawning one; waiting"
    else
      for p in $pids; do
        log "restarting wedged connector pid $p ($(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null))"
        kill -CONT "$p" 2>/dev/null   # a stopped process never reaps a queued SIGTERM
        kill "$p" 2>/dev/null
        for _ in 1 2 3 4 5 6; do
          kill -0 "$p" 2>/dev/null || break
          sleep 1
        done
        if kill -0 "$p" 2>/dev/null; then
          log "pid $p ignored SIGTERM, escalating to SIGKILL"
          kill -9 "$p" 2>/dev/null
          sleep 2
        fi
        kill -0 "$p" 2>/dev/null && log "pid $p STILL ALIVE after SIGKILL - manual attention needed" \
                                 || log "pid $p gone, its supervisor will respawn in 5s"
        sleep 8
      done
    fi
    fails=0
    sleep 90   # cooldown: let the respawn loops re-register before probing again
  else
    sleep 20   # second opinion sooner than a full interval
  fi
done
