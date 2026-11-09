/**
 * chatStore — prependSessionHistory (AC3, AC7, AC8).
 *
 * Tests:
 *   - Prepending older messages re-runs mergeToolTurnMessages so a
 *     toolUse/toolResult split across a page boundary renders as one step (AC3).
 *   - Deduplication by message id.
 *   - Does not disturb a currently streaming or resumed turn (AC7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore';
import type { ConversationMessage } from '../../api/sessions';

vi.mock('../../api/agent', () => ({ streamAgentResponse: vi.fn() }));
vi.mock('../sessionStore', () => ({
  useSessionStore: { getState: () => ({ refreshSessions: vi.fn() }) },
}));
vi.mock('../agentStore', () => ({
  useAgentStore: { getState: () => ({ selectedAgent: null }) },
}));
vi.mock('../storageStore', () => ({
  useStorageStore: { getState: () => ({ agentWorkingDirectory: '' }) },
}));
vi.mock('../memoryStore', () => ({
  useMemoryStore: { getState: () => ({ isMemoryEnabled: false }) },
}));
vi.mock('../settingsStore', () => ({
  useSettingsStore: { getState: () => ({ reasoning: 'off' }) },
}));

const SESSION_ID = 'prependTestSESSION0000000000000001';

const makeConvMsg = (
  id: string,
  type: 'user' | 'assistant',
  contentType: 'text' | 'toolUse' | 'toolResult',
  extra: Record<string, unknown> = {}
): ConversationMessage => {
  let contents;
  if (contentType === 'text') {
    contents = [{ type: 'text' as const, text: `content-${id}` }];
  } else if (contentType === 'toolUse') {
    contents = [{ type: 'toolUse' as const, toolUse: { id: `tu-${id}`, name: 'browser', input: {}, status: 'completed' as const } }];
  } else {
    contents = [{ type: 'toolResult' as const, toolResult: { toolUseId: `tu-${id}`, content: 'result', isError: false } }];
  }
  return { id, type, contents, timestamp: new Date(0).toISOString(), ...extra };
};

beforeEach(() => {
  useChatStore.setState({ sessions: {}, activeSessionId: SESSION_ID } as never);
});

describe('chatStore.prependSessionHistory', () => {
  // AC3: toolUse/toolResult split across page boundary merges into one turn.
  it('re-runs mergeToolTurnMessages so a split toolUse/toolResult pair fuses into one message', () => {
    // Simulate: newer page loaded first (contains only toolResult for tu-older1).
    // This is realistic: on the first page load (latest events), the toolResult
    // is at the top, while the toolUse is on the older page.
    const newerPageRaw: ConversationMessage[] = [
      makeConvMsg('older1-result', 'user', 'toolResult'), // toolResult for tu-older1
      makeConvMsg('reply1', 'assistant', 'text'),
    ];
    // Older page: contains the toolUse.
    const olderPageRaw: ConversationMessage[] = [
      makeConvMsg('user1', 'user', 'text'),
      makeConvMsg('older1', 'assistant', 'toolUse'), // toolUse
    ];

    // Load the newer page first.
    useChatStore.getState().loadSessionHistory(SESSION_ID, newerPageRaw);

    // Now prepend the older page.
    const allRaw = [...olderPageRaw, ...newerPageRaw];
    useChatStore.getState().prependSessionHistory(SESSION_ID, allRaw);

    const messages = useChatStore.getState().sessions[SESSION_ID]!.messages;
    // After merge: user1 + merged_turn (older1 + older1-result + reply1)
    // OR: user1 + assistant(toolUse+toolResult+text) depending on merge rules
    // At minimum: the toolResult-only message should NOT appear standalone at the start.
    const firstAssistant = messages.find((m) => m.type === 'assistant');
    expect(firstAssistant).toBeDefined();
    // The merged turn should contain both toolUse and toolResult contents.
    const types = firstAssistant!.contents.map((c) => c.type);
    expect(types).toContain('toolUse');
    expect(types).toContain('toolResult');
  });

  it('deduplicates messages by id', () => {
    const initial: ConversationMessage[] = [
      makeConvMsg('m1', 'user', 'text'),
      makeConvMsg('m2', 'assistant', 'text'),
    ];
    useChatStore.getState().loadSessionHistory(SESSION_ID, initial);

    // Prepend with a duplicate of m1.
    const allRaw: ConversationMessage[] = [
      makeConvMsg('m0', 'user', 'text'),
      makeConvMsg('m1', 'user', 'text'), // duplicate
      makeConvMsg('m2', 'assistant', 'text'), // duplicate
    ];
    useChatStore.getState().prependSessionHistory(SESSION_ID, allRaw);

    const messages = useChatStore.getState().sessions[SESSION_ID]!.messages;
    // m1 appears only once.
    const ids = messages.map((m) => m.id);
    expect(ids.filter((id) => id === 'm1')).toHaveLength(1);
    expect(ids).toContain('m0');
  });

  // AC7: does not disturb a streaming turn.
  it('preserves isLoading when a turn is streaming (AC7)', () => {
    const initial: ConversationMessage[] = [
      makeConvMsg('m1', 'user', 'text'),
    ];
    useChatStore.getState().loadSessionHistory(SESSION_ID, initial);
    // Simulate a streaming turn in progress.
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          ...useChatStore.getState().sessions[SESSION_ID]!,
          isLoading: true,
        },
      },
    } as never);

    const olderRaw: ConversationMessage[] = [
      makeConvMsg('m0', 'user', 'text'),
      makeConvMsg('m1', 'user', 'text'),
    ];
    useChatStore.getState().prependSessionHistory(SESSION_ID, olderRaw);

    // isLoading must still be true (streaming not disturbed).
    expect(useChatStore.getState().sessions[SESSION_ID]!.isLoading).toBe(true);
  });

  it('does not set error on successful prepend', () => {
    const initial: ConversationMessage[] = [makeConvMsg('m1', 'user', 'text')];
    useChatStore.getState().loadSessionHistory(SESSION_ID, initial);

    const allRaw: ConversationMessage[] = [
      makeConvMsg('m0', 'user', 'text'),
      makeConvMsg('m1', 'user', 'text'),
    ];
    useChatStore.getState().prependSessionHistory(SESSION_ID, allRaw);

    expect(useChatStore.getState().sessions[SESSION_ID]!.error).toBeNull();
  });
});
