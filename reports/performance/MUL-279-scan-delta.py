"""Compare two MUL-279-scan-snapshot.sql outputs; no database connection."""
import argparse
import datetime
import json
import sys


COUNTERS = ("seq_scan", "seq_tup_read", "idx_scan", "idx_tup_fetch")


def compare(before, after):
    if before["track_counts"] != "on" or after["track_counts"] != "on":
        raise ValueError("track_counts must already be on; do not change stable configuration")
    for key in ("database", "database_oid", "stats_reset", "postmaster_start", "server_version"):
        if before[key] != after[key]:
            raise ValueError(f"{key} changed; use a new measurement window")
    start = datetime.datetime.fromisoformat(before["captured_at"].replace("Z", "+00:00"))
    end = datetime.datetime.fromisoformat(after["captured_at"].replace("Z", "+00:00"))
    seconds = (end - start).total_seconds()
    if seconds <= 0:
        raise ValueError("samples must be in increasing timestamp order")
    old = {(t["schema"], t["name"]): t for t in before["tables"] or []}
    new = {(t["schema"], t["name"]): t for t in after["tables"] or []}
    if not old or old.keys() != new.keys():
        raise ValueError("empty or changed table set; use a new measurement window")
    rows = []
    for key in sorted(old):
        a, b = old[key], new[key]
        if a["oid"] != b["oid"]:
            raise ValueError(f"{key} was replaced; use a new measurement window")
        delta = {}
        for field in COUNTERS:
            delta[field] = b[field] - a[field]
            if delta[field] < 0:
                raise ValueError(f"{key}.{field} decreased; counters may have been reset")
        rows.append({
            "schema": key[0], "table": key[1], "delta": delta,
            "seq_scans_per_minute": delta["seq_scan"] * 60 / seconds,
            "seq_tuples_per_minute": delta["seq_tup_read"] * 60 / seconds,
            "seq_tuples_per_scan": delta["seq_tup_read"] / delta["seq_scan"] if delta["seq_scan"] else None,
            "estimated_live_tuples_at_end": b["n_live_tup"],
        })
    return {"from": before["captured_at"], "to": after["captured_at"], "seconds": seconds,
            "database": before["database"], "tables": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before")
    parser.add_argument("after")
    args = parser.parse_args()
    try:
        with open(args.before) as f:
            before = json.load(f)
        with open(args.after) as f:
            after = json.load(f)
        print(json.dumps(compare(before, after), indent=2))
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(f"Cannot compare: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
