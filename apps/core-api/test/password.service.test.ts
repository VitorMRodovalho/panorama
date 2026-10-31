import { describe, expect, it } from 'vitest';
import { PasswordService } from '../src/modules/auth/password.service.js';

/**
 * Pins the on-disk shape of `auth_identities.secretHash`.
 *
 * The PHC string format requires Argon2 parameters in `m,t,p` order
 * (https://c2sp.org/phc-strings: "Producers MUST NOT allow parameters
 * to appear in any other order"). argon2 0.45.0 / 0.45.1 emit `m,p,t`
 * instead (upstream ranisalt/node-argon2#559, open), which libsodium and
 * argon2-cffi reject. node-argon2 itself accepts both orders, so nothing
 * inside Panorama would notice; every hash written after such a bump
 * would just stop being portable. This test is the tripwire for that
 * bump: it fails on the affected releases and says why.
 */
describe('PasswordService — stored hash format', () => {
  const svc = new PasswordService();
  const pw = 'correct horse battery staple';

  it('writes a spec-ordered argon2id PHC string with the configured cost', async () => {
    const hash = await svc.hash(pw);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  });

  it('verifies its own hash, rejects a wrong password, and does not ask for a rehash', async () => {
    const hash = await svc.hash(pw);
    expect(await svc.verify(hash, pw)).toBe(true);
    expect(await svc.verify(hash, `${pw}!`)).toBe(false);
    expect(svc.needsRehash(hash)).toBe(false);
  });

  it('flags a hash made with weaker parameters for rehash', () => {
    // The login path's dummy hash shape (auth.service.ts) with t=1.
    const weaker =
      '$argon2id$v=19$m=19456,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$/ZC8l9ckA3dPnYcXVT4E+sLFXLyOF7QkePE0a4Tj8S8';
    expect(svc.needsRehash(weaker)).toBe(true);
  });

  it('treats a missing or malformed hash as a failed verify, never a throw', async () => {
    expect(await svc.verify(null, pw)).toBe(false);
    expect(await svc.verify('not-a-phc-string', pw)).toBe(false);
  });
});
