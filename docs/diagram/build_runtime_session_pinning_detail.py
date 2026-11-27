"""How one /invocations request is handled under V2 session pinning
(docs/runtime-session-pinning-detail.drawio)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".claude/skills/drawio-diagram/scripts"))
from drawio_lib import Diagram, C  # noqa: E402

ROWS = [180, 280, 380, 480, 580, 680, 780]   # ①..⑦ centre y
STEP_X, STEP_W, STEP_H = 820, 360, 64
ROUTER_X, ROUTER_W = 340, 170
STORE_X, STORE_W = 560, 120
DDB_X, DDB_W = 1340, 280
CALLER_CX = 190
Y_TRIG, Y_WF = 480, 640
Y_BUS = 910                                  # stream handler → AppSync
APPSYNC_CX = 56

d = Diagram(name="Runtime session pinning (detail)", page_w=1660, page_h=1020)
d.title("<b>Runtime session pinning</b> — how a request is routed, locked and stopped")

# ---------------------------------------------------------------- callers
browser = d.box("<b>Browser</b> (runtime-session.ts)<br>always &lt;id&gt;u<br>"
                "no token renewal on machine turns",
                20, ROWS[0] - 60, 240, 120, fill="#EEF6FC", stroke=C.BLUE)
trig = d.icon("Trigger Lambda", CALLER_CX - 24, Y_TRIG - 24, "lambda", C.COMPUTE, label_at="top")
orch = d.icon("Workflow Orchestrator", CALLER_CX - 24, Y_WF - 24, "lambda", C.COMPUTE, label_at="top")

router = d.box("<b>AgentCore Runtime (V2)</b><br><br>one microVM per<br>runtime session id<br><br>"
               "pinned to the first<br>caller's sub<br><br>another identity:<br>403 AccessDenied<br>"
               "(never reaches<br>the container)",
               ROUTER_X, ROWS[0] - 50, ROUTER_W, ROWS[-1] - ROWS[0] + 100, fill="#F2FAF8", stroke=C.ML)

# ------------------------------------------------------------- microVM steps
d.box("<b>microVM</b> (agent container)", STEP_X - 30, ROWS[0] - 70, STEP_W + 60,
      ROWS[-1] - ROWS[0] + 130, fill="none", stroke=C.ML, dashed=True, align="left", valign="top")
labels = [
    "① request-context: header → conversation id + kind<br>kind ≠ caller → 403",
    "② turn-registry: one turn per process",
    "③ TurnLock.acquire (conditional update)<br>held → serverTurnInProgressEvent",
    "④ createAgent + stream the turn<br>lease renewed every 60 s",
    "⑤ final S3 workspace sync",
    "⑥ TurnLock.release (owner only)",
    "⑦ machine caller only:<br>POST /stopruntimesession",
]
steps = [d.box(t, STEP_X, y - STEP_H / 2, STEP_W, STEP_H,
               fill="#FFF4E8" if i == 6 else "#FFFFFF", stroke=C.COMPUTE if i == 6 else C.ML)
         for i, (t, y) in enumerate(zip(labels, ROWS))]
for a, b in zip(steps, steps[1:]):
    d.edge(a, b, color=C.ML, out="B", into="T")

# ------------------------------------------------------------------ stores
memory = d.box("<b>AgentCore<br>Memory</b><br>session = &lt;id&gt;",
               STORE_X, ROWS[3] - 34, STORE_W, 68, fill="#FFFFFF", stroke=C.ML)
s3 = d.box("<b>S3 workspace</b><br>per-user prefix", STORE_X, ROWS[4] - 28, STORE_W, 56,
           fill="#FFFFFF", stroke=C.STORAGE)
ddb = d.box("<b>moca-sessions</b> (DynamoDB)<br>key: identityId + &lt;id&gt;<br><br>"
            "activeTurnOwner<br>activeTurnRunner<br>activeTurnLeaseUntil<br>activeTurnStartedAt",
            DDB_X, ROWS[2] - 40, DDB_W, ROWS[5] - ROWS[2] + 80, fill="#FBF0FC", stroke=C.DATABASE,
            align="left", valign="top")
handler = d.icon("session-stream-handler", DDB_X + DDB_W / 2 - 24, Y_BUS - 24, "lambda", C.COMPUTE,
                 label_at="right")
appsync = d.icon("AppSync Events", APPSYNC_CX - 24, Y_BUS - 24, "appsync", C.MGMT, label_at="bottom")

# ------------------------------------------------------------------- edges
d.edge(browser, router, "&lt;id&gt;u", color=C.BLUE, into_at=d.frac_y(router, ROWS[0]),
       label_offset=(0, -12))
d.edge(trig, router, "&lt;id&gt;m", color=C.COMPUTE, into_at=d.frac_y(router, Y_TRIG), label_offset=(0, -12))
d.edge(orch, router, "&lt;id&gt;m", color=C.COMPUTE, into_at=d.frac_y(router, Y_WF), label_offset=(0, -12))
d.edge(router, steps[0], color=C.ML, at=d.frac_y(router, ROWS[0]))

d.edge(steps[3], memory, "history", color=C.ML, dashed=True, out="L", into="R", label_pos=0.45,
       label_offset=(0, -12))
d.edge(steps[4], s3, "sync", color=C.STORAGE, dashed=True, out="L", into="R", label_pos=0.45,
       label_offset=(0, -12))
for i, text in ((2, "acquire"), (3, "renew lease"), (5, "release")):
    d.edge(steps[i], ddb, text, color=C.DATABASE, dashed=True, into_at=d.frac_y(ddb, ROWS[i]),
           label_pos=0.3, label_offset=(0, -12))

d.edge(ddb, handler, "Streams", color=C.DATABASE, out="B", into="T", label_offset=(36, 0))
d.edge(handler, appsync, "MODIFY events: running / runner (lease-only updates dropped)",
       color=C.MGMT, out="L", into="R", label_offset=(0, -12))
d.edge(appsync, browser, color=C.MGMT, out="T", into="B", into_at=d.frac_x(browser, APPSYNC_CX))

d.write(Path(__file__).resolve().parents[1] / "runtime-session-pinning-detail.drawio")
