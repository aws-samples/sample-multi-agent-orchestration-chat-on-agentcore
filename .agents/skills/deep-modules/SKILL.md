---
name: deep-modules
description: Apply Ousterhout's "deep modules" principle (narrow interface, deep implementation) when designing or refactoring classes and modules. Use when adding new methods to a class, extracting shared logic, or reviewing repository / service code.
---

# Deep Modules — Narrow Interface, Deep Implementation

A *deep* module hides a lot of complexity behind a small public surface. Cost of a module ≈ `interface_complexity / functionality`. Optimize for fewer public methods, stable signatures, and policy concentrated in one place — not for fewer lines per file.

This skill is **language- and project-agnostic design guidance**. Moca-specific conventions live in `coding-style` (e.g. `nanoid` vs `uuid`, ESM `.js` extensions). Use both together.

## When to Apply

- **DO**: repositories, services, data-access layers, reusable utilities, tool definitions.
- **DO NOT (blindly)**:
  - Express route handlers — declarative, thin handlers are easier to read than "deep" ones.
  - React components — prop count is a separate concern (split with hooks, not by hiding state).
  - Test files — explicitness usually beats deduplication.

## Decision Heuristics

Use this table during design and code review. If two or more rows match, the module is probably too shallow.

| Smell | Diagnostic Question | Likely Fix |
|---|---|---|
| Method names enumerate fields (`updateXxxAndYyy`, `setStatus`, `setTitle`) | Does the caller need to know the storage schema to pick a method? | Collapse to `update(id, patch)` with an optional-fields object |
| Same `try / catch` + error-name branch repeated 3+ times | Is this a *policy* (e.g. "tolerate missing") or a per-call decision? | Extract a private wrapper; each public method becomes one line |
| Public method takes 4+ args, several `optional` | Do callers pass `undefined` to skip args? | Take an options object; drop unused fields entirely |
| Return value exposes internal identifiers (partition key, sequence number, marshalled item) | Does any caller actually use them? | Return a DTO; do not leak storage shape |
| Each method calls `marshall` / `unmarshall` (or equivalent serialization) directly | Is the conversion the same in every method? | Extract `toItem` / `fromItem` private mappers |
| `fromItem` *deletes* a denylist of storage keys (`PK` / `SK` / `GSI*`) before returning | Is the strip-list maintained separately from the list of keys `toItem` adds? | Project onto a domain-field *allowlist* instead — anything not named is dropped by construction, so a new index key can never leak |
| Module has 6+ public methods that share one noun | Can you describe what the module does in one sentence? | Merge methods, or split into two modules with different nouns |

## The 4 Pillars

A deep module has all four:

1. **Small surface area.** Field-level partial updates collapse into one `update(id, patch)`.
2. **Stable signature under change.** Adding a new updatable field or option must not break existing callers — favor `patch` / `options` objects over positional args.
3. **No leaking internals.** Storage keys, SDK types, SQL columns, and partition keys stay private. Public types describe the *domain*, not the *table*. The storage→domain mapper should *select* the domain fields (allowlist), not *strip* known storage keys (denylist): a denylist must be kept in sync with whatever the write path adds, and the day they drift an internal key leaks silently.
4. **Single locus for cross-cutting policy.** Logging, retry, idempotency, "tolerate missing", and error-mapping live in one private helper, not duplicated per method.

## Anti-Patterns

- **Pass-through method** — `service.updateTitle()` only delegates to `repo.updateTitle()`. If the wrapper adds nothing, lift the call to the next layer up.
- **Method-per-field** — `setName` / `setStatus` / `setDescription` siblings. Use one `update(id, patch)`.
- **Over-decomposed helpers** — splitting a 30-line module across 5 files. Depth is measured by *narrowness of public API*, not by file count. (Distinct from splitting to *narrow the public surface* — separating contract from implementation behind one entry point is fine; what's discouraged is fragmenting the *logic*.)
- **Premature interface extraction** — declaring a TypeScript `interface` for a class with one implementation and one caller. Wait for the second caller.
- **Leaky DTOs** — returning the storage row (with PK / SK / GSI columns) from a public method "for convenience". Once exposed, removal becomes a breaking change.

## If You Do Extract an Interface

The default is still "don't" — wait for the second implementation or a mocking seam (see the anti-pattern above). But when you extract one deliberately (e.g. to publish a reference contract ahead of need), keep the *interface* narrow by separating **contract** from **implementation**:

- The contract — the interface plus the types its methods take and return — is the only thing a caller reads. Place the method input/output types *with* the interface, not in the shared model file: they only mean something next to the method they feed.
- The data *model* (what the entity is) stays separate from the *operation* types (how you act on it). Dependencies point one way: implementation → contract → model.
- Expose one entry point (a barrel) and let only the composition root construct the concrete implementation. Callers depend on the interface; nobody else names the class.
- This is the one case where adding files *reduces* interface complexity — it is not the over-decomposition the anti-pattern warns about, because it narrows the public surface rather than fragmenting logic.

## Self-Check Before Adding a Public Method

Ask, in order:

1. Can an existing method absorb this with one extra option / patch field?
2. Does the proposed method name encode internal schema (field names, table columns, SDK verbs)?
3. If the next similar requirement arrives, will it add a 7th, 8th, 9th method?
4. What can be made `private` to keep the public surface stable across the next change?

If any answer is "yes" to (1)–(3), redesign before adding the method.

## Example (Moca)

`packages/agent/src/repositories/sessions-repository.ts` originally exposed 6 public methods, three of which are partial-update variants:

```
exists / get / create
updateSessionTimestamp / updateSessionAgentAndStorage / updateSessionTitle
```

Caller has to pick the right method based on which DynamoDB attributes are being touched — i.e. the public API encodes the storage schema.

A deep version:

```
exists / get / create / update(sessionId, patch)
```

with private helpers concentrating cross-cutting concerns:

- `key(sessionId)` — single source of `{ userId: pk, sessionId }` marshalling.
- `tolerateMissing(label, fn)` — one place that maps `ConditionalCheckFailedException` to a warn-and-skip.
- `buildUpdate(patch)` — pure function turning a `SessionPatch` into `UpdateExpression` + `ExpressionAttributeValues`, always stamping `updatedAt`.
- `toItem` / `fromItem` — the only places that touch `marshall` / `unmarshall`.

The composition layer (`sessions-service.ts`) keeps its `userId`-first public contract; only its internal calls switch from `repo.updateSessionTitle(...)` to `repo.update(id, { title })`. Surface for downstream callers is unchanged.
