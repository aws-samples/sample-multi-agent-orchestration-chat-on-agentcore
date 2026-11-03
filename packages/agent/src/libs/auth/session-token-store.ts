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
 * Only tokens that already passed `requestContextMiddleware` (JWKS + token
 * confusion checks) are recorded, so a session can never pick up another
 * user's token. Process-global scope is correct because AgentCore pins one
 * session to one microVM.
 */

interface StoredToken {
  token: string;
  expiresAt: number;
}

interface SessionTokens {
  idToken?: StoredToken;
  authorizationHeader?: StoredToken;
}

const store = new Map<string, SessionTokens>();

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
  sessionId: string,
  tokens: { idToken?: string; authorizationHeader?: string }
): void {
  pruneExpired(Date.now());
  const current = store.get(sessionId) ?? {};
  store.set(sessionId, {
    idToken: fresher(current.idToken, tokens.idToken),
    authorizationHeader: fresher(current.authorizationHeader, tokens.authorizationHeader),
  });
}

/** The freshest of the stored token and `candidate` (usually the request-start token). */
export function getFreshestIdToken(
  sessionId: string | undefined,
  candidate: string | undefined
): string | undefined {
  const stored = sessionId ? store.get(sessionId)?.idToken : undefined;
  return fresher(stored, candidate)?.token;
}

export function getFreshestAuthorizationHeader(
  sessionId: string | undefined,
  candidate: string | undefined
): string | undefined {
  const stored = sessionId ? store.get(sessionId)?.authorizationHeader : undefined;
  return fresher(stored, candidate)?.token;
}

/** Intended for unit tests only. */
export function resetSessionTokenStore(): void {
  store.clear();
}
