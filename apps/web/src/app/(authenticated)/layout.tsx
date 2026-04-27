import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';

/**
 * Authenticated route-group layout (#78 PILOT-11).
 *
 * Next.js applies this layout to every page inside `(authenticated)/`
 * — the parentheses make it a route group (no URL segment), so URLs
 * like `/assets`, `/reservations`, `/maintenance/[id]` are unchanged.
 *
 * Public routes (`/login`, `/invitations/accept`, `/api/*`) live
 * outside this group and remain shell-less.
 *
 * AppShell does the session check + redirect-to-login internally;
 * this layout is a thin wrapper so each page doesn't have to repeat
 * the auth + header + nav boilerplate.
 */
export default async function AuthenticatedLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  return <AppShell>{children}</AppShell>;
}
