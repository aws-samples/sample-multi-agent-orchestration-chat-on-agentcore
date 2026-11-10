"""run_workflow orchestration architecture (docs/workflow-architecture.drawio)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".claude/skills/drawio-diagram/scripts"))
from drawio_lib import Diagram, C  # noqa: E402

ROW1 = 174          # chat / start path
COL1, COL2, COL3 = 370, 664, 964

d = Diagram(name="run_workflow", page_w=1240, page_h=1000)
d.title("<b>run_workflow</b> — multi-agent workflow orchestration")
d.group("AWS Cloud", 200, 60, 1000, 900, kind="aws_cloud")

user = d.shape("User<br>(browser)", 60, ROW1 - 24, "client", C.GENERAL, label_at="top")
parent = d.box("<b>Parent agent</b><br>AgentCore Runtime<br>(user session)",
               COL1 - 100, ROW1 - 34, 200, 68, fill="#E6F6F3", stroke=C.ML)
backend = d.icon("Backend API<br>/workflows", COL2 - 24, ROW1 - 24, "lambda", C.COMPUTE, label_at="top")

orch = d.box("<b>Workflow Orchestrator</b><br>Lambda durable function<br><br>"
             "Runs each wave in parallel (context.map)<br>Review loop / upstream escalation<br>"
             "Suspended while waiting (no compute)",
             560, 340, 220, 180, fill="#FFF4E8", stroke=C.COMPUTE)
ddb = d.icon("Workflows table<br>(header + steps)", COL3 - 24, 356, "dynamodb", C.DATABASE, label_at="right")
cognito = d.icon("Cognito<br>(machine user /<br>developer-auth)", COL3 - 24, 456, "cognito", C.SECURITY,
                 label_at="right")

steps = d.box("", 230, 620, 560, 170, fill="#F2FAF8", stroke=C.ML, dashed=True)
d.text("<b>Step Runtime sessions</b> (one microVM per step, subagent session)",
       244, 628, 520, 20, size=11, color="#232F3E")
d.box("<b>Worker</b><br>writes the deliverable<br>→ submit_workflow_result",
      250, 662, 170, 70, fill="#FFFFFF", stroke=C.ML)
d.box("<b>Reviewer</b><br>checks the criteria<br>done / needs_revision",
      440, 662, 150, 70, fill="#FFFFFF", stroke=C.ML)
d.text("Heartbeat every 5 min; callback when the turn ends", 250, 744, 340, 18, size=10)

bedrock = d.icon("Amazon Bedrock", COL1 - 64, 860, "bedrock", C.ML, label_at="right")
memory = d.box("AgentCore Memory<br>(conversation history)", 470, 860, 150, 48, fill="#FFFFFF", stroke=C.ML)

# 開始
d.edge(user, parent, "Chat", color=C.BLUE, label_pos=-0.5, label_offset=(0, -12))
d.edge(parent, backend, "run_workflow<br>POST /workflows", color=C.BLUE)
d.edge(backend, orch, "Invoke (Event)<br>DurableExecutionName<br>= workflowId", color=C.COMPUTE,
       out="B", into="T", into_at=d.frac_x(orch, COL2))
d.edge(backend, ddb, "Create (userId from JWT)", color=C.DATABASE, dashed=True, out="R", into="T",
       label_pos=-0.4)

# オーケストレーター
d.edge(orch, ddb, "Progress / result", color=C.DATABASE, dashed=True, at=d.frac_y(orch, 380))
d.edge(orch, cognito, "Mint tokens (per turn)", color=C.SECURITY, dashed=True, at=d.frac_y(orch, 480))
d.edge(orch, steps, "InvokeAgentRuntime<br>(workflowStep + callbackId)", color=C.ML,
       out="B", into="T", at=d.frac_x(orch, 610), into_at=d.frac_x(steps, 610), label_offset=(-95, 0))
d.edge(steps, orch, "SendDurableExecution<br>Callback / Heartbeat", color=C.COMPUTE, dashed=True,
       out="T", into="B", at=d.frac_x(steps, 740), into_at=d.frac_x(orch, 740), label_offset=(80, 0))
d.edge(orch, parent, "Completion turn<br>(notifyOnComplete)", color=C.BLUE,
       out="L", into="B", at=d.frac_y(orch, 440), label_pos=-0.3)

# ステップの依存先
d.edge(steps, bedrock, "ConverseStream", color=C.ML, out="B", into="T",
       at=d.frac_x(steps, COL1 - 40), label_offset=(-55, 0))
d.edge(steps, memory, "History", color=C.ML, out="B", into="T", at=d.frac_x(steps, 545),
       label_offset=(25, 0))

d.text("<b>Cancel</b>: the Backend sets cancelRequested; a separate durable execution (&lt;id&gt;-cancel)<br>"
       "stops the main execution (StopDurableExecution) and running step sessions (stopruntimesession, Bearer)<br>"
       "<b>Limits</b>: 10 steps / 3 parallel / 3 review rounds / 3 escalations / 8 h per step",
       640, 860, 540, 70, size=10)

d.write(Path(__file__).resolve().parents[1] / "workflow-architecture.drawio")
