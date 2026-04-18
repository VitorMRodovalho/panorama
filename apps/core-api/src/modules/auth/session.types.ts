/**
 * Shape stored in the iron-session encrypted cookie. Payload is read
 * server-side only; clients see an opaque base64 blob.
 *
 * Kept small — cookie size budget ~4 KB. Full User / tenant details live
 * in the DB; the session only carries what's needed to route a request
 * and render the nav bar without a DB hit.
 */
export interface PanoramaSessionMembership {
  tenantId: string;
  tenantSlug: string;
  tenantDisplayName: string;
  role: string;
  isVip: boolean;
}

export interface PanoramaSession {
  userId: string;
  email: string;
  displayName: string;
  currentTenantId: string;
  currentRole: string;
  isVip: boolean;
  memberships: PanoramaSessionMembership[];
  /** Unix seconds. Session middleware treats payloads older than max-age as expired. */
  issuedAt: number;
  /** Which auth provider minted this session (password | google | microsoft | …). */
  provider: string;
}

/**
 * Short-lived cookie used to carry OIDC dance state between
 * `/auth/oidc/:provider/start` and `/auth/oidc/:provider/callback`.
 * Expires after ~5 minutes; separate cookie name so clearing the auth
 * session doesn't drop in-flight OAuth flows and vice versa.
 */
export interface OidcStateCookie {
  provider: string;
  state: string;
  codeVerifier: string;
  nonce: string;
  redirectTo: string;
  tenantHint?: string;
  issuedAt: number;
}
