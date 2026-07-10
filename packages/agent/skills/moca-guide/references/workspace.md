# Workspace, file persistence & skills

## Where files live and how they persist

Your working directory is `/tmp/ws` (plus a per-workspace subdirectory). It is
**synced with the user's private S3 storage**: files are pulled in at session
start and pushed back automatically after tool runs. So work **persists across
sessions** — a file you write today is there next time.

Consequences worth stating to the user:

- **You don't need to manually upload.** Writing under `/tmp/ws` is enough; the
  sync handles S3. (Don't generate presigned or full `s3://` URLs by hand.)
- **CodeInterpreter files are the exception** — they start in the sandbox, not the
  workspace, and must be `downloadFiles`d into `/tmp/ws` to persist. See
  `references/tools.md`.
- **Referencing files in chat:** strip the `/tmp/ws` prefix — show `/report.md`,
  not `/tmp/ws/report.md`. The frontend resolves display paths and secure download
  links. (The system prompt has the exact rules; follow those.)
- Storage is **per-user and isolated.** A user only sees their own files.

## Skills

Skills are packaged capabilities the agent can load on demand (like this one).
They live under `.agents/skills/<skill-name>/SKILL.md` in the workspace. Two
sources are combined:

- **workspace skills** — under the active workspace, specific to that storage path.
- **shared skills** — under the user's root `.agents/skills/`, available across all
  their workspaces.

When the same skill name exists in both, the **workspace** copy wins.

Guidance:
- Skills the agent ships with (bundled) and shared skills are always available; you
  activate one by loading its instructions when the task calls for it.
- **Do not edit or delete anything under `.agents/skills/`** unless the user
  explicitly asks you to manage their skills — those files define capabilities.
- "Add a skill for X" → the user adds a `SKILL.md` (and optional `references/`,
  `scripts/`, `assets/`) under `.agents/skills/`; it becomes available on the next
  session.
