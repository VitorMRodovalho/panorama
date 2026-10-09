import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BootAuditService } from '../src/modules/boot-audit/boot-audit.service.js';
import type {
	AuditEventInput,
	AuditService,
} from '../src/modules/audit/audit.service.js';
import type {
	AuthConfig,
	AuthConfigService,
} from '../src/modules/auth/auth.config.js';
import type { PrismaService } from '../src/modules/prisma/prisma.service.js';
import { PanoramaAuditAction } from '../src/modules/audit/audit-actions.js';

/**
 * Unit coverage for the SESSION_SECRET rotation boot-audit (#234).
 *
 * Calls the private method directly via `as any` to avoid having to
 * stub the db-pool / redis paths that `onModuleInit` also walks
 * through — those have their own assertion surface (e2e). The
 * rotation-state branch is what this PR adds and what this suite
 * pins:
 *   - rotation active (`sessionSecretPrevious` set) → exactly one
 *     row with action / resourceType / resourceId / tenantId /
 *     actorUserId pinned, and metadata `{ rotationActive: true }`
 *     (no secret values or lengths — security-reviewer hard-rule
 *     mirrored from the existing boot INFO log).
 *   - rotation inactive (`sessionSecretPrevious === undefined`) →
 *     zero rows. The absence of the row IS the "no rotation" signal
 *     per the action's JSDoc; this is the canary that ensures a
 *     future refactor cannot silently flip presence semantics.
 */

interface RecordingAudit extends AuditService {
	calls: AuditEventInput[];
}

function makeAudit(): RecordingAudit {
	const calls: AuditEventInput[] = [];
	const audit = {
		record: vi.fn(async (input: AuditEventInput) => {
			calls.push(input);
		}),
		calls,
	};
	return audit as unknown as RecordingAudit;
}

function makeAuthConfig(
	sessionSecretPrevious: string | undefined,
): AuthConfigService {
	// Only the rotation state matters for this test — the other
	// AuthConfig fields are out of scope and stubbed to plausible
	// values just to satisfy the type shape.
	const config: AuthConfig = {
		sessionSecret: 'a'.repeat(32),
		...(sessionSecretPrevious !== undefined ? { sessionSecretPrevious } : {}),
		sessionPassword:
			sessionSecretPrevious !== undefined
				? { 1: sessionSecretPrevious, 2: 'a'.repeat(32) }
				: 'a'.repeat(32),
		sessionCookieName: 'panorama_session',
		oauthStateCookieName: 'panorama_oauth',
		sessionMaxAgeSeconds: 60 * 60 * 24 * 7,
		oauthStateMaxAgeSeconds: 5 * 60,
		baseUrl: 'http://localhost:4000',
		isProduction: false,
		providers: {},
		csrf: { trustedOrigins: new Set(['http://localhost:4000']) },
	};
	return { config } as AuthConfigService;
}

const fakePrisma = {} as PrismaService;

describe('BootAuditService — session-secret rotation audit (#234)', () => {
	it('emits panorama.auth.session_secret_rotated when sessionSecretPrevious is set', async () => {
		const audit = makeAudit();
		const authConfig = makeAuthConfig('b'.repeat(32));
		const service = new BootAuditService(fakePrisma, audit, authConfig);

		await (service as any).recordSessionSecretRotationAudit();

		expect(audit.calls).toHaveLength(1);
		const row = audit.calls[0]!;
		expect(row.action).toBe(PanoramaAuditAction.AuthSessionSecretRotated);
		expect(row.action).toBe('panorama.auth.session_secret_rotated');
		expect(row.resourceType).toBe('auth_config');
		expect(row.resourceId).toBe('session_secret');
		expect(row.tenantId).toBeNull();
		expect(row.actorUserId).toBeNull();
		expect(row.metadata).toEqual({ rotationActive: true });
		// Hard rule: metadata must NEVER carry secret values or lengths
		// — mirroring `auth_config_session_secret_rotation_active`'s
		// existing INFO-log constraint. Spot-check by serializing.
		const blob = JSON.stringify(row.metadata);
		expect(blob).not.toContain('a'.repeat(32));
		expect(blob).not.toContain('b'.repeat(32));
		expect(blob).not.toMatch(/length|len|size/i);
	});

	it('does NOT emit when sessionSecretPrevious is undefined (no rotation in flight)', async () => {
		const audit = makeAudit();
		const authConfig = makeAuthConfig(undefined);
		const service = new BootAuditService(fakePrisma, audit, authConfig);

		await (service as any).recordSessionSecretRotationAudit();

		expect(audit.calls).toHaveLength(0);
	});
});
