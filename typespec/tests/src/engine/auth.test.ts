// Auth and Reject, which deciders handlers use to authorize and to reject

import { describe, expect, test } from 'vitest';

import { Auth, Reject } from '../../../ts/assets/skeleton.ts';

describe('Reject', () => {
  test('is an Error whose message is the reason', () => {
    const e = new Reject('no such book');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('no such book');
  });
});

describe('Auth', () => {
  test('carries the principal and starts with no authorization decision', () => {
    const auth = new Auth({ user: 'u1' });
    expect(auth.user).toBe('u1');
    expect(auth.authorized).toBe(false);
  });

  test('authorize marks the call on a true condition', () => {
    const auth = new Auth({ user: 'u1' });
    auth.authorize(true);
    expect(auth.authorized).toBe(true);
  });

  test('authorize rejects on a false condition, with the reason or a default', () => {
    const auth = new Auth({ user: 'u1' });
    expect(() => auth.authorize(false, 'librarians only')).toThrow(Reject);
    expect(() => auth.authorize(false, 'librarians only')).toThrow('librarians only');
    expect(() => auth.authorize(false)).toThrow('unauthorized');
    expect(auth.authorized).toBe(false);
  });

  test('authorizeAnyone marks the call unconditionally, anonymous included', () => {
    const auth = new Auth({ user: null });
    auth.authorizeAnyone();
    expect(auth.authorized).toBe(true);
  });
});
