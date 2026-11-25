#!/usr/bin/env python3
"""Extract the configured direct rail timetable from a pinned GTFS ZIP."""
import argparse
import csv
from collections import defaultdict
from datetime import date, timedelta
from hashlib import file_digest
from io import TextIOWrapper
import json
from pathlib import Path
import re
from zipfile import ZipFile

STATIONS = json.loads((Path(__file__).resolve().parents[1] / "config/stations.json").read_text())
WEEK = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def parse_date(value):
    return date(int(value[:4]), int(value[4:6]), int(value[6:]))


def minutes(value):
    hour, minute, _ = map(int, value.split(":"))
    return hour * 60 + minute


def extract(archive, first_requested, last_requested):
    def rows(name):
        with archive.open(f"{name}.txt") as file:
            yield from csv.DictReader(TextIOWrapper(file, "utf-8-sig", newline=""))

    configured_parents = {spec["gtfsParentId"]: code for code, spec in STATIONS.items()}
    parents = {row["stop_id"]: configured_parents[row["stop_id"]]
               for row in rows("stops") if row["location_type"] == "1"
               and row["stop_id"] in configured_parents
               and row["stop_name"] == STATIONS[configured_parents[row["stop_id"]]]["name"]}
    missing = STATIONS.keys() - set(parents.values())
    if missing:
        raise ValueError(f"GTFS is missing configured parent IDs: {sorted(missing)}")
    stop_rows = (row for row in rows("stops") if row["parent_station"] in parents)
    stops = {row["stop_id"]: row for row in stop_rows
             if re.fullmatch(re.escape(STATIONS[parents[row["parent_station"]]]["name"])
                             + r"(?: Gl\.\d+(?:-\d+)?)?", row["stop_name"])}
    routes = {row["route_id"]: row["route_short_name"] or row["route_long_name"] or "Train"
              for row in rows("routes") if row["route_type"] in {"2", "100", "101", "102", "103", "105", "106", "109"}}
    calendar = {row["service_id"]: row for row in rows("calendar")}
    exceptions = defaultdict(dict)
    for row in rows("calendar_dates"):
        exceptions[row["service_id"]][parse_date(row["date"])] = row["exception_type"] == "1"

    # Most of the national feed is irrelevant. The stop ID is column four,
    # before any text field that can contain a quoted comma.
    by_trip = defaultdict(list)
    keep = {key.encode() for key in stops}
    with archive.open("stop_times.txt") as file:
        fields = next(file).decode().strip().split(",")
        assert fields[:5] == ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"]
        for line in file:
            if line.split(b",", 5)[3] in keep:
                row = dict(zip(fields, next(csv.reader([line.decode("utf-8")]))))
                by_trip[row["trip_id"]].append(row)

    first = max(parse_date(min(row["start_date"] for row in calendar.values())), first_requested)
    last = min(max(parse_date(row["end_date"]) for row in calendar.values()), last_requested)
    assert first <= last
    days = [first + timedelta(days=offset) for offset in range((last - first).days + 1)]
    previous = first - timedelta(days=1)
    active = {}
    for service in set(calendar) | set(exceptions):
        row = calendar.get(service)
        overrides = exceptions.get(service, {})
        active[service] = [day for day in [previous, *days]
                           if overrides.get(day, bool(row and
                                                      row["start_date"] <= day.strftime("%Y%m%d") <= row["end_date"]
                                                      and row[WEEK[day.weekday()]] == "1"))]

    def endpoint(row, time):
        stop = stops[row["stop_id"]]
        area = re.search(r"Gl\.(\d+-\d+)", stop["stop_name"])
        return {"station": parents[stop["parent_station"]], "stop": stop["stop_id"],
                "time": minutes(row[time]), "rawTime": row[time], "track": stop["platform_code"] or None,
                "name": stop["stop_name"], "area": area.group(1) if area else None, "sequence": int(row["stop_sequence"])}

    index = {day.isoformat(): defaultdict(list) for day in days}
    for trip in rows("trips"):
        trip_id, route, service = trip["trip_id"], trip["route_id"], trip["service_id"]
        if route not in routes or len(by_trip.get(trip_id, ())) < 2 or not active.get(service):
            continue
        events = sorted(by_trip[trip_id], key=lambda row: int(row["stop_sequence"]))
        for position, start in enumerate(events):
            if start["pickup_type"] not in {"", "0"} or not start["departure_time"]:
                continue
            departure = endpoint(start, "departure_time")
            for end in events[position + 1:]:
                if end["drop_off_type"] not in {"", "0"} or not end["arrival_time"]:
                    continue
                arrival = endpoint(end, "arrival_time")
                if departure["station"] == arrival["station"] or arrival["time"] <= departure["time"]:
                    continue
                key = f'{departure["station"]}-{arrival["station"]}'
                for service_day in active[service]:
                    departure_offset = departure["time"] // 1440
                    day = (service_day + timedelta(days=departure_offset)).isoformat()
                    if day not in index:
                        continue
                    offset = departure_offset * 1440
                    index[day][key].append({
                        "line": routes[route], "trip": trip_id, "service": service, "serviceDate": service_day.isoformat(),
                        "calendar": "calendar_dates.txt" if service_day in exceptions.get(service, {}) else "calendar.txt",
                        "from": {**departure, "time": departure["time"] - offset},
                        "to": {**arrival, "time": arrival["time"] - offset},
                    })

    for pairs in index.values():
        for key, trips in pairs.items():
            trips.sort(key=lambda trip: (trip["from"]["time"], trip["to"]["time"], trip["trip"]))
            unique = {}
            for trip in trips:
                start, end = trip["from"], trip["to"]
                unique.setdefault((trip["line"], start["stop"], start["time"], end["stop"], end["time"]), trip)
            pairs[key] = list(unique.values())

    return {"first": first.isoformat(), "last": last.isoformat(), "dates": index}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--first", type=date.fromisoformat, required=True)
    parser.add_argument("--last", type=date.fromisoformat, required=True)
    parser.add_argument("--snapshot", type=date.fromisoformat, required=True)
    args = parser.parse_args()
    with args.zip.open("rb") as raw:
        sha256 = file_digest(raw, "sha256").hexdigest()
    with ZipFile(args.zip) as archive:
        data = extract(archive, args.first, args.last)
    data.update(snapshot=args.snapshot.isoformat(), sha256=sha256)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(data["first"], data["last"], sum(len(rows) for pairs in data["dates"].values() for rows in pairs.values()))
