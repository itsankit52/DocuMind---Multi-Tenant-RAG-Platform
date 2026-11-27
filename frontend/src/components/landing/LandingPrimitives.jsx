/** Shared building blocks for the public landing page (see pages/LandingPage.jsx). */

import { Link } from 'react-router-dom';

export const CONTAINER = 'mx-auto w-full max-w-6xl px-4 sm:px-6';

/** Small uppercase monospace label (section eyebrows, diagram captions). */
export function Eyebrow({ children, className = '' }) {
  return <p className={`m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-lp-accent uppercase ${className}`}>{children}</p>;
}

/** Inline code-style token, e.g. organization_id. */
export function Code({ children }) {
  return <code className="rounded-[4px] border border-lp-line bg-lp-alt px-1 py-px font-mono text-[0.85em] text-lp-ink">{children}</code>;
}

export function SectionHeader({ id, eyebrow, title, children, className = '' }) {
  return (
    <div className={`max-w-2xl ${className}`}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 id={id} className="m-0 mt-3 text-[26px] leading-tight font-semibold tracking-tight text-lp-ink sm:text-[30px]">{title}</h2>
      {children && <div className="mt-3 text-base leading-relaxed text-lp-muted">{children}</div>}
    </div>
  );
}

/** Section wrapper: anchor id, top border, white or light-gray band. */
export function Section({ id, labelledBy, alt = false, children, className = '' }) {
  return (
    <section id={id} aria-labelledby={labelledBy}
      className={`scroll-mt-14 border-t border-lp-line ${alt ? 'bg-lp-alt' : 'bg-white'} ${className}`}>
      <div className={`${CONTAINER} py-16 sm:py-20`}>{children}</div>
    </section>
  );
}

/** Primary (solid accent) or secondary (bordered) button; router link or in-page anchor. */
export function LandingButton({ to, href, variant = 'primary', children, className = '', ...rest }) {
  const base = 'inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-lp px-4 text-sm font-medium no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lp-accent';
  const styles = variant === 'primary'
    ? 'bg-lp-accent text-white hover:bg-lp-accent-hover'
    : 'border border-lp-line bg-white text-lp-ink hover:bg-lp-alt';
  const cls = `${base} ${styles} ${className}`;
  return to
    ? <Link to={to} className={cls} {...rest}>{children}</Link>
    : <a href={href} className={cls} {...rest}>{children}</a>;
}
