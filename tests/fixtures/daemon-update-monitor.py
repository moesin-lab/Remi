"""Read-only host /proc sampler; record only this rehearsal's processes, never env values."""
import json
import pathlib
import sys
import time

root = pathlib.Path(sys.argv[1])
marker = ("MULTIREMI_STATE_DIR=" + str(root / "state")).encode() + bytes([0])
known = {}
with (root / "process-observations.jsonl").open("a", buffering=1) as output:
    def record(value):
        output.write(json.dumps({"at_ms": time.time_ns() // 1_000_000, **value}) + "\n")

    while True:
        current = {}
        for process in pathlib.Path("/proc").glob("[0-9]*"):
            try:
                if marker not in (process / "environ").read_bytes():
                    continue
                stat = (process / "stat").read_text().rpartition(") ")[2].split()
                current[process.name] = {"pid": int(process.name), "state": stat[0],
                                         "ppid": int(stat[1]), "exit_status": int(stat[49])}
            except (PermissionError, FileNotFoundError, ProcessLookupError):
                continue
        for pid, value in current.items():
            if known.get(pid) != value:
                record({"event": "sample", **value})
        for pid in known.keys() - current.keys():
            # Disappearance alone cannot establish the terminating signal.
            record({"event": "disappeared", "pid": int(pid)})
        known = current
        time.sleep(0.02)
