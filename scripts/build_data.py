#!/usr/bin/env python3
"""Build data/uov.json (stops + lines) and data/times.json (departures) for U-OV from the
national GTFS feed.

Usage:
    python3 scripts/build_data.py            # download (if changed) and build
    python3 scripts/build_data.py --offline  # build from the cached zip only
    python3 scripts/build_data.py --out-dir /tmp/new --cache /data/cache/gtfs-nl.zip

The weekly refresh on the NAS (nas/clawback_data.py) uses the same functions: build(),
check() and write().

Only the standard library is used. The OVapi usage policy asks clients to identify
themselves in the User-Agent; set UOV_USER_AGENT to something with a way to contact you,
e.g. UOV_USER_AGENT="clawback/1.0 (you@example.com)".
"""
from __future__ import annotations

import argparse
import csv
import email.utils
import io
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "gtfs-nl.zip"
OUT = ROOT / "data" / "uov.json"
GTFS_URL = "https://gtfs.ovapi.nl/nl/gtfs-nl.zip"
USER_AGENT = os.environ.get("UOV_USER_AGENT", "clawback/1.0 (personal project)")

AGENCY = "UOV"
# The U-OV brand covers two concessions, told apart by the operator code in the
# realtime trip id. CXX is the legacy Connexxion code; Transdev runs these lines now.
OPERATORS = {
    "CXX": "Utrecht Binnen (Transdev)",      # city, tram, Nieuwegein, Houten, Zeist, Vianen ...
    "KEOLIS": "Utrecht Buiten (Keolis)",     # U-bus/U-link/U-liner around Amersfoort, Veenendaal, Woerden ...
}

# Some U-OV lines are filed under another agency: in late 2026 the night lines N1, N4, N5, N6
# and N9 are under TRANSDEV. Their realtime trip ids carry the Utrecht concession ("CXX:U409:...")
# like the other city lines, so trips with this prefix belong to U-OV whatever their agency.
# Transdev's other CXX concessions (F = Gooi en Vechtstreek, Z = Zuid-Holland ...) stay out.
CONCESSION_PREFIXES = ("CXX:U",)

MODES = {"0": "tram", "3": "bus"}

# Platforms of one place that the data sources name differently ("Station" / "Station Bilthoven",
# "Busstat. Lekbrug Oost (E)" / "Busstation Lekbrug (Oost)") are merged when they are this close.
# In the 2026 feed the true duplicates are 6-19 m apart, distinct stops at least 50 m.
SAME_PLACE_METRES = 25

# A line can run to several destinations in one direction (short runs, extensions). The most
# frequent one names the direction; others with at least this share of the trips get their own
# row in the app. Every destination gets its own departure key, so the app can label each departure.
OWN_ROW_SHARE = 0.10


def download(cache: Path = CACHE) -> None:
    """Fetch the feed into `cache`, only when it changed (If-Modified-Since)."""
    cache.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(GTFS_URL, headers={"User-Agent": USER_AGENT})
    if cache.exists():
        req.add_header("If-Modified-Since", email.utils.formatdate(cache.stat().st_mtime, usegmt=True))
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            tmp = cache.with_suffix(".part")
            with open(tmp, "wb") as f:
                while chunk := resp.read(1 << 20):
                    f.write(chunk)
            tmp.replace(cache)
            print(f"downloaded {cache.stat().st_size / 1e6:.0f} MB")
    except urllib.error.HTTPError as e:
        if e.code != 304:
            raise
        print("feed unchanged, using cache")


def rows(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))


def split_name(full: str) -> tuple[str, str]:
    """'Utrecht, Station Vaartsche Rijn' -> ('Utrecht', 'Station Vaartsche Rijn')."""
    town, sep, name = full.partition(", ")
    return (town, name) if sep else ("", full)


def is_uov_trip(agency_id: str, realtime_trip_id: str) -> bool:
    op = realtime_trip_id.split(":", 1)[0]
    if op not in OPERATORS:
        return False
    return agency_id == AGENCY or realtime_trip_id.startswith(CONCESSION_PREFIXES)


def strip_platform(name: str, platform: str) -> str:
    """'CS Jaarbeurszijde (C2)' on platform C2 -> 'CS Jaarbeurszijde'. Some sources put the platform
    in the name; without this the app shows those platforms as separate stops."""
    if platform and name.endswith(f"({platform})"):
        return name[: -len(platform) - 2].rstrip()
    return name


def _metres(a: dict, b: dict) -> float:
    dy = (a["lat"] - b["lat"]) * 111_320
    dx = (a["lon"] - b["lon"]) * 111_320 * math.cos(math.radians((a["lat"] + b["lat"]) / 2))
    return math.hypot(dx, dy)


def _first_letters(name: str) -> str:
    return re.sub(r"[^a-z]", "", name.lower())[:4]


def _preferred_name(names) -> str:
    """Of several spellings of one place: no abbreviations (".") first, then the longest."""
    return max(names, key=lambda n: ("." not in n, len(n), n))


def merge_place_names(stops) -> None:
    """Give all platforms of one place the same name, so the app groups them (it groups on town +
    name). Strips a platform code from the name, then merges names in the same town whose platforms
    are within SAME_PLACE_METRES and start alike ("Station" / "Station Houten")."""
    stops = list(stops)
    for s in stops:
        s["name"] = strip_platform(s["name"], s["platform"])

    by_name: dict[tuple, list] = defaultdict(list)
    for s in stops:
        by_name[(s["town"], s["name"])].append(s)
    keys = list(by_name)
    parent = {k: k for k in keys}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    by_town: dict[str, list] = defaultdict(list)
    for k in keys:
        by_town[k[0]].append(k)
    for town_keys in by_town.values():
        for i, a in enumerate(town_keys):
            for b in town_keys[i + 1:]:
                if _first_letters(a[1]) != _first_letters(b[1]):
                    continue
                if min(_metres(x, y) for x in by_name[a] for y in by_name[b]) <= SAME_PLACE_METRES:
                    parent[find(a)] = find(b)

    clusters: dict[tuple, list] = defaultdict(list)
    for k in keys:
        clusters[find(k)].append(k)
    for members in clusters.values():
        if len(members) < 2:
            continue
        name = _preferred_name(k[1] for k in members)
        for k in members:
            for s in by_name[k]:
                s["name"] = name


def build(cache: Path = CACHE) -> tuple[dict, dict]:
    """(stops and lines, departure times) from the cached feed. Both carry the same "build" id."""
    with zipfile.ZipFile(cache) as zf:
        feed = next(rows(zf, "feed_info.txt"))

        routes = {r["route_id"]: r for r in rows(zf, "routes.txt")}

        trips = {}  # trip_id -> (route_id, headsign, direction_id, service_id)
        route_operator = {}  # route_id -> operator code
        for t in rows(zf, "trips.txt"):
            route = routes.get(t["route_id"])
            if route is None or not is_uov_trip(route["agency_id"], t["realtime_trip_id"]):
                continue
            op = t["realtime_trip_id"].split(":", 1)[0]
            trips[t["trip_id"]] = (t["route_id"], t["trip_headsign"], t["direction_id"], t["service_id"])
            route_operator[t["route_id"]] = op
        used_routes = route_operator.keys()
        print(f"{len(used_routes)} routes, {len(trips)} trips")

        service_dates: dict[str, set] = defaultdict(set)
        for r in rows(zf, "calendar_dates.txt"):
            if r["exception_type"] == "1":
                service_dates[r["service_id"]].add(r["date"])

        # stop_id -> {(route_id, direction_id)}; only stops where you can board.
        serves: dict[str, set] = defaultdict(set)
        # (stop_id, route_id, direction_id) -> [(minutes after midnight of the service day, service_id, headsign)]
        departures: dict[tuple, list] = defaultdict(list)
        # (stop_id, route_id, direction_id) -> Counter of the next stop_id. Used to tell apart the two
        # directions of loop lines that end at the same place ("via ..."). stop_times.txt is ordered
        # by trip and stop_sequence, so the next row of the same trip is the next stop.
        next_stop: dict[tuple, Counter] = defaultdict(Counter)
        prev = None  # (trip_id, stop_id, route_id, direction_id) of the previous row
        for st in rows(zf, "stop_times.txt"):
            trip = trips.get(st["trip_id"])
            if trip is None:
                prev = None
                continue
            if prev and prev[0] == st["trip_id"]:
                next_stop[(prev[1], prev[2], prev[3])][st["stop_id"]] += 1
            prev = (st["trip_id"], st["stop_id"], trip[0], trip[2])
            if st["pickup_type"] == "1":
                continue
            route_id, headsign, direction, service = trip
            serves[st["stop_id"]].add((route_id, direction))
            h, mi, _s = st["departure_time"].split(":")
            departures[(st["stop_id"], route_id, direction)].append(
                (int(h) * 60 + int(mi), service, st["stop_headsign"] or headsign))

        # The same physical platform can appear several times (one entry per data source,
        # e.g. Transdev with a stop_code, Keolis without). Merge them on the national
        # quay id (stop_ifopt, "NL:Q:50001380"); fall back to stop_id.
        merged: dict[str, dict] = {}
        stop_key: dict[str, str] = {}  # stop_id -> merged key (the app uses quay || id)
        for s in rows(zf, "stops.txt"):
            if s["stop_id"] not in serves:
                continue
            key = s["stop_ifopt"] or s["stop_id"]
            stop_key[s["stop_id"]] = key
            stop = merged.get(key)
            if stop is None:
                town, name = split_name(s["stop_name"])
                stop = merged[key] = {
                    "id": s["stop_id"],
                    "quay": s["stop_ifopt"],        # national platform id
                    "tpc": s["stop_code"],          # timing point code, for live departures (OVapi)
                    "town": town,
                    "name": name,
                    "platform": s["platform_code"],
                    "lat": round(float(s["stop_lat"]), 6),
                    "lon": round(float(s["stop_lon"]), 6),
                    "_serves": set(),
                }
            elif not stop["tpc"] and s["stop_code"]:
                stop["tpc"] = s["stop_code"]
            stop["_serves"] |= serves[s["stop_id"]]

        merge_place_names(merged.values())

        # Destinations per stop group (town + name, as the app groups them), line and direction,
        # counted in departures over all dates in the feed.
        group_of = {key: (st["town"], st["name"]) for key, st in merged.items()}
        dest_count: dict[tuple, Counter] = defaultdict(Counter)
        for (sid, rid, d), deps in departures.items():
            if sid in stop_key:
                counts = dest_count[(group_of[stop_key[sid]], rid, d)]
                for _m, service, hs in deps:
                    counts[hs] += len(service_dates.get(service, ())) or 1
        destinations = {k: rank_destinations(c) for k, c in dest_count.items()}  # -> (main, [own rows])

        def line_order(x):
            short = routes[x[0]]["route_short_name"]
            return (len(short), short, x[1])

        stop_names = {s["stop_id"]: split_name(s["stop_name"])[1] for s in rows(zf, "stops.txt")}

        # Loop lines can have the same destination in both directions at one stop. Find those
        # (per stop name, across its platforms) so they can be labelled "via <next stop>".
        def main_dest(stop, rid, d):
            return destinations[((stop["town"], stop["name"]), rid, d)][0]

        dirs_per_dest: dict[tuple, set] = defaultdict(set)
        for stop in merged.values():
            for rid, d in stop["_serves"]:
                dirs_per_dest[(stop["town"], stop["name"], rid, main_dest(stop, rid, d))].add(d)

        def via(stop, rid, d):
            ids = [sid for sid, key in stop_key.items() if key == (stop["quay"] or stop["id"])]
            counts = Counter()
            for sid in ids:
                counts.update(next_stop.get((sid, rid, d), {}))
            return stop_names.get(counts.most_common(1)[0][0], "") if counts else ""

        stops = []
        for stop in merged.values():
            # [route_id, main destination, direction_id] (+ via, only when needed) (+ the other
            # destinations that get their own row, only when there are any; via is then "" when not
            # needed). The direction links to data/times.json.
            lines = []
            for rid, d in stop.pop("_serves"):
                main, others = destinations[((stop["town"], stop["name"]), rid, d)]
                entry = [rid, main, d]
                if len(dirs_per_dest[(stop["town"], stop["name"], rid, main)]) > 1:
                    entry.append(via(stop, rid, d))
                if others:
                    entry[3:] = [entry[3] if len(entry) > 3 else "", others]
                lines.append(entry)
            stop["lines"] = sorted(lines, key=line_order)
            stops.append(stop)
        stops.sort(key=lambda s: (s["town"], s["name"], s["platform"]))

        main_of = {(key, rid, d): destinations[(group_of[key], rid, d)][0]
                   for (sid, rid, d) in departures if sid in stop_key for key in [stop_key[sid]]}

    times = build_times(departures, stop_key, service_dates, main_of)
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    build_id = f"{generated}/{feed['feed_version']}"  # links uov.json and times.json of one build
    times = {"build": build_id, **times}
    return {
        "generated": generated,
        "build": build_id,
        "feed": {"version": feed["feed_version"], "start": feed["feed_start_date"], "end": feed["feed_end_date"]},
        "operators": OPERATORS,
        "routes": {
            rid: {
                "line": r["route_short_name"],
                "name": r["route_long_name"],
                "mode": MODES.get(r["route_type"], "bus"),
                "color": r["route_color"],
                "text": r["route_text_color"],
                "op": route_operator[rid],
            }
            for rid, r in routes.items() if rid in used_routes
        },
        "stops": stops,
    }, times


def rank_destinations(counts: Counter) -> tuple[str, list[str]]:
    """(the most frequent destination, the others with at least OWN_ROW_SHARE of the departures,
    most frequent first). Ties go alphabetically, so a rebuild gives the same answer."""
    ranked = sorted(counts.items(), key=lambda x: (-x[1], x[0]))
    total = sum(counts.values())
    return ranked[0][0], [hs for hs, n in ranked[1:] if n >= OWN_ROW_SHARE * total]


def build_times(departures: dict, stop_key: dict, service_dates: dict, main_of: dict | None = None) -> dict:
    """Departure times per platform, line and direction, for every date in the feed.

    Identical days (all weekdays, all Saturdays ...) are stored once:
        { "dates": ["20261116", ...],
          "k": { "<quay>|<route_id>|<direction_id>": { "p": [[minutes, ...], ...], "d": [pattern per date] } } }
    Minutes count from midnight of the service day and can exceed 1440 (after-midnight trips).
    The direction key has every departure. Departures to another destination than the main one
    (main_of[(quay, route_id, direction_id)]) are also under "<quay>|<route_id>|<direction_id>|<destination>".
    """
    dates = sorted(set().union(*service_dates.values())) if service_dates else []
    main_of = main_of or {}
    merged: dict[str, list] = defaultdict(list)
    for (stop_id, route_id, direction), deps in departures.items():
        if stop_id not in stop_key:
            continue
        base = f"{stop_key[stop_id]}|{route_id}|{direction}"
        main = main_of.get((stop_key[stop_id], route_id, direction))
        merged[base].extend(deps)
        for dep in deps:
            if main is not None and dep[2] != main:
                merged[f"{base}|{dep[2]}"].append(dep)

    out = {}
    for key, deps in merged.items():
        by_day = {d: set() for d in dates}
        for minutes, service, *_ in deps:
            for d in service_dates.get(service, ()):
                if d in by_day:
                    by_day[d].add(minutes)
        patterns: list[list[int]] = []
        index: dict[tuple, int] = {}
        per_date = []
        for d in dates:
            day = tuple(sorted(by_day[d]))
            if day not in index:
                index[day] = len(patterns)
                patterns.append(list(day))
            per_date.append(index[day])
        out[key] = {"p": patterns, "d": per_date}
    return {"dates": dates, "k": out}


def check(data: dict, times: dict, previous: dict | None = None, today: date | None = None) -> list[str]:
    """Problems with a fresh build (empty: fine to publish). The weekly refresh publishes without
    review, so be strict: a feed that changed its format should keep the old data, not break the app."""
    problems = []
    stops, routes = data.get("stops") or [], data.get("routes") or {}
    if len(stops) < 2500:
        problems.append(f"only {len(stops)} stops")
    if len(routes) < 100:
        problems.append(f"only {len(routes)} routes")
    ops = {r.get("op") for r in routes.values()}
    for op in OPERATORS:
        if op not in ops:
            problems.append(f"no routes for {op}")
    if not any(r.get("mode") == "tram" for r in routes.values()):
        problems.append("no tram lines")
    for st in stops:
        if not (st.get("name") and st.get("lines")):
            problems.append(f"incomplete stop {st.get('id')}")
        elif not (50.7 < st.get("lat", 0) < 53.6 and 3.3 < st.get("lon", 0) < 7.3):
            problems.append(f"stop {st['id']} is outside the Netherlands")
        for line in st.get("lines", []):
            if line[0] not in routes:
                problems.append(f"stop {st['id']} has an unknown route {line[0]}")
    if previous and len(stops) < 0.9 * len(previous.get("stops") or []):
        problems.append(f"{len(stops)} stops, down from {len(previous['stops'])}")

    keys, dates = times.get("k") or {}, times.get("dates") or []
    if len(keys) < 5000:
        problems.append(f"only {len(keys)} stop/line/direction keys with departures")
    today = today or date.today()
    ahead = [d for d in dates if d >= today.strftime("%Y%m%d")]
    if len(ahead) < 14:
        problems.append(f"departures for only {len(ahead)} days from today")
    if times.get("build") != data.get("build"):
        problems.append("uov.json and times.json are from different builds")
    return problems[:10]


def write(data: dict, times: dict, out_dir: Path) -> tuple[Path, Path]:
    """Write uov.json and times.json to `out_dir`; returns their paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    uov, tim = out_dir / "uov.json", out_dir / "times.json"
    uov.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tim.write_text(json.dumps(times, separators=(",", ":")), encoding="utf-8")
    return uov, tim


def summary(data: dict, times: dict) -> str:
    return (f"{len(data['stops'])} stops, {len(data['routes'])} routes, {len(times['k'])} stop/line/direction "
            f"keys, departures {times['dates'][0]}–{times['dates'][-1]}" if times.get("dates") else "no departures")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--offline", action="store_true", help="don't download, use the cached zip")
    ap.add_argument("--out-dir", type=Path, default=OUT.parent, help="where to write uov.json and times.json (default: data/)")
    ap.add_argument("--cache", type=Path, default=CACHE, help="the downloaded GTFS zip (default: .cache/gtfs-nl.zip)")
    args = ap.parse_args()

    if not args.offline:
        download(args.cache)
    elif not args.cache.exists():
        print(f"no cached feed at {args.cache}", file=sys.stderr)
        return 1

    data, times = build(args.cache)
    problems = check(data, times)
    uov, tim = write(data, times, args.out_dir)
    print(f"wrote {uov} ({uov.stat().st_size / 1e3:.0f} kB) and {tim} ({tim.stat().st_size / 1e6:.1f} MB): {summary(data, times)}")
    if problems:
        print("WARNING, this build looks wrong: " + "; ".join(problems), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
