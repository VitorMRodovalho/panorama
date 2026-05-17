import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const pathnameMock = vi.fn<() => string>(() => '/');
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
}));

import { AppNav, type AppNavItem } from './app-nav';

const PRIMARY: AppNavItem[] = [
  { href: '/reservations/calendar', label: 'Calendar' },
  { href: '/reservations', label: 'Reservations' },
  { href: '/inspections', label: 'Inspections' },
  { href: '/assets', label: 'Assets' },
];
const ADMIN: AppNavItem[] = [
  { href: '/admin/invitations', label: 'Invitations' },
  { href: '/admin/blackouts', label: 'Blackouts' },
];

describe('AppNav', () => {
  beforeEach(() => {
    pathnameMock.mockReset();
    pathnameMock.mockReturnValue('/');
  });

  it('renders primary items in display order', () => {
    pathnameMock.mockReturnValue('/');
    render(<AppNav items={PRIMARY} />);

    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual([
      'Calendar',
      'Reservations',
      'Inspections',
      'Assets',
    ]);
  });

  it('marks the exact-match item as aria-current="page"', () => {
    pathnameMock.mockReturnValue('/inspections');
    render(<AppNav items={PRIMARY} />);

    const inspections = screen.getByRole('link', { name: 'Inspections' });
    expect(inspections).toHaveAttribute('aria-current', 'page');

    const assets = screen.getByRole('link', { name: 'Assets' });
    expect(assets).not.toHaveAttribute('aria-current');
  });

  it('highlights the parent item when a deeper path matches without a more-specific sibling', () => {
    pathnameMock.mockReturnValue('/maintenance/abc-123');
    const items: AppNavItem[] = [
      ...PRIMARY,
      { href: '/maintenance', label: 'Maintenance' },
    ];
    render(<AppNav items={items} />);

    const maintenance = screen.getByRole('link', { name: 'Maintenance' });
    expect(maintenance).toHaveAttribute('aria-current', 'page');
  });

  it('does NOT highlight a parent item when a more-specific sibling also matches', () => {
    // /reservations/calendar must NOT also highlight /reservations.
    pathnameMock.mockReturnValue('/reservations/calendar');
    render(<AppNav items={PRIMARY} />);

    const calendar = screen.getByRole('link', { name: 'Calendar' });
    const reservations = screen.getByRole('link', { name: 'Reservations' });
    expect(calendar).toHaveAttribute('aria-current', 'page');
    expect(reservations).not.toHaveAttribute('aria-current');
  });

  it('renders the admin overflow when adminItems is non-empty', () => {
    pathnameMock.mockReturnValue('/reservations');
    render(<AppNav items={PRIMARY} adminItems={ADMIN} adminLabel="Admin" />);

    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invitations' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Blackouts' })).toBeInTheDocument();
  });

  it('opens the admin overflow when a current path matches an admin item', () => {
    pathnameMock.mockReturnValue('/admin/blackouts');
    render(<AppNav items={PRIMARY} adminItems={ADMIN} adminLabel="Admin" />);

    const details = screen.getByText('Admin').closest('details');
    expect(details).not.toBeNull();
    expect(details).toHaveAttribute('open');

    const blackouts = screen.getByRole('link', { name: 'Blackouts' });
    expect(blackouts).toHaveAttribute('aria-current', 'page');
  });

  it('omits the admin overflow entirely when adminItems is empty', () => {
    pathnameMock.mockReturnValue('/reservations');
    render(<AppNav items={PRIMARY} adminItems={[]} adminLabel="Admin" />);
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });
});
