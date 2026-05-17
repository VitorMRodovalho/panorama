import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock next/headers cookies — empty jar means the page does NOT
// redirect and renders the login form.
type CookieEntry = { value: string } | undefined;
const cookieGet = vi.fn<(name: string) => CookieEntry>(() => undefined);
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
  headers: vi.fn(async () => ({ get: (_: string): string | null => null })),
}));

const redirectMock = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    redirectMock(...args);
    // Match the real next/navigation contract — `redirect` never
    // returns. Throw a tagged error so the page's control flow halts
    // exactly as it would at runtime.
    throw new Error(`REDIRECT:${String(args[0])}`);
  },
}));

vi.mock('@/app/login/actions', () => ({
  discoveryAction: vi.fn(async () => ({ providers: ['password'], tenantHint: null })),
  loginAction: vi.fn(),
}));

import LoginPage from './page';

describe('login/page.tsx — smoke', () => {
  beforeEach(() => {
    cookieGet.mockReset();
    cookieGet.mockReturnValue(undefined);
    redirectMock.mockReset();
  });

  it('renders the email + password form when there is no session cookie', async () => {
    const ui = await LoginPage({
      searchParams: Promise.resolve({}),
    });
    render(ui);

    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in|entrar|iniciar sesión/i })).toBeInTheDocument();
  });

  it('redirects to /assets when a session cookie is present', async () => {
    cookieGet.mockReturnValue({ value: 'session-token' });

    await expect(
      LoginPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow(/REDIRECT:\/assets/);

    expect(redirectMock).toHaveBeenCalledWith('/assets');
  });
});
