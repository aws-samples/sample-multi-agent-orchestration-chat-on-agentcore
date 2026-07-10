# Built-in tools

Moca's per-agent toolbox, beyond the multi-agent / trigger / memory / UI tools
covered in their own references. Every tool here is opt-in via the agent's
`enabledTools`. Web search / image / video generation are gateway tools available
when the deployment enables them.

## code_interpreter — run code in an isolated sandbox

Executes Python (pandas/numpy/matplotlib preinstalled; `pip install` for seaborn,
scikit-learn, plotly, …), JavaScript, or TypeScript in Amazon Bedrock AgentCore's
sandbox. Actions: `initSession`, `executeCode`, `executeCommand`, `writeFiles`,
`readFiles`, `listFiles`, `removeFiles`, `downloadFiles`, `listLocalSessions`.

The one thing to get right: **the sandbox has its own filesystem, separate from
your workspace.** A file created by `executeCode` exists only in the sandbox. To
make it persist (and be referenceable in chat / synced to S3), `downloadFiles` it
into the workspace under `/tmp/ws`. Skip that step and the file reference will be
broken. See `references/workspace.md` for how workspace files persist.

Notes: variables may not survive between separate `executeCode` calls — keep
related steps in one block. Sessions time out (15 min default, up to 8h). Japanese
text in matplotlib renders correctly out of the box (a CJK font fallback is
preconfigured) — don't override `font.family`.

## browser — drive a managed Chrome browser

Actions include `startSession`, `navigate`, `snapshot`, `click`, `type`,
`screenshot`, `getContent`, `scroll`, `back`/`forward`, `waitForElement`,
`stopSession`. **Prefer `snapshot` (the accessibility tree) over `screenshot`** —
it's cheaper, deterministic, and gives stable UIDs to click/type against. Typical
flow: `navigate` → `snapshot` (get UIDs) → `click`/`type`. Sessions time out at
15 min.

## file_editor — create & edit files

Creates a file (pass empty `oldString`) or replaces text (`oldString` →
`newString`). `oldString` must be unique in the file and match exactly, whitespace
included; one location per call, so call repeatedly for multiple edits. To move or
rename, use `mv` via `execute_command`.

## execute_command — run shell commands

Runs a shell `command`, optional `workingDirectory` (restricted to allowed dirs),
`timeout` (default 120s, max 600s), `maxOutputLength`. For file ops, quick
scripts, and dev automation.

## s3_list_files — browse the user's storage

Lists files/dirs under a `path` (default `/`). Options: `recursive`, `maxResults`
(1–1000), `includePresignedUrls` + `presignedUrlExpiry` (60–86400s). Use it to
explore what the user has in their persistent storage.

## image_to_text — analyze / OCR images

Describes or extracts text from an image via Bedrock. `imagePath` accepts a local
path or an `s3://` URI (**not** a presigned URL), optional `prompt`, optional
vision `modelId` (defaults to Nova Lite 2). Good for OCR and visual understanding.

## todo — track multi-step progress

`init` creates/replaces a checklist (`items[]`); `update` changes item `status`
(pending / in_progress / completed / cancelled). Skip it for jobs under ~3 steps.

## think — structured reasoning space

Records a `thought`; executes nothing. Use it to reason before a consequential
action — after tool results, on ambiguous requests, before irreversible ops.
