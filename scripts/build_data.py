#!/usr/bin/env python3
"""Build data/uov.json (stops + lines for the U-OV concession) from the national GTFS feed.

Usage:
    python3 scripts/build_data.py            # download (if changed) and build
    python3 scripts/build_data.py --offline  # build from the cached zip only

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
import os
import sys
import urllib.error
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "gtfs-nl.zip"
OUT = ROOT / "data" / "uov.json"
OUT_TIMES = ROOT / "data" / "times.json"
GTFS_URL = "https://gtfs.ovapi.nl/nl/gtfs-nl.zip"
USER_AGENT = os.environ.get("UOV_USER_AGENT", "clawback/1.0 (personal project)")

AGENCY = "UOV"
# The U-OV brand covers two concessions, told apart by the operator code in the
# realtime trip id. CXX is the legacy Connexxion code; Transdev runs these lines now.
OPERATORS = {
    "CXX": "Utrecht Binnen (Transdev)",      # city, tram, Nieuwegein, Houten, Zeist, Vianen ...
    "KEOLIS": "Utrecht Buiten (Keolis)",     # U-bus/U-link/U-liner around Amersfoort, Veenendaal, Woerden ...
}

MODES = {"0": "tram", "3": "bus"}


def download() -> None:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(GTFS_URL, headers={"User-Agent": USER_AGENT})
    if CACHE.exists():
        req.add_header("If-Modified-Since", email.utils.formatdate(CACHE.stat().st_mtime, usegmt=True))
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            tmp = CACHE.with_suffix(".part")
            with open(tmp, "wb") as f:
                while chunk := resp.read(1 << 20):
                    f.write(chunk)
            tmp.replace(CACHE)
            print(f"downloaded {CACHE.stat().st_size / 1e6:.0f} MB")
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


def build() -> dict:
    with zipfile.ZipFile(CACHE) as zf:
        feed = next(rows(zf, "feed_info.txt"))

        routes = {r["route_id"]: r for r in rows(zf, "routes.txt") if r["agency_id"] == AGENCY}

        trips = {}  # trip_id -> (route_id, headsign, direction_id, service_id)
        route_operator = {}  # route_id -> operator code
        for t in rows(zf, "trips.txt"):
            if t["route_id"] not in routes:
                continue
            op = t["realtime_trip_id"].split(":", 1)[0]
            if op not in OPERATORS:
                continue
            trips[t["trip_id"]] = (t["route_id"], t["trip_headsign"], t["direction_id"], t["service_id"])
            route_operator[t["route_id"]] = op
        used_routes = route_operator.keys()
        print(f"{len(used_routes)} routes, {len(trips)} trips")

        # stop_id -> {(route_id, direction_id): headsign}; only stops where you can board.
        serves: dict[str, dict] = defaultdict(dict)
        # (stop_id, route_id, direction_id) -> [(minutes after midnight of the service day, service_id)]
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
            serves[st["stop_id"]].setdefault((route_id, direction), st["stop_headsign"] or headsign)
            h, mi, _s = st["departure_time"].split(":")
            departures[(st["stop_id"], route_id, direction)].append((int(h) * 60 + int(mi), service))

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
                    "_serves": {},
                }
            elif not stop["tpc"] and s["stop_code"]:
                stop["tpc"] = s["stop_code"]
            for k, hs in serves[s["stop_id"]].items():
                stop["_serves"].setdefault(k, hs)

        def line_order(x):
            short = routes[x[0]]["route_short_name"]
            return (len(short), short, x[1])

        stop_names = {s["stop_id"]: split_name(s["stop_name"])[1] for s in rows(zf, "stops.txt")}

        # Loop lines can have the same destination in both directions at one stop. Find those
        # (per stop name, across its platforms) so they can be labelled "via <next stop>".
        dirs_per_dest: dict[tuple, set] = defaultdict(set)
        for stop in merged.values():
            for (rid, d), hs in stop["_serves"].items():
                dirs_per_dest[(stop["town"], stop["name"], rid, hs)].add(d)

        def via(stop, rid, d):
            ids = [sid for sid, key in stop_key.items() if key == (stop["quay"] or stop["id"])]
            counts = Counter()
            for sid in ids:
                counts.update(next_stop.get((sid, rid, d), {}))
            return stop_names.get(counts.most_common(1)[0][0], "") if counts else ""

        stops = []
        for stop in merged.values():
            # [route_id, headsign, direction_id] (+ via, only when needed); the direction links to
            # data/times.json
            lines = []
            for (rid, d), hs in stop.pop("_serves").items():
                entry = [rid, hs, d]
                if len(dirs_per_dest[(stop["town"], stop["name"], rid, hs)]) > 1:
                    entry.append(via(stop, rid, d))
                lines.append(entry)
            stop["lines"] = sorted(lines, key=line_order)
            stops.append(stop)
        stops.sort(key=lambda s: (s["town"], s["name"], s["platform"]))

        service_dates: dict[str, set] = defaultdict(set)
        for r in rows(zf, "calendar_dates.txt"):
            if r["exception_type"] == "1":
                service_dates[r["service_id"]].add(r["date"])

    times = build_times(departures, stop_key, service_dates)
    return {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
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


def build_times(departures: dict, stop_key: dict, service_dates: dict) -> dict:
    """Departure times per platform, line and direction, for every date in the feed.

    Identical days (all weekdays, all Saturdays ...) are stored once:
        { "dates": ["20261116", ...],
          "k": { "<quay>|<route_id>|<direction_id>": { "p": [[minutes, ...], ...], "d": [pattern per date] } } }
    Minutes count from midnight of the service day and can exceed 1440 (after-midnight trips).
    """
    dates = sorted(set().union(*service_dates.values())) if service_dates else []
    merged: dict[str, list] = defaultdict(list)
    for (stop_id, route_id, direction), deps in departures.items():
        if stop_id in stop_key:
            merged[f"{stop_key[stop_id]}|{route_id}|{direction}"].extend(deps)

    out = {}
    for key, deps in merged.items():
        by_day = {d: set() for d in dates}
        for minutes, service in deps:
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--offline", action="store_true", help="don't download, use the cached zip")
    args = ap.parse_args()

    if not args.offline:
        download()
    elif not CACHE.exists():
        print(f"no cached feed at {CACHE}", file=sys.stderr)
        return 1

    data, times = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(data['stops'])} stops, "
          f"{len(data['routes'])} routes, {OUT.stat().st_size / 1e3:.0f} kB")
    OUT_TIMES.write_text(json.dumps(times, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT_TIMES.relative_to(ROOT)}: {len(times['k'])} stop/line/direction keys, "
          f"{len(times['dates'])} dates, {OUT_TIMES.stat().st_size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
