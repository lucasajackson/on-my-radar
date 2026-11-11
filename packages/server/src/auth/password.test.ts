import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { errSerializer } from '../logger.js';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashes', () => {
  it('round-trips, and a wrong password or a tampered hash does not verify', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$1\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', hash)).toEqual({
      ok: true,
      needsRehash: false,
    });
    expect((await verifyPassword('correct horse batterz', hash)).ok).toBe(false);
    const parts = hash.split('$');
    parts[6] = Buffer.from(randomBytes(64)).toString('base64url');
    expect((await verifyPassword('correct horse battery', parts.join('$'))).ok).toBe(false);
    expect((await verifyPassword('correct horse battery', 'garbage')).ok).toBe(false);
  });

  it('never accepts when there is no hash, even for the dummy hash’s own key', async () => {
    expect((await verifyPassword('anything at all', null)).ok).toBe(false);
  });

  it('verifies a hash made with weaker parameters and asks for a rehash', async () => {
    const salt = randomBytes(16);
    const key = scryptSync('older password', salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const old = `scrypt$1$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
    expect(await verifyPassword('older password', old)).toEqual({ ok: true, needsRehash: true });
  });
});

describe('the log', () => {
  it('never carries a password hash, in an error message, its parameters or its cause', async () => {
    const hash = await hashPassword('a password to leak');
    const failed = Object.assign(
      new Error(`Failed query: insert into user_passwords params: ${hash}`),
      {
        params: ['u1', hash],
        cause: new Error(`detail ${hash}`),
      },
    );
    const written = JSON.stringify(errSerializer(failed));
    expect(written).toContain('Failed query');
    expect(written).not.toContain('scrypt$');
    expect(written).not.toContain(hash.split('$')[6]);
  });
});
