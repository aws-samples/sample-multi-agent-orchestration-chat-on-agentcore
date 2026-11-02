/**
 * chatStore — Gateway 3LO authorization prompts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore';

const prompt = (targetName: string, elicitationId = 'e-1') => ({
  url: 'https://bedrock-agentcore.us-west-2.amazonaws.com/identities/oauth2/authorize?request_uri=x',
  elicitationId,
  targetName,
});

describe('chatStore authorization prompts', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {}, activeSessionId: null });
  });

  it('keeps one prompt per target, newest wins', () => {
    const { addAuthorizationPrompt } = useChatStore.getState();
    addAuthorizationPrompt('s1', prompt('github', 'old'));
    addAuthorizationPrompt('s1', prompt('github', 'new'));
    addAuthorizationPrompt('s1', prompt('slack'));

    const pending = useChatStore.getState().sessions.s1.pendingAuthorizations ?? [];
    expect(pending.map((p) => [p.targetName, p.elicitationId])).toEqual([
      ['github', 'new'],
      ['slack', 'e-1'],
    ]);
  });

  it('dismisses a target in one session or across all sessions', () => {
    const { addAuthorizationPrompt, dismissAuthorizationPrompts } = useChatStore.getState();
    addAuthorizationPrompt('s1', prompt('github'));
    addAuthorizationPrompt('s2', prompt('github'));

    dismissAuthorizationPrompts('github', 's1');
    expect(useChatStore.getState().sessions.s1.pendingAuthorizations).toEqual([]);
    expect(useChatStore.getState().sessions.s2.pendingAuthorizations).toHaveLength(1);

    dismissAuthorizationPrompts('github');
    expect(useChatStore.getState().sessions.s2.pendingAuthorizations).toEqual([]);
  });

  it('keeps pending prompts when the session history is reloaded', () => {
    const { addAuthorizationPrompt, loadSessionHistory } = useChatStore.getState();
    addAuthorizationPrompt('s1', prompt('github'));
    loadSessionHistory('s1', []);
    expect(useChatStore.getState().sessions.s1.pendingAuthorizations).toHaveLength(1);
  });
});
