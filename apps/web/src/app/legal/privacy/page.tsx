import type { Metadata, ResolvingMetadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { loadMessages, resolveRequestLocale } from '@/lib/i18n';
import { PRIVACY_CONTENT, LAST_UPDATED_ISO } from './content';

export async function generateMetadata(
  _props: unknown,
  _parent: ResolvingMetadata,
): Promise<Metadata> {
  const locale = await resolveRequestLocale();
  const messages = loadMessages(locale);
  return {
    title: `${messages.t('legal.privacy.title')} · Panorama`,
    description: messages.t('legal.privacy.metaDescription'),
  };
}

/**
 * Privacy policy — Wave 0 §9 plain-language v1 draft.
 *
 * Server-rendered, public route (no auth). Content per locale lives
 * in `./content.ts`. Pre-counsel-review draft per ADR-0014 §C6
 * trigger; the "Status notice" at the bottom of each locale block
 * makes the pre-review state explicit to readers.
 */
export default async function PrivacyPage(): Promise<ReactNode> {
  const locale = await resolveRequestLocale();
  const messages = loadMessages(locale);
  const content = PRIVACY_CONTENT[locale];
  return (
    <article className="panorama-legal-article">
      <header>
        <h1>{messages.t('legal.privacy.title')}</h1>
        <p className="panorama-legal-updated">
          {messages.t('legal.lastUpdated', { date: LAST_UPDATED_ISO })}
        </p>
        <p className="panorama-legal-status">
          {messages.t('legal.preCounselDraftBanner')}
        </p>
      </header>
      <PolicyContent body={content} />
      <footer className="panorama-legal-footer">
        <Link href="/legal/terms">{messages.t('legal.terms.title')}</Link>
        <span> · </span>
        <Link href="/">{messages.t('legal.backToHome')}</Link>
      </footer>
    </article>
  );
}

/**
 * Render the long-form policy body. The body uses simple markdown-ish
 * shape (## headings, * bullets) — we parse it server-side into <h2>
 * + <p> + <ul> elements. No client JS.
 *
 * NOT a full markdown renderer — only the subset the policy content
 * actually uses. Adding markdown library + sanitiser was an
 * over-engineering trap for a v1 draft.
 */
function PolicyContent({ body }: { body: string }): ReactNode {
  const sections = body.trim().split(/\n\n+/);
  return (
    <div className="panorama-legal-body">
      {sections.map((section, idx) => renderSection(section, idx))}
    </div>
  );
}

function renderSection(section: string, idx: number): ReactNode {
  const trimmed = section.trim();
  if (trimmed.startsWith('## ')) {
    return <h2 key={idx}>{trimmed.slice(3)}</h2>;
  }
  if (trimmed.startsWith('---')) {
    return <hr key={idx} />;
  }
  if (/^[-*] /m.test(trimmed) && trimmed.split('\n').every((line) => /^[-*] /.test(line))) {
    const items = trimmed.split('\n').map((line) => line.replace(/^[-*] /, ''));
    return (
      <ul key={idx}>
        {items.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }
  if (/^\d+\. /m.test(trimmed) && trimmed.split('\n').every((line) => /^\d+\. /.test(line))) {
    const items = trimmed.split('\n').map((line) => line.replace(/^\d+\. /, ''));
    return (
      <ol key={idx}>
        {items.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ol>
    );
  }
  return <p key={idx}>{renderInline(trimmed)}</p>;
}

/**
 * Inline rendering: **bold** and `code` only. No links, no images, no
 * arbitrary HTML. Policy text uses these patterns deliberately.
 */
function renderInline(text: string): ReactNode {
  // Split on the markdown patterns we support; preserve order.
  const parts: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      parts.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      parts.push(<code key={match.index}>{token.slice(1, -1)}</code>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return <>{parts}</>;
}
