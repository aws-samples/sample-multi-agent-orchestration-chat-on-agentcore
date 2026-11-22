import type { ServerErrorEvent } from '../types/index';

/**
 * A verdict the runtime sent as `serverErrorEvent`. Carries the event's `code`
 * and detail fields (e.g. tokenLimitExceeded's modelKey / used / limit) so the
 * caller can render something better than the raw message.
 */
export class ServerStreamError extends Error {
  readonly code: string | undefined;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(error: ServerErrorEvent['error']) {
    super(error.message);
    this.name = 'ServerStreamError';
    this.code = error.code;
    this.detail = error;
  }
}
