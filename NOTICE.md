# Notices

Bay Area Mesh Health Check is a fork of
[yellowcooln/meshcore-health-check](https://github.com/yellowcooln/meshcore-health-check).
It branched at upstream `v1.3.7` (commit `b478e83`) and merged upstream `v1.3.8`
(commit `8bab150`). Upstream's history and authorship are kept in this
repository's history. The original app came from the Boston MeshCore community
([healthcheck.bostonme.sh](https://healthcheck.bostonme.sh/)), and the idea for it
came from Nick D.

## This project

Released under the MIT License; see [LICENSE](LICENSE).

- Upstream code, logo and documentation: Copyright (c) 2026 yellowcooln and
  contributors, MIT. Upstream added its license on 2026-10-29 (commit `e9017b4`),
  in reply to [issue #77](https://github.com/yellowcooln/meshcore-health-check/issues/77).
- Bay Area changes: Copyright (c) 2026 Tim McGee, MIT. The changes are listed in
  [CHANGES.md](CHANGES.md) (`1.3.8+bayarea.N` before 1.0.0, then
  `X.Y.Z+upstream.A.B.C`) and explained in
  [docs/bay-area-adaptation.md](docs/bay-area-adaptation.md).
- `public/logo.png` is upstream's mark recoloured; `public/logo-stock.png` is the
  original.

## Bundled data

- **MeshCore region scope names**: `regions/us-ca-meshcore-scopes.json` (the 73
  codes) and `test/fixtures/meshcore-settings-regions-7ec46658.json` (an unchanged
  copy of `data/regions.json`) come from
  [matkam/meshcore-settings](https://github.com/matkam/meshcore-settings) at commit
  `7ec46658`. MIT License, Copyright (c) 2026 matkam:

  > Permission is hereby granted, free of charge, to any person obtaining a copy
  > of this software and associated documentation files (the "Software"), to deal
  > in the Software without restriction, including without limitation the rights
  > to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  > copies of the Software, and to permit persons to whom the Software is
  > furnished to do so, subject to the following conditions:
  >
  > The above copyright notice and this permission notice shall be included in all
  > copies or substantial portions of the Software.
  >
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  > IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  > FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  > LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  > OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  > SOFTWARE.

- **County boundaries**: `regions/us-ca-bay-area.geojson` is derived from legal
  county boundaries in the US Census Bureau
  [TIGERweb State_County service](https://tigerweb.geo.census.gov/arcgisrest/),
  simplified and grouped into regions here. US federal government data, public
  domain.
- **Upstream boundary files**: the other files in `regions/` come from upstream;
  their sources (US Census Bureau cartographic boundary files, Natural Earth) are
  listed in [regions/README.md](regions/README.md).

## Dependencies

Installed by npm, each under its own license (see `node_modules/<name>/LICENSE`):

| Package | License |
|---|---|
| `@michaelhart/meshcore-decoder` | MIT |
| `dotenv` | BSD-2-Clause |
| `express` | MIT |
| `leaflet` (served from `node_modules/leaflet/dist`) | BSD-2-Clause |
| `mqtt` | MIT |
| `qrcode-generator` | MIT |
| `ws` | MIT |

## Map tiles

Map tiles and their attribution come from the configured provider at run time
(OpenStreetMap contributors, or CARTO when `CARTO_BASEMAP_KEY` is set). The map
shows each provider's attribution; no tiles are bundled.
