/**
 * Freshest caller tokens per session.
 *
 * A turn can outlive the JWTs captured at request start (ID / access token
 * validity is 1 h; a turn may run up to the 8 h microVM lifetime). Every
 * verified request for a session — including the `renewTokens` side channel
 * the frontend sends during a long turn — records its tokens here, and
 * long-lived consumers (credential refresh, Backend API calls) read the
 * freshest one instead of the request-start copy.
 *
 * Entries are keyed by the verified access-token `sub` as well as the session
 * id. The session id is client-chosen and visible in the frontend URL, so
 * keying by it alone would let any authenticated caller plant their tokens
 * into another user's running turn. Process-global scope is correct because
 * AgentCore pins one session to one microVM.
 */

interface StoredToken {
  token: string;
  expiresAt: number;
}

interface SessionTokens {
  idToken?: StoredToken;
  authorizationHeader?: StoredToken;
}

/** Whose tokens, on which Runtime session. Both are required to hit the store. */
export interface TokenScope {
  /** Verified access-token `sub` of the caller. */
  owner?: string;
  sessionId?: string;
}

const store = new Map<string, SessionTokens>();

function storeKey({ owner, sessionId }: TokenScope): string | undefined {
  // JSON keeps the key injective without assuming a separator never occurs.
  return owner && sessionId ? JSON.stringify([owner, sessionId]) : undefined;
}

/** Decode the `exp` claim (ms). Signature is NOT checked — see module doc. */
export function decodeJwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const jwt = token.startsWith('Bearer ') ? token.substring(7).trim() : token;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function fresher(
  current: StoredToken | undefined,
  token: string | undefined
): StoredToken | undefined {
  if (!token) return current;
  const expiresAt = decodeJwtExpiryMs(token) ?? 0;
  return !current || expiresAt > current.expiresAt ? { token, expiresAt } : current;
}

function pruneExpired(now: number): void {
  for (const [key, tokens] of store) {
    const latest = Math.max(
      tokens.idToken?.expiresAt ?? 0,
      tokens.authorizationHeader?.expiresAt ?? 0
    );
    if (latest <= now) store.delete(key);
  }
}

export function recordSessionTokens(
  scope: TokenScope,
  tokens: { idToken?: string; authorizationHeader?: string }
): void {
  const key = storeKey(scope);
  if (!key) return;
  pruneExpired(Date.now());
  const current = store.get(key) ?? {};
  store.set(key, {
    idToken: fresher(current.idToken, tokens.idToken),
    authorizationHeader: fresher(current.authorizationHeader, tokens.authorizationHeader),
  });
}

/** The freshest of the stored token and `candidate` (usually the request-start token). */
export function getFreshestIdToken(
  scope: TokenScope,
  candidate: string | undefined
): string | undefined {
  const key = storeKey(scope);
  const stored = key ? store.get(key)?.idToken : undefined;
  return fresher(stored, candidate)?.token;
}

export function getFreshestAuthorizationHeader(
  scope: TokenScope,
  candidate: string | undefined
): string | undefined {
  const key = storeKey(scope);
  const stored = key ? store.get(key)?.authorizationHeader : undefined;
  return fresher(stored, candidate)?.token;
}

/** Intended for unit tests only. */
export function resetSessionTokenStore(): void {
  store.clear();
}
