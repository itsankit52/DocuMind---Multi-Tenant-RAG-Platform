import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, LandingLogo } from './LandingIcons';
import { LandingButton } from './LandingPrimitives';

// In-page sections only: DocuMind has no public documentation page to link to.
export const SECTION_LINKS = [
  { href: '#product', label: 'Product' },
  { href: '#how-it-works', label: 'How It Works' },
  { href: '#security', label: 'Security' },
];

export function LandingNavbar() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onResize = () => { if (window.innerWidth >= 768) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
  }, [open]);

  const navLink = 'rounded-[6px] px-3 py-1.5 text-sm text-lp-muted no-underline transition-colors hover:text-lp-ink';

  return (
    <header className="sticky top-0 z-30 border-b border-lp-line bg-white">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6" aria-label="Main">
        <Link to="/" className="no-underline" aria-label="DocuMind home"><LandingLogo /></Link>

        <ul className="m-0 hidden list-none items-center gap-1 p-0 md:flex">
          {SECTION_LINKS.map(l => <li key={l.href}><a href={l.href} className={navLink}>{l.label}</a></li>)}
        </ul>

        <div className="hidden items-center gap-1 md:flex">
          <Link to="/login" className={navLink}>Log in</Link>
          <LandingButton to="/register" className="h-8 px-3">Get Started</LandingButton>
        </div>

        <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-lp border border-lp-line bg-white text-lp-ink md:hidden"
          aria-expanded={open} aria-controls="landing-mobile-menu" aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen(o => !o)}>
          <Icon name={open ? 'x' : 'menu'} size={18} />
        </button>
      </nav>

      {open && (
        <div id="landing-mobile-menu" className="border-t border-lp-line bg-white px-4 pb-4 md:hidden">
          <ul className="m-0 list-none p-0 py-1">
            {SECTION_LINKS.map(l => (
              <li key={l.href}>
                <a href={l.href} onClick={() => setOpen(false)}
                  className="block border-b border-lp-line py-3 text-[15px] text-lp-ink no-underline">{l.label}</a>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-2 pt-3">
            <LandingButton to="/login" variant="secondary">Log in</LandingButton>
            <LandingButton to="/register">Get Started</LandingButton>
          </div>
        </div>
      )}
    </header>
  );
}
