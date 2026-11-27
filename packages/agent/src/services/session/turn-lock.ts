/**
 * Per-conversation turn lock in DynamoDB.
 *
 * Humans and automation reach one conversation through different runtime
 * sessions (V2 pins a runtime session to its caller), i.e. through different
 * microVMs, so the in-process turn registry cannot stop two agent loops from
 * running on the same history. The lock lives on the conversation's
 * moca-sessions item and is leased so a dead microVM frees it within
 * {@link TURN_LOCK_LEASE_MS}.
 *
 * Not used by call_agent sub-agents: they do not go through /invocations.
 */

import type {
  TurnLockAcquireResult,
  TurnLockClaim,
  TurnRunner,
} from '../../repositories/sessions/index.js';
import { createLogger } from '../../libs/logger/index.js';

const log = createLogger('TurnLock');

export const TURN_LOCK_LEASE_MS = 180_000;
export const TURN_LOCK_RENEW_INTERVAL_MS = 60_000;

export interface TurnLockStore {
  acquireTurnLock(
    userId: string,
    sessionId: string,
    claim: TurnLockClaim
  ): Promise<TurnLockAcquireResult>;
  renewTurnLock(
    userId: string,
    sessionId: string,
    owner: string,
    leaseUntil: number
  ): Promise<boolean>;
  releaseTurnLock(userId: string, sessionId: string, owner: string): Promise<void>;
}

/**
 * `unavailable`: DynamoDB failed; the turn runs unlocked, as it did before
 * the lock existed, rather than failing the prompt.
 */
export type TurnLockResult = TurnLockAcquireResult | { status: 'unavailable' };

export class TurnLock {
  private timer?: ReturnType<typeof setInterval>;
  private held = false;
  private readonly startedAt: string;

  constructor(
    private readonly store: TurnLockStore,
    private readonly actorId: string,
    private readonly sessionId: string,
    private readonly owner: string,
    private readonly runner: TurnRunner,
    startedAt: Date,
    private readonly now: () => number = Date.now
  ) {
    this.startedAt = startedAt.toISOString();
  }

  /** The claim to write with a new conversation's item, so creating it takes the lock. */
  claim(): TurnLockClaim {
    return {
      owner: this.owner,
      runner: this.runner,
      startedAt: this.startedAt,
      leaseUntil: this.now() + TURN_LOCK_LEASE_MS,
    };
  }

  async acquire(): Promise<TurnLockResult> {
    try {
      const result = await this.store.acquireTurnLock(this.actorId, this.sessionId, this.claim());
      if (result.status === 'acquired') this.startRenewal();
      return result;
    } catch (error) {
      log.warn(
        { err: error, sessionId: this.sessionId },
        'Turn lock unavailable; running unlocked'
      );
      return { status: 'unavailable' };
    }
  }

  /**
   * After the item was created with {@link claim}. Idempotent for the owner, so
   * this also covers a concurrent creator having won the item.
   */
  async adoptCreated(): Promise<void> {
    if (this.held) return;
    const result = await this.acquire();
    if (result.status === 'held') {
      log.warn(
        { sessionId: this.sessionId },
        'Another caller holds the lock of a new conversation'
      );
    }
  }

  /** Idempotent; never throws. */
  async release(): Promise<void> {
    this.stopRenewal();
    if (!this.held) return;
    this.held = false;
    try {
      await this.store.releaseTurnLock(this.actorId, this.sessionId, this.owner);
    } catch (error) {
      // The lease expires on its own.
      log.warn({ err: error, sessionId: this.sessionId }, 'Failed to release turn lock');
    }
  }

  private startRenewal(): void {
    this.held = true;
    if (this.timer) return;
    this.timer = setInterval(() => void this.renew(), TURN_LOCK_RENEW_INTERVAL_MS);
    // A lingering timer must not keep a finished process alive.
    this.timer.unref?.();
  }

  private stopRenewal(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async renew(): Promise<void> {
    try {
      const ours = await this.store.renewTurnLock(
        this.actorId,
        this.sessionId,
        this.owner,
        this.now() + TURN_LOCK_LEASE_MS
      );
      if (!ours) {
        log.error({ sessionId: this.sessionId }, 'Turn lock was taken over while the turn runs');
        this.held = false;
        this.stopRenewal();
      }
    } catch (error) {
      log.warn({ err: error, sessionId: this.sessionId }, 'Failed to renew turn lock');
    }
  }
}
