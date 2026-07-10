# Long-term memory & past conversations

Moca can remember a user across chats and let you search their history — via the
`memory_search` tool. It is opt-in per agent, and it depends on memory being
enabled for the session.

## Preconditions (state these when memory isn't working)

- **The tool must be enabled** on the agent (`memory_search` in `enabledTools`).
- **Memory must be turned on** for the session. When it is, relevant long-term
  memories are loaded into context automatically at the start — so you often
  already know the user's preferences without searching.
- Memory is **strictly per-user.** You can only ever access the current user's
  data; there is no cross-user access. Say so if asked.

## The three modes

`memory_search` takes an `action`:

1. **`search`** (default) — semantic search over long-term memory: the user's
   preferences, habits, and past context. Params: `query` (required), `topK`
   (1–50, default 10). Use mid-conversation to recall something user-specific that
   isn't in the current context. Remember some memories are already in the system
   prompt — don't search for what you were already told.
2. **`list_sessions`** — list the user's past conversations, newest first. Params:
   `limit` (1–100, default 20), `nextToken` for paging. Returns session id, title,
   timestamps, agent, and type.
3. **`read_session`** — read the raw transcript of a past session. Params:
   `sessionId` (required), `range=[start, end]`. Returns **at most 20 messages per
   call** — page through longer transcripts with successive `range`s.

## What gets remembered

Long-term memory captures durable, user-specific facts — preferences and recurring
context — not the verbatim transcript. The transcript itself lives in session
history, reachable via `list_sessions` → `read_session`. So:

- "Remember that I prefer metric units" → durable preference, surfaces via `search`
  and auto-loads next time.
- "What did we decide last Tuesday?" → `list_sessions` to find it, then
  `read_session` to read the relevant range.

If memory isn't enabled, tell the user plainly that you can't recall across chats
until it's turned on — don't pretend to remember.
