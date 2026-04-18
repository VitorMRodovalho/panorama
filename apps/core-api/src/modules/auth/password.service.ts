import { Injectable, Logger } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * Password hashing + verification. Argon2id with the OWASP 2024
 * recommended parameters as the floor. We tune `memoryCost` up on
 * machines that can afford it; the default of 19 MiB is intentionally
 * modest so CI + dev boxes aren't swamped.
 */
@Injectable()
export class PasswordService {
  private readonly log = new Logger('PasswordService');

  private readonly hashOptions: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19_456, // KiB = ~19 MiB
    timeCost: 2,
    parallelism: 1,
  };

  async hash(plaintext: string): Promise<string> {
    if (plaintext.length < 12) {
      throw new Error('password must be at least 12 characters');
    }
    return argon2.hash(plaintext, this.hashOptions);
  }

  /**
   * Verify a plaintext password against a stored argon2id hash. Returns
   * `false` on any mismatch OR on a malformed hash — both are treated
   * identically so a missing-hash path cannot be distinguished from a
   * wrong-password path by a timing-oblivious caller.
   */
  async verify(hash: string | null | undefined, plaintext: string): Promise<boolean> {
    if (!hash) return false;
    try {
      return await argon2.verify(hash, plaintext);
    } catch (err) {
      this.log.warn({ err: String(err) }, 'password_verify_error');
      return false;
    }
  }

  /**
   * Check whether the stored hash is using outdated parameters and should
   * be rehashed on next successful login. Argon2 exposes this via
   * `needsRehash` — we call it every time so param bumps roll out without
   * needing a one-off migration script.
   */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.hashOptions);
    } catch {
      return true;
    }
  }
}
