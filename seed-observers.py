#!/usr/bin/env python3
"""Pre-populate mhc/data/observer.json with coordinates from a CoreScope server.

Pulls /api/nodes, keeps only nodes whose position falls inside the region
GeoJSON, and merges name/lat/lon into the health-check profile store without
overwriting anything the app already learned from adverts.

Usage:
  python3 seed-observers.py            # dry run, prints a report
  python3 seed-observers.py --write    # writes observer.json (backs up first)
"""
import json
import sys
import shutil
import time
import urllib.request
from collections import Counter, defaultdict

CORESCOPE = "https://corescope.stonekitty.net/api/nodes?limit=5000"
GEOJSON = "/home/user/workspace/mhc/regions/us-ca-bay-area.geojson"
STORE = "/home/user/workspace/mhc/data/observer.json"
BOOTSTRAP = "http://localhost:3090/api/bootstrap"
WRITE = "--write" in sys.argv


# ---------- geometry: same ray-casting rules the server uses ----------
def point_in_ring(lon, lat, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if (y1 > lat) != (y2 > lat):
            x_at = x1 + (lat - y1) / (y2 - y1) * (x2 - x1)
            if lon < x_at:
                inside = not inside
    return inside


def point_in_polygon(lon, lat, rings):
    if not rings or not point_in_ring(lon, lat, rings[0]):
        return False
    return not any(point_in_ring(lon, lat, hole) for hole in rings[1:])


def point_in_geometry(lon, lat, geom):
    t = geom.get("type")
    if t == "Polygon":
        return point_in_polygon(lon, lat, geom["coordinates"])
    if t == "MultiPolygon":
        return any(point_in_polygon(lon, lat, poly) for poly in geom["coordinates"])
    return False


def bounds_of(geom):
    xs, ys = [], []

    def walk(c):
        if isinstance(c, (int, float)):
            return
        if len(c) >= 2 and isinstance(c[0], (int, float)) and isinstance(c[1], (int, float)):
            xs.append(c[0])
            ys.append(c[1])
            return
        for sub in c:
            walk(sub)

    walk(geom["coordinates"])
    return min(xs), min(ys), max(xs), max(ys)


def load_regions():
    gj = json.load(open(GEOJSON))
    out = []
    for f in gj["features"]:
        geom = f["geometry"]
        out.append({
            "name": f["properties"].get("name"),
            "group": f["properties"].get("group"),
            "geometry": geom,
            "bounds": bounds_of(geom),
        })
    return out


def region_for(lon, lat, regions):
    for r in regions:
        x0, y0, x1, y1 = r["bounds"]
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            continue
        if point_in_geometry(lon, lat, r["geometry"]):
            return r
    return None


def get_json(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "bayarea-health-check-seed/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def main():
    regions = load_regions()
    print(f"regions loaded: {len(regions)}")

    nodes = get_json(CORESCOPE)["nodes"]
    print(f"CoreScope nodes: {len(nodes)}")

    store = json.load(open(STORE))
    print(f"existing profiles: {len(store)} "
          f"({sum(1 for v in store.values() if v.get('lat') is not None)} located)")

    try:
        boot = get_json(BOOTSTRAP, timeout=20)
        uplinks = {o["key"].upper(): o for o in boot["observerDirectory"]}
    except Exception as exc:  # app may not be running; seeding still works
        print(f"note: could not read app bootstrap ({exc}); skipping uplink cross-check")
        uplinks = {}

    inside, outside, no_coords, bad_key = [], [], [], []
    for n in nodes:
        key = str(n.get("public_key") or "").strip().upper()
        if len(key) != 64 or any(c not in "0123456789ABCDEF" for c in key):
            bad_key.append(n)
            continue
        lat, lon = n.get("lat"), n.get("lon")
        if lat is None or lon is None or (lat == 0 and lon == 0):
            no_coords.append(n)
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            bad_key.append(n)
            continue
        r = region_for(lon, lat, regions)
        rec = {
            "key": key,
            "name": (n.get("name") or "").strip(),
            "lat": round(float(lat), 6),
            "lon": round(float(lon), 6),
            "role": n.get("role"),
            "last_seen": n.get("last_seen"),
            "region": r["name"] if r else None,
            "group": r["group"] if r else None,
        }
        (inside if r else outside).append(rec)

    print(f"\n  inside the GeoJSON:  {len(inside)}")
    print(f"  outside, discarded:  {len(outside)}")
    print(f"  no coordinates:      {len(no_coords)}")
    if bad_key:
        print(f"  unusable key/coords: {len(bad_key)}")

    print("\nkept, by county:")
    for name, count in Counter(r["region"] for r in inside).most_common():
        print(f"  {name:18} {count}")
    print("\nkept, by role:", dict(Counter(r["role"] for r in inside)))

    # merge: never overwrite a coordinate or name the app already learned
    added_loc, added_rec, added_name, conflicts, skipped_existing = 0, 0, 0, [], 0
    for rec in inside:
        cur = store.get(rec["key"])
        if cur is None:
            entry = {"name": rec["name"]} if rec["name"] else {}
            entry["lat"] = rec["lat"]
            entry["lon"] = rec["lon"]
            store[rec["key"]] = entry
            added_rec += 1
            added_loc += 1
            continue
        if cur.get("lat") is None or cur.get("lon") is None:
            cur["lat"] = rec["lat"]
            cur["lon"] = rec["lon"]
            added_loc += 1
        else:
            skipped_existing += 1
            dlat = abs(float(cur["lat"]) - rec["lat"])
            dlon = abs(float(cur["lon"]) - rec["lon"])
            if dlat > 0.02 or dlon > 0.02:
                conflicts.append((rec["name"] or rec["key"][:8], (cur["lat"], cur["lon"]),
                                  (rec["lat"], rec["lon"])))
        if not str(cur.get("name") or "").strip() and rec["name"]:
            cur["name"] = rec["name"]
            added_name += 1

    print(f"\nmerge: new profiles {added_rec}, coordinates filled {added_loc}, "
          f"names filled {added_name}, already located (left alone) {skipped_existing}")

    # ---- path hash width -----------------------------------------------------
    # A node's `path.hash.mode` sizes only the packets it originates, so the only
    # honest evidence is the node's own advert. CoreScope reports that as
    # multi_byte_status == "confirmed" with multi_byte_evidence == "advert";
    # "suspected"/"path" means the prefix was merely seen at that width inside
    # somebody else's forwarded path, which says nothing about this node - a
    # 1.14+ repeater relays every width regardless of its own setting.
    #
    # Unlike coordinates this is position-independent, so it is applied to every
    # profile already in the store, not just the ones inside the GeoJSON. A width
    # never creates a profile: doing so would drag the whole 800-node network in.
    hash_set, hash_changed, hash_cleared, hash_examples = 0, [], 0, []
    for n in nodes:
        key = str(n.get("public_key") or "").strip().upper()
        cur = store.get(key)
        if cur is None or not isinstance(cur, dict):
            continue
        confirmed = (
            str(n.get("multi_byte_status") or "").lower() == "confirmed"
            and str(n.get("multi_byte_evidence") or "").lower() == "advert"
            and not n.get("hash_size_inconsistent")
        )
        width = n.get("hash_size")
        width = int(width) if isinstance(width, int) and 1 <= width <= 3 else None
        prev = cur.get("hashBytes")
        if not confirmed or width is None:
            # Stop asserting a width CoreScope no longer stands behind.
            if prev is not None:
                cur.pop("hashBytes", None)
                hash_cleared += 1
            continue
        cur["hashBytes"] = width
        if prev is None:
            hash_set += 1
            hash_examples.append((cur.get("name") or key[:8], width))
        elif int(prev) != width:
            hash_changed.append((cur.get("name") or key[:8], prev, width))

    print(f"\npath hash width (confirmed from the node's own advert):")
    print(f"  newly recorded:  {hash_set}")
    print(f"  width changed:   {len(hash_changed)}")
    print(f"  no longer confirmed, cleared: {hash_cleared}")
    widths = Counter(
        v["hashBytes"] for v in store.values()
        if isinstance(v, dict) and v.get("hashBytes") is not None
    )
    print(f"  store totals:    " + ", ".join(f"{w}-byte {c}" for w, c in sorted(widths.items())))
    for name, prev, width in hash_changed[:10]:
        print(f"    {name}: {prev} -> {width} bytes")
    for name, width in hash_examples[:10]:
        print(f"    + {name}: {width} bytes")
    if conflicts:
        print(f"\ncoordinate disagreements >0.02 deg (app value kept): {len(conflicts)}")
        for name, app_v, cs_v in conflicts[:10]:
            print(f"  {name}: app {app_v} vs corescope {cs_v}")

    # what this does for the observers the map actually plots
    if uplinks:
        located_before = {k for k, o in uplinks.items() if o.get("lat") is not None}
        seeded = {r["key"] for r in inside}
        now_located = {k for k in uplinks if store.get(k, {}).get("lat") is not None}
        out_of_area_uplinks = [uplinks[r["key"]] for r in outside if r["key"] in uplinks]
        print(f"\nMQTT uplink observers: {len(uplinks)}")
        print(f"  located before: {len(located_before)}")
        print(f"  located after:  {len(now_located)}")
        still = [uplinks[k]["label"] for k in uplinks if k not in now_located]
        print(f"  still unlocated ({len(still)}): {', '.join(sorted(still)) or 'none'}")
        print(f"  uplinks CoreScope places OUTSIDE the GeoJSON "
              f"({len(out_of_area_uplinks)}): "
              f"{', '.join(sorted(o['label'] for o in out_of_area_uplinks)) or 'none'}")
        seeded_uplinks = [uplinks[k]['label'] for k in (seeded & set(uplinks)) ]
        print(f"  uplinks matched in CoreScope (in area): {len(seeded_uplinks)}")

    # existing profiles the app located outside the GeoJSON
    stray = []
    for key, v in store.items():
        if v.get("lat") is None or v.get("lon") is None:
            continue
        if region_for(float(v["lon"]), float(v["lat"]), regions) is None:
            stray.append((v.get("name") or key[:8], v["lat"], v["lon"], key.upper() in uplinks))
    print(f"\nprofiles already located OUTSIDE the GeoJSON: {len(stray)}")
    for name, lat, lon, is_uplink in stray[:40]:
        print(f"  {'UPLINK ' if is_uplink else '       '}{name} {lat},{lon}")

    # parse them out: keep the name (the app still lists the observer) but drop
    # a position that does not belong to this deployment's regions
    purged = 0
    for key, v in store.items():
        if v.get("lat") is None or v.get("lon") is None:
            continue
        if region_for(float(v["lon"]), float(v["lat"]), regions) is None:
            v.pop("lat", None)
            v.pop("lon", None)
            purged += 1
    # a profile with neither a name nor a position carries no information
    empty = [k for k, v in store.items() if not str(v.get("name") or "").strip()
             and v.get("lat") is None]
    for key in empty:
        del store[key]
    print(f"purged out-of-region coordinates: {purged}; dropped empty profiles: {len(empty)}")

    print(f"\nfinal profile count: {len(store)} "
          f"({sum(1 for v in store.values() if v.get('lat') is not None)} located)")

    if WRITE:
        backup = f"{STORE}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(STORE, backup)
        with open(STORE, "w", encoding="utf-8") as fh:
            json.dump(store, fh, indent=2, ensure_ascii=False, sort_keys=True)
            fh.write("\n")
        print(f"\nwrote {STORE} (backup at {backup})")
    else:
        print("\ndry run - nothing written. re-run with --write to apply.")


if __name__ == "__main__":
    main()
