import { NextResponse, type NextRequest } from 'next/server';

/**
 * Redirect unauthenticated requests for protected pages to /login.
 * Authentication is verified by presence of the session cookie — the
 * actual validation (decrypt + signature check) happens in the core-api
 * when any /api/* call is made. We do NOT trust the cookie at the web
 * layer for anything beyond "do you look signed in".
 *
 * Public pages: /login, /invitations/accept (0.3), /api/* (proxied,
 * core-api handles auth itself), and Next's own /_next, /favicon, etc.
 */
const PUBLIC_PATHS = ['/login', '/invitations/accept'];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const sessionCookie = req.cookies.get('panorama_session');
  if (!sessionCookie) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    const nextParam = pathname + (req.nextUrl.search ?? '');
    if (nextParam !== '/') url.searchParams.set('next', nextParam);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Skip static assets, the login page, and Next internals.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api|login|invitations/accept).*)'],
};
