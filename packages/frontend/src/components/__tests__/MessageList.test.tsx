// @vitest-environment jsdom
/**
 * MessageList — RTL component tests (review finding #3).
 *
 * Covers:
 * - "Load earlier messages" control visible only when hasMore=true
 * - Loading state (spinner / text while older events are in-flight)
 * - Inline retry on error without clearing already-shown messages
 * - Scroll-position preservation after prepend (scrollTop adjusted by the
 *   scrollHeight delta; layout values are mocked)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

// ---------------------------------------------------------------------------
// jsdom stubs for DOM APIs not implemented in the test environment
// ---------------------------------------------------------------------------

window.HTMLElement.prototype.scrollIntoView = vi.fn();

const mockSessionStore = {
  isLoadingEvents: false,
  eventsHasMore: false,
  isLoadingOlderEvents: false,
  olderEventsError: null as string | null,
  loadOlderEvents: vi.fn(),
};

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (sel?: (s: typeof mockSessionStore) => unknown) =>
    sel ? sel(mockSessionStore) : mockSessionStore,
}));

const mockChatStore = {
  sessions: {} as Record<string, { messages: unknown[]; isLoading: boolean; error: string | null }>,
};

vi.mock('../../stores/chatStore', () => ({
  useChatStore: (sel?: (s: typeof mockChatStore) => unknown) =>
    sel ? sel(mockChatStore) : mockChatStore,
}));

vi.mock('../../stores/agentStore', () => ({
  useSelectedAgent: () => null,
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: () => false,
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ sessionId: 'session-test-001' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'chat.loadEarlierMessages': 'Load earlier messages',
        'chat.loadingEarlierMessages': 'Loading earlier messages...',
        'chat.loadEarlierError': 'Failed to load earlier messages',
        'chat.loadEarlierRetry': 'Retry',
        'common.error': 'Error',
      };
      return map[key] ?? key;
    },
  }),
}));

// Stub heavy child components that use complex DOM APIs unavailable in jsdom.
vi.mock('../Message', () => ({
  Message: ({ message }: { message: { id: string } }) =>
    React.createElement('div', { 'data-testid': `message-${message.id}` }),
}));
vi.mock('../MessageSkeleton', () => ({
  MessageSkeleton: () => React.createElement('div', { 'data-testid': 'message-skeleton' }),
}));
vi.mock('../WelcomeScreenSkeleton', () => ({
  WelcomeScreenSkeleton: () =>
    React.createElement('div', { 'data-testid': 'welcome-screen-skeleton' }),
}));
vi.mock('../TypingIndicator', () => ({
  TypingIndicator: () => React.createElement('div', { 'data-testid': 'typing-indicator' }),
}));
vi.mock('../../utils/agent-translation', () => ({
  translateIfKey: (v: string) => v,
}));

// ---------------------------------------------------------------------------

import { MessageList } from '../MessageList';

const SESSION_ID = 'session-test-001';

/** Seed chatStore with N messages for the session. */
function seedMessages(count: number) {
  mockChatStore.sessions[SESSION_ID] = {
    messages: Array.from({ length: count }, (_, i) => ({ id: `msg-${i}` })),
    isLoading: false,
    error: null,
  };
}

beforeEach(() => {
  mockSessionStore.isLoadingEvents = false;
  mockSessionStore.eventsHasMore = false;
  mockSessionStore.isLoadingOlderEvents = false;
  mockSessionStore.olderEventsError = null;
  mockSessionStore.loadOlderEvents = vi.fn();
  mockChatStore.sessions = {};
});

// ---------------------------------------------------------------------------
// 1. Visibility of the "Load earlier messages" control
// ---------------------------------------------------------------------------

describe('Load earlier messages control', () => {
  it('is NOT shown when hasMore=false', () => {
    seedMessages(3);
    mockSessionStore.eventsHasMore = false;
    render(React.createElement(MessageList));
    expect(screen.queryByText('Load earlier messages')).toBeNull();
  });

  it('IS shown when hasMore=true and messages are present', () => {
    seedMessages(3);
    mockSessionStore.eventsHasMore = true;
    render(React.createElement(MessageList));
    expect(screen.getByText('Load earlier messages')).toBeTruthy();
  });

  it('is NOT shown when messages are empty (no history loaded yet)', () => {
    mockSessionStore.eventsHasMore = true;
    render(React.createElement(MessageList));
    expect(screen.queryByText('Load earlier messages')).toBeNull();
  });

  it('calls loadOlderEvents with the sessionId when clicked', () => {
    seedMessages(3);
    mockSessionStore.eventsHasMore = true;
    render(React.createElement(MessageList));
    fireEvent.click(screen.getByText('Load earlier messages'));
    expect(mockSessionStore.loadOlderEvents).toHaveBeenCalledWith(SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// 2. Loading state
// ---------------------------------------------------------------------------

describe('Loading state', () => {
  it('shows loading text while isLoadingOlderEvents=true', () => {
    seedMessages(3);
    mockSessionStore.eventsHasMore = true;
    mockSessionStore.isLoadingOlderEvents = true;
    render(React.createElement(MessageList));
    expect(screen.getByText('Loading earlier messages...')).toBeTruthy();
    expect(screen.queryByText('Load earlier messages')).toBeNull();
  });

  it('does not show the load-more button while loading', () => {
    seedMessages(3);
    mockSessionStore.eventsHasMore = true;
    mockSessionStore.isLoadingOlderEvents = true;
    render(React.createElement(MessageList));
    expect(
      screen.queryByRole('button', { name: /load earlier messages/i })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Error state with inline retry (does not clear shown messages)
// ---------------------------------------------------------------------------

describe('Error / retry state', () => {
  it('shows the error message and a retry button', () => {
    seedMessages(3);
    mockSessionStore.eventsHasMore = false; // error while hasMore was true
    mockSessionStore.olderEventsError = 'Failed to load earlier messages';
    render(React.createElement(MessageList));
    expect(screen.getByText('Failed to load earlier messages')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('retry button calls loadOlderEvents without clearing existing messages', () => {
    seedMessages(3);
    mockSessionStore.olderEventsError = 'Failed to load earlier messages';
    render(React.createElement(MessageList));
    fireEvent.click(screen.getByText('Retry'));
    expect(mockSessionStore.loadOlderEvents).toHaveBeenCalledWith(SESSION_ID);
    // Messages still present (not cleared).
    expect(screen.getByTestId('message-msg-0')).toBeTruthy();
    expect(screen.getByTestId('message-msg-1')).toBeTruthy();
  });

  it('does not show loading text while an error is displayed', () => {
    seedMessages(3);
    mockSessionStore.olderEventsError = 'Failed to load earlier messages';
    render(React.createElement(MessageList));
    expect(screen.queryByText('Loading earlier messages...')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Scroll-position preservation after prepend
//    Vitest/jsdom doesn't implement real layout, so we mock the relevant
//    scrollHeight/scrollTop/clientHeight properties on the container ref.
// ---------------------------------------------------------------------------

describe('Scroll-position preservation after prepend', () => {
  it('adjusts scrollTop by the scrollHeight delta when messages are prepended', async () => {
    // Start with 2 messages already shown.
    seedMessages(2);
    mockSessionStore.eventsHasMore = true;

    const { rerender } = render(React.createElement(MessageList));

    // Find the scrollable container (first child of document body that has
    // overflow-y-auto).
    const container = document.querySelector<HTMLDivElement>('.overflow-y-auto');
    expect(container).not.toBeNull();

    // Mock layout values: initial scrollHeight=500, scrollTop=0.
    let _scrollTop = 0;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => _scrollTop,
      set: (v: number) => { _scrollTop = v; },
    });
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => 300 });

    // Simulate clicking "Load earlier" — stores the scrollHeight before the prepend.
    act(() => {
      fireEvent.click(screen.getByText('Load earlier messages'));
    });

    // Now prepend 3 more messages (total 5) and bump scrollHeight to 900.
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => 900 });
    seedMessages(5);
    // Re-render with same props so useLayoutEffect fires with the new message count.
    await act(async () => {
      rerender(React.createElement(MessageList));
    });

    // scrollTop should have been incremented by the delta (900 - 500 = 400).
    expect(_scrollTop).toBe(400);
  });
});
