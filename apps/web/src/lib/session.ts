import 'server-only';
import { apiGet } from './api';

export interface PanoramaSession {
  userId: string;
  email: string;
  displayName: string;
  currentTenantId: string;
  currentRole: string;
  isVip: boolean;
  memberships: Array<{
    tenantId: string;
    tenantSlug: string;
    tenantDisplayName: string;
    tenantLocale: string;
    role: string;
    isVip: boolean;
  }>;
  provider: string;
}

/** Returns the session if the cookie is valid, otherwise null. */
export async function getCurrentSession(): Promise<PanoramaSession | null> {
  const result = await apiGet<PanoramaSession>('/auth/me');
  return result.ok ? result.data : null;
}
