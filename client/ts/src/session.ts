// Sessions: who a request speaks for, as a token the database signed at login.

/** The database refused a login, or refused a session: its token was revoked, its account is
    gone, or it expired.  A session the database refused is ended for good, and the app signs in
    again. */
export class AuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** A signed-in user: the token the database signed, the user it names, and its expiry in seconds
    since the epoch.  A transport refreshes a session in place as it uses one, calling onRefresh
    after, which is the app's cue to save the new token; and sets ended once the database refuses
    it.  An Engine and any number of direct sends may share one.  HTTPTransport.login and
    restoreSession make them. */
export class Session {
  token: string;
  readonly user: string;
  exp: number;
  ended = false;
  onRefresh?: (session: Session) => void;

  constructor(token: string) {
    const c = claims(token);
    this.token = token;
    this.user = c.sub;
    this.exp = c.exp;
  }
}

/** a session from a token the app saved, without asking the database; refreshing it is what
    checks that the database still honors it */
export function restoreSession(token: string): Session {
  return new Session(token);
}

/** A token's claims, read without verifying it: only the database verifies its tokens, and a
    client reads the claims for what a session reports and for when to refresh it. */
export function claims(token: string): { sub: string; iat: number; exp: number } {
  const payload = token.split('.')[1];
  if (payload === undefined) throw new Error('not a session token');
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const json = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
  const c = JSON.parse(json) as Record<string, unknown>;
  if (typeof c.sub !== 'string' || typeof c.iat !== 'number' || typeof c.exp !== 'number') {
    throw new Error('not a session token');
  }
  return { sub: c.sub, iat: c.iat, exp: c.exp };
}
