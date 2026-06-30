/**
 * sessionStore — agentId handling for optimistically-added sessions.
 *
 * Regression coverage for the bug where clicking a `[Sub]` session while the
 * spawning agent is still running did not switch the selected agent in the
 * header. Root cause: optimistically-added sub-agent sessions dropped the
 * `agentId` carried by the DynamoDB-stream event, so `selectSession` skipped
 * `selectAgent`. See GitHub issue #52.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../sessionStore';

// A valid 33-char alphanumeric SessionId (see @moca/core/session-id).
const SESSION_ID = 'abcdefghij0123456789ABCDEFGHIJ012';
// A valid UUIDv7-shaped AgentId (see @moca/core/agent-id).
const AGENT_ID = '019573e4-5a1b-7c2d-8e3f-4a5b6c7d8e9f';
const OTHER_AGENT_ID = '019573e4-5a1b-7c2d-8e3f-4a5b6c7d8e00';

describe('sessionStore agentId backfill', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [] });
  });

  it('stores agentId passed to addOptimisticSession', () => {
    useSessionStore.getState().addOptimisticSession(SESSION_ID, '[Sub] worker', 'subagent', AGENT_ID);

    const session = useSessionStore.getState().sessions.find((s) => s.sessionId === SESSION_ID);
    expect(session?.agentId).toBe(AGENT_ID);
  });

  it('drops a malformed agentId rather than branding it', () => {
    useSessionStore.getState().addOptimisticSession(SESSION_ID, '[Sub] worker', 'subagent', 'not-an-id');

    const session = useSessionStore.getState().sessions.find((s) => s.sessionId === SESSION_ID);
    expect(session?.agentId).toBeUndefined();
  });

  it('backfills agentId on a session that was added without one', () => {
    const store = useSessionStore.getState();
    store.addOptimisticSession(SESSION_ID, '[Sub] worker', 'subagent');
    expect(
      useSessionStore.getState().sessions.find((s) => s.sessionId === SESSION_ID)?.agentId
    ).toBeUndefined();

    store.updateSessionAgentId(SESSION_ID, AGENT_ID);

    const session = useSessionStore.getState().sessions.find((s) => s.sessionId === SESSION_ID);
    expect(session?.agentId).toBe(AGENT_ID);
  });

  it('ignores a malformed agentId in updateSessionAgentId', () => {
    const store = useSessionStore.getState();
    store.addOptimisticSession(SESSION_ID, '[Sub] worker', 'subagent', AGENT_ID);

    store.updateSessionAgentId(SESSION_ID, 'not-an-id');

    const session = useSessionStore.getState().sessions.find((s) => s.sessionId === SESSION_ID);
    expect(session?.agentId).toBe(AGENT_ID);
  });

  it('updates agentId when a different valid value arrives', () => {
    const store = useSessionStore.getState();
    store.addOptimisticSession(SESSION_ID, '[Sub] worker', 'subagent', AGENT_ID);

    store.updateSessionAgentId(SESSION_ID, OTHER_AGENT_ID);

    const session = useSessionStore.getState().sessions.find((s) => s.sessionId === SESSION_ID);
    expect(session?.agentId).toBe(OTHER_AGENT_ID);
  });
});