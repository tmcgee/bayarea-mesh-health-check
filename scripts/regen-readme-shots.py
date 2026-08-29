#!/usr/bin/env python3
"""Regenerate README image1-3.png from the live Bay Area instance.

Mirrors the framing of the Boston-era originals:
  image1 - hero + session code card + health summary
  image2 - "Who saw the message" timeline plus the first receipt cards
  image3 - "Where the observers are" coverage map panel

Source is the archived share page for MHC-BDCA34 (31 receipts, 100 percent,
8/8 regions), read from localhost so no tunnel and no Turnstile are involved.
Crops are taken from a full-page capture using measured element geometry, so
the framing tracks layout changes instead of hard-coded pixel guesses.
"""
import sys
from playwright.sync_api import sync_playwright

SESSION = "001ba448-5a91-491f-958a-eb1f947fb726"
URL = f"http://localhost:3090/share/{SESSION}"
OUT = "/home/user/workspace/mhc"

GEO_JS = """(sels) => sels.map(s => {
  const e = document.querySelector(s);
  if (!e) return [s, null];
  const r = e.getBoundingClientRect();
  return [s, {x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY),
              w: Math.round(r.width), h: Math.round(r.height)}];
})"""


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--force-color-profile=srgb"])
        pg = b.new_page(viewport={"width": 1500, "height": 1200}, device_scale_factor=2)
        pg.goto(URL, wait_until="networkidle", timeout=90_000)
        pg.evaluate("document.body.setAttribute('data-ui-theme','dark')")
        pg.wait_for_timeout(1500)

        # Force the map into view so Leaflet requests its tiles, then wait them out.
        pg.evaluate("document.querySelector('.map-panel').scrollIntoView()")
        try:
            pg.wait_for_selector("#coverage-map .leaflet-tile-loaded", timeout=45_000)
        except Exception:
            print("warn: no leaflet tile reported loaded", file=sys.stderr)
        pg.wait_for_timeout(5000)
        pg.evaluate("window.scrollTo(0,0)")
        pg.wait_for_timeout(800)

        geo = dict(pg.evaluate(GEO_JS, [".hero-stage", ".command-panel",
                                        ".map-panel", ".reports-panel"]))
        for k, v in geo.items():
            if v is None:
                sys.exit(f"missing element {k} - layout changed, fix the selectors")

        # Longest receipt-card bottom edge that still fits in a ~1000px band,
        # so image2 never ends mid-card.
        card_cut = pg.evaluate("""(() => {
          const top = document.querySelector('.reports-panel').getBoundingClientRect().top + scrollY;
          let cut = top + 1000;
          document.querySelectorAll('#receipts > *').forEach(c => {
            const b = c.getBoundingClientRect().bottom + scrollY;
            if (b <= top + 1000) cut = Math.max(cut === top + 1000 ? 0 : cut, b);
          });
          return Math.round(cut);
        })()""")
        print("receipt cut at y =", card_cut)

        cmd = geo[".command-panel"]
        rep, mp = geo[".reports-panel"], geo[".map-panel"]
        pad = 20
        crops = {
            # the result card itself. The share page's own hero reads "someone
            # shared with you", which is true but a poor README opener, so the
            # crop starts below it.
            "image1.png": {"x": cmd["x"] - pad, "y": cmd["y"] - pad,
                           "width": cmd["w"] + pad * 2, "height": cmd["h"] + pad * 2},
            # reports panel, trimmed to the spread bar and the first receipt
            # cards, cut at a card boundary rather than through one
            "image2.png": {"x": rep["x"] - pad, "y": rep["y"] - pad,
                           "width": rep["w"] + pad * 2,
                           "height": card_cut - rep["y"] + pad * 2},
            # whole coverage map panel
            "image3.png": {"x": mp["x"] - pad, "y": mp["y"] - pad,
                           "width": mp["w"] + pad * 2, "height": mp["h"] + pad * 2},
        }
        for name, clip in crops.items():
            pg.screenshot(path=f"{OUT}/{name}", full_page=True, clip=clip)
            print(f"{name}  {clip['width']}x{clip['height']} css px at y={clip['y']}")
        b.close()


if __name__ == "__main__":
    main()
