import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { SignupRateLimits } from '../signup/signup-rate-limits.service.js';
import { EmailVerificationConfigService } from './email-verification.config.js';
import { EmailVerificationController } from './email-verification.controller.js';
import { EmailVerificationService } from './email-verification.service.js';

/**
 * ADR-0020 §3 — email-verification surface (PR 2).
 *
 * Loaded UNCONDITIONALLY — even with `FEATURE_SELF_SERVE_SIGNUP=false`
 * an existing tenant (created while the flag was on) may still need
 * to verify. Signup callback consumption (mint+dispatch) is gated
 * separately at the caller (`SignupModule` injects the service only
 * when the flag is on).
 *
 * `EmailVerificationConfigService` mirrors the
 * `SIGNUP_FAILURE_LATENCY_FLOOR_MS` env knob from `SignupConfigService`
 * to avoid a SignupModule ↔ EmailVerificationModule import cycle.
 * Both configs read the same env var so the two surfaces share a
 * single tunable in deployment.
 */
@Module({
  imports: [EmailModule],
  controllers: [EmailVerificationController],
  providers: [
    EmailVerificationConfigService,
    EmailVerificationService,
    // Reused by EmailVerificationController for the §4 per-IP +
    // per-subnet buckets on POST /auth/verify. Same Redis key
    // namespace as the signup endpoints so a single client IP
    // shares one budget across both surfaces.
    SignupRateLimits,
  ],
  exports: [EmailVerificationService],
})
export class EmailVerificationModule {}
