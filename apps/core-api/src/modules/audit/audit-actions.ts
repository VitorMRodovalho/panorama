/**
 * Typed registry of audit actions Panorama emits (#90 / follow-up #28).
 *
 * Audit-action strings are public contract for downstream consumers
 * (alert rules, retention policies, SIEM filters). Without a registry,
 * authors pick sibling names by coin-flip and the namespace fragments.
 * The convention is `panorama.<domain>.<verb>` — this file is the
 * single source of truth for which `<domain>.<verb>` pairs exist.
 *
 * Initial seed scope: `panorama.auth.*`. Other domains
 * (reservation / inspection / maintenance / invitation / blackout /
 * pat / boot / notification / tenant / audit) currently use string
 * literals at call sites. Migrating those is a sibling cleanup PR;
 * this registry is the destination, the call sites move to it as
 * touched.
 *
 * To add a new action:
 *   1. Add the entry below in `panorama.<domain>.<verb>` shape.
 *   2. Use `PanoramaAuditAction.<MemberName>` at the call site (NOT
 *      a string literal).
 *   3. If the action is per-tenant, document the tenant scope in the
 *      JSDoc comment.
 */
export const PanoramaAuditAction = {
  // -------- panorama.auth.* --------
  /**
   * OIDC login refused. Cluster-wide event (`tenantId=null`) per
   * ADR-0003's NULL-strand convention: every tenant admin in the
   * cluster sees this row. Metadata MUST NOT carry per-tenant
   * context. Reasons: `email_not_verified` / `hd_not_allowlisted` /
   * `hd_iss_mismatch` / `hd_email_mismatch` /
   * `oidc_account_link_requires_verified_email`.
   */
  AuthOidcRefused: 'panorama.auth.oidc_refused',
  /**
   * OIDC login succeeded. Cluster-wide event (`tenantId=null`) —
   * visible to every tenant admin. Metadata carries `emailDomain`
   * + `hd` (the corporate IdP domain), which is information about
   * the LOGGED-IN user's organisation that propagates outside that
   * tenant. Considered acceptable because (a) refusals already do
   * the same and (b) the corporate domain is semi-public anyway.
   * Pre-pilot, single-cluster Panorama deployments make this a
   * non-issue; revisit if cross-tenant cluster sharing emerges.
   *
   * Metadata: `provider`, `pathTaken` (`existing_identity` /
   * `email_link` / `new_user`), `viaHdOverride`, `emailDomain`,
   * `hd`, `subjectHash`, `iss`. `actorUserId` populated post-
   * resolution (see #91 / follow-up #28).
   */
  AuthOidcLogin: 'panorama.auth.oidc_login',
} as const;

export type PanoramaAuditAction =
  (typeof PanoramaAuditAction)[keyof typeof PanoramaAuditAction];
