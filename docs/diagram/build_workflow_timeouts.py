"""Why the 15-minute Lambda timeout does not bound a workflow (docs/workflow-timeouts.drawio)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".claude/skills/drawio-diagram/scripts"))
from drawio_lib import Diagram, C  # noqa: E402

LANE_X, LANE_W = 20, 200
T0, T1 = 250, 1650                       # timeline x range
DUR_Y, STEPA_Y, LAMBDA_Y, STEPB_Y = 110, 230, 360, 500
BAR_H, INV_H = 44, 64
LAMBDA_FILL, STEP_FILL = "#FFF4E8", "#E6F6F3"

d = Diagram(name="Timeouts", page_w=1700, page_h=1120)
d.title("<b>run_workflow</b> — why Lambda's 15-minute limit does not bound a workflow")

def lane(label, y, h):
    d.text(label, LANE_X, y + 4, LANE_W, h, size=11, color="#232F3E")

# ── lanes ──────────────────────────────────────────────────────────────────
lane("<b>Durable execution</b><br>executionTimeout = 7 days", DUR_Y, BAR_H)
lane("<b>Step turns (row A)</b><br>AgentCore Runtime<br>≤ 8 h each", STEPA_Y, BAR_H + 20)
lane("<b>Lambda invocations</b><br>timeout 5 min (max 15)<br>each lasts seconds", LAMBDA_Y, INV_H)
lane("<b>Step turns (row B)</b><br>AgentCore Runtime", STEPB_Y, BAR_H)

durable = d.box("Execution wf-… — state lives in durable checkpoints, not in a running Lambda",
                T0, DUR_Y, T1 - T0, BAR_H, fill="#F7F2FF", stroke=C.NETWORK)

# Step turns (long, on the Runtime)
step_a = d.box("<b>a</b> (worker) — e.g. 2 h", 300, STEPA_Y, 420, BAR_H, fill=STEP_FILL, stroke=C.ML)
step_r = d.box("<b>report</b> (worker) — e.g. 3 h", 960, STEPA_Y, 520, BAR_H, fill=STEP_FILL, stroke=C.ML)
step_b = d.box("<b>b</b> (worker) — e.g. 3 h", 330, STEPB_Y, 590, BAR_H, fill=STEP_FILL, stroke=C.ML)

# Lambda invocations (short)
inv1 = d.box("<b>#1</b><br>start a, b", 270, LAMBDA_Y, 90, INV_H, fill=LAMBDA_FILL, stroke=C.COMPUTE)
inv2 = d.box("<b>#2</b><br>replay<br>b pending", 690, LAMBDA_Y, 90, INV_H, fill=LAMBDA_FILL, stroke=C.COMPUTE)
inv3 = d.box("<b>#3</b><br>replay<br>start report", 900, LAMBDA_Y, 100, INV_H, fill=LAMBDA_FILL, stroke=C.COMPUTE)
inv4 = d.box("<b>#4</b><br>replay<br>finalize, notify", 1450, LAMBDA_Y, 110, INV_H, fill=LAMBDA_FILL, stroke=C.COMPUTE)

for x, w in ((372, 306), (1012, 426)):
    d.text("<i>suspended — no Lambda running, no compute charge</i>", x, LAMBDA_Y + 22, w, 20,
           size=10, color="#7D8998", align="center")

# Invocation → step turns (start)
d.edge(inv1, step_a, "InvokeAgentRuntime", color=C.ML, out="T", into="B",
       at=d.frac_x(inv1, 315), into_at=d.frac_x(step_a, 315), label_offset=(-60, 0))
d.edge(inv1, step_b, "InvokeAgentRuntime", color=C.ML, out="B", into="T",
       at=d.frac_x(inv1, 345), into_at=d.frac_x(step_b, 345), label_offset=(-60, 0))
d.edge(inv3, step_r, "", color=C.ML, out="T", into="B",
       at=d.frac_x(inv3, 975), into_at=d.frac_x(step_r, 975))

# Step turns → callbacks re-invoke the function
d.edge(step_a, inv2, "callback", color=C.COMPUTE, dashed=True, out="B", into="T",
       at=d.frac_x(step_a, 705), into_at=d.frac_x(inv2, 705), label_offset=(-32, 0))
d.edge(step_b, inv3, "callback", color=C.COMPUTE, dashed=True, out="T", into="B",
       at=d.frac_x(step_b, 910), into_at=d.frac_x(inv3, 910), label_offset=(-32, 0))
d.edge(step_r, inv4, "callback", color=C.COMPUTE, dashed=True, out="B", into="T",
       at=d.frac_x(step_r, 1465), into_at=d.frac_x(inv4, 1465), label_offset=(-32, 0))

# Heartbeats go to the durable service and never start an invocation
d.edge(step_a, durable, "heartbeat / 5 min", color=C.NETWORK, dashed=True, out="T", into="B",
       at=d.frac_x(step_a, 520), into_at=d.frac_x(durable, 520), label_offset=(0, 0))
d.edge(step_r, durable, "heartbeat / 5 min", color=C.NETWORK, dashed=True, out="T", into="B",
       at=d.frac_x(step_r, 1220), into_at=d.frac_x(durable, 1220), label_offset=(0, 0))

d.text("Time →", T1 - 60, STEPB_Y + BAR_H + 14, 60, 18, size=11, color="#545B64", align="right")

# ── inside one invocation ────────────────────────────────────────────────────
PY = 640
d.box("", T0, PY, T1 - T0, 300, fill="#FFFFFF", stroke=C.COMPUTE, dashed=True)
d.text("<b>Inside one invocation</b> (e.g. #3): what can take time, worst case", T0 + 16, PY + 10, 700, 20,
       size=12, color="#232F3E")
BY, BH, BW = PY + 60, 110, 270
s1 = d.box("<b>1. Replay</b><br>handler restarts from the top;<br>completed operations return<br>"
           "checkpointed results<br><i>milliseconds</i>", 280, BY, BW, BH, fill=LAMBDA_FILL, stroke=C.COMPUTE)
s2 = d.box("<b>2. New operations</b><br>save step state (DynamoDB),<br>mint tokens (Cognito)<br><br>"
           "<i>~1 s</i>", 620, BY, BW, BH, fill=LAMBDA_FILL, stroke=C.COMPUTE)
s3 = d.box("<b>3. Start step turns</b><br>POST /invocations:<br>headers ≤ 120 s + first line ≤ 20 s<br>"
           "parallel steps wait concurrently<br><i>≤ ~140 s</i>", 960, BY, BW, BH, fill=LAMBDA_FILL,
           stroke=C.COMPUTE)
s4 = d.box("<b>4. Suspend</b><br>waitForCallback has no result:<br>return PENDING,<br>invocation ends<br>"
           "<i>~0 s</i>", 1300, BY, BW, BH, fill=LAMBDA_FILL, stroke=C.COMPUTE)
for a, b in ((s1, s2), (s2, s3), (s3, s4)):
    d.edge(a, b, "", color=C.COMPUTE)

d.box("<b>Worst case ≈ 140 s per invocation</b> &lt; Lambda timeout 300 s &lt; Lambda maximum 900 s (15 min).&nbsp; "
      "The hours are spent in step turns on AgentCore Runtime (≤ 8 h each) and in suspension (≤ 7 days in total), "
      "neither of which is a running Lambda.",
      280, PY + 200, 1290, 70, fill="#F2FAF8", stroke=C.ML, align="left")

d.write(Path(__file__).resolve().parents[1] / "workflow-timeouts.drawio")
