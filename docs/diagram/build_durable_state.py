"""Draw what a Lambda durable execution stores, from a real (sanitized) history.

    python3 build_durable_state.py [--raw] [history.json]

Produces two diagrams in docs/:
  durable-operation-tree.drawio  operations as nested contexts (Id / ParentId)
  durable-timeline.drawio        operations and Lambda invocations over time

--raw draws every operation as recorded. The default view abstracts:
a WaitForCallback with its submitter step and callback becomes one
"agent turn", and bookkeeping steps (DynamoDB writes, cancel checks) are
drawn as small chips / ticks.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".claude/skills/drawio-diagram/scripts"))
from drawio_lib import Diagram, C  # noqa: E402

HERE = Path(__file__).resolve().parent
DOCS = HERE.parent

TURN_FILL, TURN_STROKE = "#E6F6F3", C.ML
STEP_FILL, STEP_STROKE = "#FFF4E8", C.COMPUTE
CTX_STROKE = C.NETWORK
MUTED = "#7D8998"


# ── model ───────────────────────────────────────────────────────────────────

@dataclass
class Op:
    id: str
    parent: str | None
    kind: str          # Step / Map / MapIteration / WaitForCallback / Callback
    name: str
    start: datetime
    order: int
    end: datetime | None = None
    status: str = "STARTED"
    summary: dict = field(default_factory=dict)
    children: list["Op"] = field(default_factory=list)


def ts(s: str) -> datetime:
    return datetime.fromisoformat(s)


def load(path: Path):
    events = json.loads(path.read_text())["Events"]
    ops: dict[str, Op] = {}
    invocations: list[tuple[datetime, datetime]] = []
    root_id = None
    for e in sorted(events, key=lambda e: e["EventId"]):
        kind, etype = e.get("SubType", ""), e["EventType"]
        if etype == "ExecutionStarted":
            root_id = e["Id"]
            ops[root_id] = Op(root_id, None, "Execution", e.get("Name", "execution"),
                              ts(e["EventTimestamp"]), e["EventId"])
        elif etype.endswith("Started"):
            ops[e["Id"]] = Op(e["Id"], e.get("ParentId") or root_id, kind, e.get("Name", ""),
                              ts(e["EventTimestamp"]), e["EventId"])
        elif etype == "InvocationCompleted":
            s = e["summary"]
            invocations.append((ts(s["start"]), ts(s["end"])))
        elif etype.endswith(("Succeeded", "Failed")) and e.get("Id") in ops:
            op = ops[e["Id"]]
            op.end, op.status = ts(e["EventTimestamp"]), etype.removeprefix(kind).removeprefix("Execution")
            op.status = "SUCCEEDED" if etype.endswith("Succeeded") else "FAILED"
            op.summary = e.get("summary") or {}
    for op in ops.values():
        if op.parent in ops and op.id != op.parent:
            ops[op.parent].children.append(op)
    for op in ops.values():
        op.children.sort(key=lambda c: c.order)
    return ops[root_id], invocations


def is_bookkeeping(op: Op) -> bool:
    """Orchestrator steps that only read/write state, as opposed to agent turns."""
    return op.kind == "Step" and op.name != ""


PURPOSE = [
    ("load", "read the workflow record"),
    ("mark-running", "header → running"),
    ("init-sessions", "assign a session id per step"),
    ("cancel-check-", "cancel requested?"),
    ("save-wave-", "save step states"),
    ("finalize", "header → result"),
    ("notify-", "resume the parent session"),
]
SUFFIX_PURPOSE = [("-start", "step → running"), ("-reviewing", "step → reviewing"),
                  ("-revising", "step → running (revision)")]


def purpose(op: Op) -> str:
    for prefix, text in PURPOSE:
        if op.name.startswith(prefix):
            return text
    for suffix, text in SUFFIX_PURPOSE:
        if suffix in op.name:
            return text
    return ""


def run_notes(root: "Op") -> dict[str, str]:
    """Why a run-2+ step or review round exists, keyed by the WaitForCallback name."""
    notes: dict[str, str] = {}
    turns = []
    stack = [root]
    while stack:
        op = stack.pop()
        stack.extend(op.children)
        if op.kind == "WaitForCallback":
            turns.append(op)
    turns.sort(key=lambda o: o.order)
    for t in turns:
        cb = next((c for c in t.children if c.kind == "Callback"), None)
        target = cb.summary.get("targetStepId") if cb else None
        status = cb.summary.get("status") if cb else None
        step = t.name.rsplit("-", 2)[0]
        if target:
            notes.setdefault(f"rerun:{target}", f"↺ re-run requested by {step} (blocked)")
            notes.setdefault(f"rerun-dependants:{step}", f"↺ re-run after {target} was redone")
        if status == "needs_revision":
            notes.setdefault(f"revise:{step}", f"↺ revision requested by the reviewer")
    return notes


def turn_label(op: Op) -> str:
    """'headline-r2-review1' → 'headline · run 2 · review 1'."""
    step, run, what = op.name.rsplit("-", 2)
    role = "review" if what.startswith("review") else "work"
    return f"{step} · run {run[1:]} · {role} {what.removeprefix(role)}"


def result_text(op: Op) -> str:
    s = op.summary
    if "status" in s:
        return s["status"] + (f" → {s['targetStepId']}" if s.get("targetStepId") else "")
    return ""


def turn_result(op: Op) -> str:
    cb = next((c for c in op.children if c.kind == "Callback"), None)
    return result_text(cb) if cb else ""


# ── diagram 1: operation tree ──────────────────────────────────────────────

def build_tree(root: Op, raw: bool, out: Path) -> None:
    d = Diagram(name="Operation tree", page_w=1700, page_h=1100)
    d.title("<b>Durable execution state</b> — the operation tree"
            + (" (raw)" if raw else ""))
    d.text("Each box is an operation in the checkpoint log. Nesting = ParentId. Id = hash of the parent's "
           "Id and the call's position, so the code must call operations in the same order on every replay.",
           20, 34, 1600, 20, size=11)

    COL_W, X0, Y0 = 260, 20, 110
    notes = {} if raw else run_notes(root)
    revised: set[str] = set()

    def note_for(op: Op) -> str:
        """Annotation above an agent turn that only exists because of an earlier result."""
        if op.kind != "WaitForCallback":
            return ""
        step, run, what = op.name.rsplit("-", 2)
        if what in ("work0",) and run != "r1":
            return notes.get(f"rerun:{step}") or next(
                (v for k, v in notes.items() if k.startswith("rerun-dependants:") and k.endswith(step)), ""
            ) or "↺ re-run after an upstream step was redone"
        if what.startswith("work") and what != "work0" and step not in revised:
            revised.add(step)
            return notes.get(f"revise:{step}", "")
        return ""
    LEAF_H = 30 if not raw else 40
    GAP = 8

    def leaf(op: Op, x, y, w):
        if raw:
            label = (f"<b>{op.name or '(' + op.kind.lower() + ')'}</b> <font color='{MUTED}'>{op.kind} · "
                     f"{op.id[:6]}</font><br><font color='{MUTED}'>{op.status.lower()}"
                     f"{' · ' + result_text(op) if result_text(op) else ''}"
                     f"{' · ' + str(op.summary['bytes']) + ' B' if 'bytes' in op.summary else ''}</font>")
            fill, stroke = (TURN_FILL, TURN_STROKE) if op.kind == "Callback" else (STEP_FILL, STEP_STROKE)
            d.box(label, x, y, w, LEAF_H, fill=fill, stroke=stroke, font=10, align="left")
            return LEAF_H
        if op.kind == "WaitForCallback":
            cb = next((c for c in op.children if c.kind == "Callback"), None)
            size = f" · {cb.summary['bytes']} B" if cb and "bytes" in cb.summary else ""
            label = (f"<b>agent turn</b> {turn_label(op)}<br>"
                     f"<font color='{MUTED}'>start → wait → checkpointed result:</font> "
                     f"<b>{turn_result(op)}</b><font color='{MUTED}'>{size}</font>")
            d.box(label, x, y, w, 50, fill=TURN_FILL, stroke=TURN_STROKE, font=10, align="left")
            return 50
        d.box(f"{op.name} <font color='{MUTED}'>— {purpose(op)}</font>", x, y, w, 22, fill="#FFFFFF",
              stroke=STEP_STROKE, font=9, align="left")
        return 22

    def place(op: Op, x, y, w) -> float:
        """Draw op at (x, y) with width w; return its height."""
        if not raw and op.kind == "Map" and len(op.children) == 1:
            # A one-item wave: the MapIteration frame adds nothing to the picture.
            op = Op(op.id, op.parent, "Map", f"{op.name}", op.start, op.order,
                    children=op.children[0].children)
        is_ctx = op.kind in ("Map", "MapIteration") or (raw and op.kind == "WaitForCallback")
        if not is_ctx:
            return leaf(op, x, y, w)
        title = {"Map": f"<b>{op.name}</b> <font color='{MUTED}'>Map · {op.id[:6]}</font>",
                 "MapIteration": f"<b>{op.name}</b> <font color='{MUTED}'>MapIteration</font>",
                 "WaitForCallback": f"<b>{op.name}</b> <font color='{MUTED}'>WaitForCallback</font>"}[op.kind]
        inner_y, pad = y + 30, 8
        for child in op.children:
            note = note_for(child)
            if note:
                d.text(f"<i>{note}</i>", x + pad, inner_y, w - 2 * pad, 16, size=9, color=C.SECURITY)
                inner_y += 18
            inner_y += place(child, x + pad, inner_y, w - 2 * pad) + GAP
        h = inner_y - y + pad - GAP
        frame = d.box(title, x, y, w, h, fill="none", stroke=CTX_STROKE, font=10, align="left", valign="top",
                      dashed=op.kind != "Map")
        # Frames must sit behind their children: move the frame cell to the front of the list.
        d.cells.insert(0, d.cells.pop().replace("arcSize=6", "arcSize=2"))
        del frame
        return h

    # Columns: prelude | one per wave (cancel-check, wave, save-wave) | finalize & notify.
    columns: list[list[Op]] = [[]]
    for op in root.children:
        if op.name.startswith("cancel-check-"):
            columns.append([op])
        elif op.name in ("finalize",) or op.name.startswith("notify-"):
            if not columns[-1] or not columns[-1][0].name.startswith("finalize"):
                columns.append([])
            columns[-1].append(op)
        else:
            columns[-1].append(op)
    headers = ["prelude"] + [f"wave {i}" for i in range(len(columns) - 2)] + ["end"]

    root_frame_h = 0
    for ci, col in enumerate(columns):
        x = X0 + 10 + ci * (COL_W + 16)
        d.text(f"<b>{headers[ci]}</b>", x, Y0 + 30, COL_W, 18, size=11, color=CTX_STROKE)
        y = Y0 + 52
        for op in col:
            y += place(op, x, y, COL_W) + GAP
        root_frame_h = max(root_frame_h, y - Y0)
    d.box(f"<b>execution</b> <font color='{MUTED}'>{root.name} · input payload, status, invocations</font>",
          X0, Y0, len(columns) * (COL_W + 16) + 4, root_frame_h + 8, fill="none", stroke=C.GENERAL,
          font=11, align="left", valign="top")
    d.cells.insert(0, d.cells.pop().replace("arcSize=6", "absoluteArcSize=1;arcSize=12"))

    legend_y = Y0 + root_frame_h + 30
    if raw:
        d.text(f"Orange = Step (result checkpointed) · Green = Callback (result sent by the Runtime) · "
               f"Purple frame = context (Map / MapIteration / WaitForCallback)", X0, legend_y, 1500, 20, size=11)
    else:
        d.text("Abstracted: a WaitForCallback with its submitter step and callback is one <b>agent turn</b>; "
               "white boxes are orchestrator bookkeeping steps (their results are checkpointed too). "
               "Red notes mark operations that exist only because an earlier result asked for them — "
               "the tree is decided at run time, unlike a Step Functions state machine.", X0, legend_y, 1600, 34,
               size=11)
    d.page_h = int(legend_y + 60)
    d.write(out)


# ── diagram 2: timeline ────────────────────────────────────────────────────

def build_timeline(root: Op, invocations, raw: bool, out: Path) -> None:
    t0 = root.start
    t_end = max(e for _, e in invocations)
    span = (t_end - t0).total_seconds()
    X0, X1, LABEL_W = 260, 1640, 230
    px = (X1 - X0) / span

    def x_at(t: datetime) -> float:
        return X0 + (t - t0).total_seconds() * px

    def walk(op: Op):
        for c in op.children:
            yield c
            yield from walk(c)

    ops = list(walk(root))
    turns = [o for o in ops if o.kind == "WaitForCallback"]
    d = Diagram(name="Timeline", page_w=1700, page_h=900)
    d.title("<b>Durable execution over time</b> — operations vs. Lambda invocations" + (" (raw)" if raw else ""))

    ROW_H, y = (18 if raw else 34), 80
    # time axis
    for s in range(0, int(span) + 1, 5):
        d.text(f"{s} s", x_at(t0) + s * px - 15, y, 40, 16, size=9, color=MUTED, align="center")
    y += 24

    def bar(label, start, end, fill, stroke, row_y, h, text=""):
        x = x_at(start)
        w = max(3, x_at(end) - x) if end else 3
        d.box(text, x, row_y, w, h, fill=fill, stroke=stroke, font=9)

    if raw:
        for op in ops:
            name = op.name or f"({op.kind.lower()})"
            indent = 0
            p = op
            while p.parent and p.parent != root.id:
                indent += 1
                p = next(o for o in ops if o.id == p.parent)
            d.text(("&nbsp;" * 3 * indent) + name, 20, y, LABEL_W, ROW_H, size=9, color="#232F3E")
            fill = TURN_FILL if op.kind in ("Callback", "WaitForCallback") else STEP_FILL
            stroke = TURN_STROKE if op.kind in ("Callback", "WaitForCallback") else (
                CTX_STROKE if op.kind in ("Map", "MapIteration") else STEP_STROKE)
            bar(name, op.start, op.end, fill, stroke, y + 3, ROW_H - 6)
            y += ROW_H
    else:
        for op in turns:
            d.text(f"<b>{turn_label(op)}</b>", 20, y + 8, LABEL_W, 20, size=10, color="#232F3E")
            submit = next(c for c in op.children if c.kind == "Step")
            # Waiting for the Runtime turn (no Lambda running) …
            bar("", submit.end, op.end, TURN_FILL, TURN_STROKE, y + 6, ROW_H - 12)
            # … after the submitter started the turn inside an invocation.
            bar("", submit.start, submit.end, STEP_FILL, STEP_STROKE, y + 6, ROW_H - 12)
            d.text(turn_result(op), x_at(op.end) + 6, y + 8, 160, 20, size=10, color=C.ML)
            y += ROW_H
        d.text("<b>bookkeeping steps</b><br><font color='#7D8998'>DynamoDB writes, cancel checks</font>",
               20, y + 2, LABEL_W, 30, size=10)
        for op in ops:
            if is_bookkeeping(op):
                bar("", op.start, op.end, "#FFFFFF", STEP_STROKE, y + 8, ROW_H - 16)
        y += ROW_H

    y += 10
    d.text("<b>Lambda invocations</b>", 20, y + 8, LABEL_W, 20, size=10, color=C.COMPUTE)
    for i, (s, e) in enumerate(invocations, 1):
        dur = (e - s).total_seconds()
        bar("", s, e, C.COMPUTE, C.COMPUTE, y + 4, 26)
        d.text(f"#{i} {dur:.1f} s", x_at(s), y + 32, 70, 14, size=9, color=C.COMPUTE)
        if not raw:
            # Operations finished before this invocation are replayed from checkpoints.
            replayed = sum(1 for o in ops if o.end and o.end < s)
            new = sum(1 for o in ops if s <= o.start <= e)
            d.text(f"{replayed} replayed<br>{new} new", x_at(s), y + 46, 80, 28, size=9, color=MUTED)
    y += 84 if not raw else 60
    if not raw:
        d.text("<b>Orange</b> = code running in a Lambda invocation (replay + new operations + starting the turn). "
               "<b>Green</b> = the agent turn running on AgentCore Runtime while the execution is suspended. "
               "Every invocation replays from the top, returns checkpointed results instantly and ends at the "
               "next callback it has to wait for.", 20, y, 1600, 34, size=11)
        y += 40
    d.page_h = int(y + 20)
    d.write(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("history", nargs="?", default=str(HERE / "data/durable-history-sample.json"))
    ap.add_argument("--raw", action="store_true")
    args = ap.parse_args()
    root, invocations = load(Path(args.history))
    suffix = "-raw" if args.raw else ""
    build_tree(root, args.raw, DOCS / f"durable-operation-tree{suffix}.drawio")
    build_timeline(root, invocations, args.raw, DOCS / f"durable-timeline{suffix}.drawio")


if __name__ == "__main__":
    main()
