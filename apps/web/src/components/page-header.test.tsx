import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PageHeader } from './page-header';

describe('PageHeader', () => {
  it('renders the title as h1 with the standard class', () => {
    render(<PageHeader title="Reservations" />);
    const h1 = screen.getByRole('heading', { level: 1, name: 'Reservations' });
    expect(h1).toBeInTheDocument();
    expect(h1).toHaveClass('panorama-page-title');
  });

  it('renders the optional description and actions slot', () => {
    render(
      <PageHeader
        title="Inspections"
        description="Pre-trip checks for bookable assets."
        actions={<button>Start</button>}
      />,
    );
    expect(
      screen.getByText('Pre-trip checks for bookable assets.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('accepts a ReactNode title so pages can append a count pill', () => {
    render(
      <PageHeader
        title={
          <>
            Assets <span data-testid="pill">12</span>
          </>
        }
      />,
    );
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent(/Assets\s+12/);
    expect(screen.getByTestId('pill')).toBeInTheDocument();
  });

  it('omits the description and actions slots when not provided', () => {
    render(<PageHeader title="Maintenance" />);
    expect(screen.queryByText(/./, { selector: '.panorama-page-description' })).not.toBeInTheDocument();
    expect(screen.queryByText(/./, { selector: '.panorama-page-actions' })).not.toBeInTheDocument();
  });
});
