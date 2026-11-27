"""V2 runtime session pinning: runtime session id != conversation id (docs/runtime-session-pinning.drawio)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".claude/skills/drawio-diagram/scripts"))
from drawio_lib import Diagram, C  # noqa: E402

ROW_USER, ROW_TRIG, ROW_WF = 190, 420, 540   # caller rows (centre y)
CALLER_X = 96                                # caller icons (centre x)
VM_X, VM_W = 440, 330                        # microVM boxes
DDB_X = 1060
STOP_CX = VM_X + VM_W / 2

d = Diagram(name="Runtime session pinning", page_w=1420, page_h=1000)
d.title("<b>Runtime session pinning</b> — one conversation, two runtime sessions (AgentCore Runtime V2)")

# 呼び出し元
user = d.shape("User (browser)", CALLER_X - 24, ROW_USER - 24, "client", C.GENERAL, label_at="top")
trig = d.icon("Trigger Lambda", CALLER_X - 24, ROW_TRIG - 24, "lambda", C.COMPUTE, label_at="top")
orch = d.icon("Workflow Orchestrator<br>(steps, completion notice)", CALLER_X - 24, ROW_WF - 24,
              "lambda", C.COMPUTE, label_at="bottom")

# Runtime
d.box("<b>AgentCore Runtime (V2)</b>", 330, 90, 520, 620, fill="none", stroke=C.ML, dashed=True,
      align="left", valign="top")
vm_user = d.box("<b>microVM</b> — runtime session <b>&lt;id&gt;u</b><br>pinned to the user's sub<br>"
                "kept warm for the next turn", VM_X, ROW_USER - 45, VM_W, 90, fill="#FFFFFF", stroke=C.ML)
vm_mach = d.box("<b>microVM</b> — runtime session <b>&lt;id&gt;m</b><br>pinned to the machine user<br>"
                "stops itself after every turn<br>(also when rejected or failed)",
                VM_X, ROW_TRIG - 70, VM_W, 260, fill="#FFFFFF", stroke=C.ML)
stop = d.box("POST /stopruntimesession<br>(caller's freshest bearer token)", VM_X + 40, 770, VM_W - 80, 56,
             fill="#FFF4E8", stroke=C.COMPUTE)

# 会話単位のロック
ddb = d.box("<b>moca-sessions</b> (DynamoDB)<br>one item per conversation<br><br>"
            "activeTurnOwner — request id<br>activeTurnRunner — user / machine<br>"
            "activeTurnLeaseUntil — renewed every 60 s to +180 s",
            DDB_X, ROW_USER - 45, 320, 380, fill="#FBF0FC", stroke=C.DATABASE, align="left", valign="top")

# 呼び出し
d.edge(user, vm_user, "&lt;id&gt;u", color=C.BLUE, label_pos=-0.2,
       label_offset=(0, -14))
d.edge(trig, vm_mach, "&lt;id&gt;m", color=C.COMPUTE, into_at=d.frac_y(vm_mach, ROW_TRIG),
       label_pos=-0.2, label_offset=(0, -12))
d.edge(orch, vm_mach, "&lt;id&gt;m", color=C.COMPUTE, into_at=d.frac_y(vm_mach, ROW_WF),
       label_pos=-0.2, label_offset=(0, -12))

# ロック
d.edge(vm_user, ddb, "turn lock<br>acquire / renew / release", color=C.DATABASE, dashed=True,
       into_at=d.frac_y(ddb, ROW_USER), label_pos=0.31)
d.edge(vm_mach, ddb, "turn lock<br>acquire / renew / release", color=C.DATABASE, dashed=True,
       at=d.frac_y(vm_mach, ROW_TRIG + 60), into_at=d.frac_y(ddb, ROW_TRIG + 60), label_pos=0.31)

# 自己停止
d.edge(vm_mach, stop, "after the response", color=C.COMPUTE, out="B", into="T", label_offset=(70, 0))

# 凡例
d.text("<b>Why:</b> on V2 a runtime session is pinned to the first caller's sub, and the pin outlives "
       "Stop and the idle timeout. Other identities get the platform's 403 AccessDeniedException.<br>"
       "<b>&lt;id&gt;</b> conversation id (33 chars) — Memory, S3 workspace, Code Interpreter and the "
       "sessions item always use it. Nobody sends it to the Runtime any more: before the split it may "
       "have been pinned to either side.<br>"
       "<b>&lt;id&gt;u</b> humans, <b>&lt;id&gt;m</b> machine callers — every conversation, old or new.<br>"
       "A second turn on the same conversation, from either microVM, gets serverTurnInProgressEvent.",
       40, 860, 1340, 110, size=12, color="#232F3E")

d.write(Path(__file__).resolve().parents[1] / "runtime-session-pinning.drawio")
