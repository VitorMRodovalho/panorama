import type { ReactNode } from 'react';

interface PageHeaderProps {
  /**
   * Page title. Renders as h1 — exactly one per authenticated page.
   *
   * Accepts ReactNode (not string) so pages can append a count pill or
   * status badge inline with the heading. RULE: textual content MUST
   * come first inside the ReactNode. Screen readers announce the h1's
   * accessible name as the concatenation of its descendants; "Reservations
   * 12" is acceptable, "12 Reservations" or pill-first is not.
   */
  title: ReactNode;
  /** Optional muted subtitle. */
  description?: string;
  /**
   * Optional right-aligned action slot. Use for primary CTAs (new
   * reservation, add blackout) that belong next to the title rather
   * than at the bottom of the form.
   */
  actions?: ReactNode;
}

/**
 * Standard page-title bar for every authenticated route (Round 4 PR2
 * per HANDOFF-2026-05-16-wave0-scan.md §"Round 4"). Centralises the
 * h1 element + spacing so subpages don't drift on heading hierarchy or
 * indentation. Pages that need section sub-headings keep their own
 * h2s below the page-header.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps): ReactNode {
  return (
    <header className="panorama-page-header">
      <div className="panorama-page-header-text">
        <h1 className="panorama-page-title">{title}</h1>
        {description ? <p className="panorama-page-description">{description}</p> : null}
      </div>
      {actions ? <div className="panorama-page-actions">{actions}</div> : null}
    </header>
  );
}
