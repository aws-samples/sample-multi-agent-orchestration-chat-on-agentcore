/**
 * Runtime instance identity
 *
 * AgentCore Runtime pins one session to one microVM (one process). When a
 * microVM is reclaimed by the idle-timeout and later a new turn arrives, a
 * fresh container starts — but the agent has no built-in way to know that
 * its ephemeral state (/tmp, in-memory caches, background processes) has
 * been lost.
 *
 * This module mints a UUID once per process start and exports it as
 * `RUNTIME_INSTANCE_ID`. The session handler persists this ID in the
 * DynamoDB session item and compares it at the start of each turn.
 * A change means a different microVM is handling this turn, and the
 * system prompt for that turn includes a one-line notice so the model
 * can avoid referencing state from the previous container.
 */

import { randomUUID } from 'crypto';

/**
 * UUID minted once when this module is first imported (i.e. at process start).
 * Stable for the lifetime of the process.
 */
export const RUNTIME_INSTANCE_ID: string = randomUUID();
