# Documentation

- **[bay-area-adaptation.md](bay-area-adaptation.md)** — how the upstream Boston
  deployment was retargeted at the Bay Area: broker, channel, regions, uplink-code
  fallback, observer seeding, path hash widths, scoring, theme, and every layout
  decision, with the reasoning and the dead ends. Also carries the running list of
  open items.
- **[deploy-cloudflare-tunnel.md](deploy-cloudflare-tunnel.md)** — self-hosting on
  your own hardware behind a Cloudflare tunnel, including the named-tunnel setup
  that replaced quick tunnels and the two config values that will otherwise cost
  you an afternoon.

Neither file contains a credential. The GoMesh MQTT password, the CARTO key, and
the Turnstile keys live only in `.env`, which is git-ignored.
