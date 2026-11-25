#!/usr/bin/env python3
"""Extract access records for the configured DB InfraGO stations from OpenStation NeTEx."""
import argparse
from hashlib import file_digest
import json
from pathlib import Path
import re
from xml.etree.ElementTree import iterparse

NS = {"n": "http://www.netex.org.uk/netex"}
CATALOG = json.loads((Path(__file__).resolve().parents[1] / "config/stations.json").read_text())
STATIONS = {spec["openstationId"]: (code, spec) for code, spec in CATALOG.items()}


def fact(element, name):
    limitation = element.find("n:AccessibilityAssessment/n:limitations/n:AccessibilityLimitation", NS)
    return limitation.findtext(f"n:{name}", None, NS) if limitation is not None else None


def access(element):
    return {"step": fact(element, "StepFreeAccess"),
            "wheelchair": fact(element, "WheelchairAccess"),
            "tactile": fact(element, "TactileGuidanceAvailable")}


def station(element, station_id):
    code, spec = STATIONS[station_id]
    slug = spec["dbSlug"]
    tracks = []
    for quay in element.findall("n:quays/n:Quay", NS):
        title = quay.findtext("n:Name", "", NS)
        match = re.fullmatch(r"Bahnsteig Gleis (\d+(?:/\d+)*)", title)
        if match:
            tracks.append({"id": quay.attrib["id"], "name": title,
                           "numbers": [int(value) for value in match[1].split("/")],
                           "height": quay.findtext("n:PlatformHeight", None, NS), **access(quay)})
    tracks.sort(key=lambda row: row["numbers"])
    lift_ids = [item.attrib["id"] for item in element.findall("n:placeEquipments/n:LiftEquipment", NS)]
    boarding = element.findall("n:placeEquipments/n:AccessVehicleEquipment", NS)
    boarding = [{"id": item.attrib["id"], "kind": item.findtext("n:Name", "", NS),
                 "suitable": item.findtext("n:SuitableFor", "", NS)}
                for item in boarding if "wheelchair" in item.findtext("n:SuitableFor", "", NS).split()]
    return code, {
        "name": spec["name"], "id": station_id, "access": access(element),
        "stationId": element.findtext("n:PrivateCode", None, NS), "tracks": tracks, "lifts": lift_ids, "boardingAids": boarding,
        "url": f"https://www.bahnhof.de/{slug}/ausstattung-barrierefreiheit",
    }


def extract(path):
    data = {"stations": {}}
    stack = []
    for event, element in iterparse(path, events=("start", "end")):
        if event == "start":
            stack.append(element)
            continue
        name = element.tag.split("}")[-1]
        if name == "PublicationTimestamp" and "timestamp" not in data:
            data["timestamp"] = element.text
        if name == "StopPlace":
            station_id = element.attrib.get("id")
            if station_id in STATIONS:
                code, record = station(element, station_id)
                data["stations"][code] = record
            element.clear()
            stack[-2].remove(element)
            if len(data["stations"]) == len(STATIONS):
                break
        stack.pop()
    missing = CATALOG.keys() - data["stations"].keys()
    if missing:
        raise ValueError(f"OpenStation is missing configured stations: {sorted(missing)}")
    return data


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xml", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = extract(args.xml)
    with args.xml.open("rb") as raw:
        data["sha256"] = file_digest(raw, "sha256").hexdigest()
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    for record in data["stations"].values():
        print(record["name"], record["id"], record["access"], len(record["lifts"]), len(record["boardingAids"]),
              [(track["numbers"], track["step"], track["tactile"]) for track in record["tracks"]])
