/**
 * Resilience of the shared AppSync Events socket: iOS PWAs resume with dead
 * sockets, drop subscribes on dying ones, and stay offline for longer than a
 * short backoff budget (issue #157).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../lib/auth', () => ({
  authService: { getTokens: vi.fn(async () => ({ accessToken: 'token' })) },
}));
vi.mock('../../config/appsync-events', () => ({
  appsyncEventsConfig: {
    isConfigured: true,
    realtimeEndpoint: 'wss://abc.appsync-realtime-api.ap-northeast-1.amazonaws.com/event/realtime',
  },
}));

import { useAppSyncConnectionStore, WAKE_STALE_AFTER_MS } from '../appsyncConnectionStore';
import { useAuthStore } from '../authStore';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;

  constructor() {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number): void {
    this.closedWith = code;
    this.readyState = FakeSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  serverClose(code: number): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
  subscribes(): string[] {
    return this.sent.filter((m) => m.type === 'subscribe').map((m) => m.id as string);
  }
}

const latest = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1];
const store = () => useAppSyncConnectionStore.getState();

async function connectAndAck(timeoutMs = 300_000): Promise<FakeSocket> {
  await store().connect();
  const ws = latest();
  ws.open();
  ws.receive({ type: 'connection_ack', connectionTimeoutMs: timeoutMs });
  await vi.waitFor(() => expect(ws.readyState).toBe(FakeSocket.OPEN));
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  useAuthStore.setState({ user: { userId: 'user-1' } } as never);
  store().disconnect();
  useAppSyncConnectionStore.setState({
    _subscriptionHandlers: new Map(),
    _subscribedCallbacks: new Map(),
    _channelMap: new Map(),
    _pendingSubscriptions: new Set(),
  });
});

afterEach(() => {
  store().disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pending subscriptions', () => {
  it('re-sends a subscribe that was pending on a socket that died', async () => {
    const first = await connectAndAck();
    await store().subscribe('/messages/u/s', 'sub-1', () => {});
    expect(first.subscribes()).toEqual(['sub-1']);

    // No subscribe_success: the socket dies with the subscribe in flight.
    first.serverClose(1006);
    expect(store()._pendingSubscriptions.size).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    const second = latest();
    expect(second).not.toBe(first);
    second.open();
    second.receive({ type: 'connection_ack' });
    await vi.waitFor(() => expect(second.subscribes()).toEqual(['sub-1']));
  });

  it('calls onSubscribed on the first subscribe and on every re-subscribe', async () => {
    const onSubscribed = vi.fn();
    const first = await connectAndAck();
    await store().subscribe('/messages/u/s', 'sub-1', () => {}, onSubscribed);
    first.receive({ type: 'subscribe_success', id: 'sub-1' });
    expect(onSubscribed).toHaveBeenCalledTimes(1);

    first.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const second = latest();
    second.open();
    second.receive({ type: 'connection_ack' });
    await vi.waitFor(() => expect(second.subscribes()).toEqual(['sub-1']));
    second.receive({ type: 'subscribe_success', id: 'sub-1' });
    expect(onSubscribed).toHaveBeenCalledTimes(2);
  });
});

describe('reconnect', () => {
  it('keeps retrying past the old 5-attempt budget', async () => {
    await connectAndAck();
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = FakeSocket.instances.length;
      latest().serverClose(1006);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(FakeSocket.instances.length).toBe(before + 1);
    }
  });

  it('does not reconnect after an intentional close', async () => {
    const ws = await connectAndAck();
    ws.serverClose(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances.length).toBe(1);
  });

  it('wake skips the backoff wait', async () => {
    await connectAndAck();
    for (let i = 0; i < 5; i++) {
      latest().serverClose(1006);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    latest().serverClose(1006); // now waiting ~30 s
    const before = FakeSocket.instances.length;
    store().wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances.length).toBe(before + 1);
  });
});

describe('dead socket detection', () => {
  it('replaces a socket that goes silent past connectionTimeoutMs', async () => {
    const ws = await connectAndAck(10_000);
    await vi.advanceTimersByTimeAsync(9_000);
    ws.receive({ type: 'ka' });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(FakeSocket.instances.length).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(ws.closedWith).toBe(4000);
    expect(FakeSocket.instances.length).toBe(2);
  });

  it('wake replaces an OPEN socket that has been silent too long', async () => {
    const ws = await connectAndAck();
    vi.setSystemTime(Date.now() + WAKE_STALE_AFTER_MS + 1);
    store().wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.closedWith).toBe(4000);
    expect(FakeSocket.instances.length).toBe(2);
  });

  it('wake keeps a socket that is still delivering', async () => {
    await connectAndAck();
    store().wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances.length).toBe(1);
  });

  it('ignores the close of a socket it already replaced', async () => {
    const first = await connectAndAck();
    vi.setSystemTime(Date.now() + WAKE_STALE_AFTER_MS + 1);
    store().wake();
    await vi.advanceTimersByTimeAsync(0);
    const second = latest();
    second.open();

    first.serverClose(1006);
    expect(store()._ws).toBe(second);
    expect(store().isConnected).toBe(true);
  });
});
