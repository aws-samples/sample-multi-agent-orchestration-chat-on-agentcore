"""Sanitize a `aws lambda get-durable-execution-history --include-execution-data` dump.

Keeps the structure (ids, parents, types, names, timestamps, invocation windows)
and replaces payloads with a summary (step-result status / size), so no user
content ends up in the repository.

    python3 extract_durable_history.py raw.json data/durable-history-sample.json
"""
import json
import sys
from pathlib import Path


def summarize(event: dict) -> dict | None:
    for key, details in event.items():
        if not key.endswith("Details") or not isinstance(details, dict):
            continue
        payload = (details.get("Result") or {}).get("Payload")
        out = {}
        if "RetryDetails" in details:
            out["attempt"] = details["RetryDetails"].get("CurrentAttempt")
        if "Error" in details:
            err = details["Error"].get("Payload") or details["Error"]
            out["error"] = (err.get("ErrorType") if isinstance(err, dict) else None) or "error"
        if payload is not None:
            out["bytes"] = len(payload.encode())
            try:
                value = json.loads(payload)
            except ValueError:
                value = None
            if isinstance(value, dict) and "status" in value:
                out["status"] = value["status"]
                if value.get("targetStepId"):
                    out["targetStepId"] = value["targetStepId"]
        if key == "InvocationCompletedDetails":
            out["start"], out["end"] = details["StartTimestamp"], details["EndTimestamp"]
        return out or None
    return None


def main(src: str, dst: str) -> None:
    events = json.loads(Path(src).read_text())["Events"]
    keep = ("EventId", "EventType", "SubType", "Name", "Id", "ParentId", "EventTimestamp")
    out = []
    for e in events:
        item = {k: e[k] for k in keep if k in e}
        summary = summarize(e)
        if summary:
            item["summary"] = summary
        out.append(item)
    if out and out[0].get("EventType") == "ExecutionStarted":
        out[0]["Name"] = "wf-example"
    Path(dst).write_text(json.dumps({"Events": out}, ensure_ascii=False, indent=1) + "\n")
    print(f"wrote {dst} ({len(out)} events)")


if __name__ == "__main__":
    main(*sys.argv[1:3])
