import { Link } from 'react-router-dom';
import { LandingLogo } from './LandingIcons';
import { SECTION_LINKS } from './LandingNavbar';

const linkCls = 'text-sm text-lp-muted no-underline transition-colors hover:text-lp-ink';

export function LandingFooter() {
  return (
    <footer className="border-t border-lp-line bg-white">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:px-6">
        <div>
          <LandingLogo />
          <p className="m-0 mt-3 max-w-sm text-sm leading-relaxed text-lp-muted">
            A document intelligence platform: bring your organization’s documents together and get answers grounded
            in them, with sources.
          </p>
        </div>
        <nav aria-label="Product">
          <h2 className="m-0 text-sm font-semibold text-lp-ink">Product</h2>
          <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
            {SECTION_LINKS.map(l => <li key={l.href}><a href={l.href} className={linkCls}>{l.label}</a></li>)}
          </ul>
        </nav>
        <nav aria-label="Account">
          <h2 className="m-0 text-sm font-semibold text-lp-ink">Account</h2>
          <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
            <li><Link to="/login" className={linkCls}>Log in</Link></li>
            <li><Link to="/register" className={linkCls}>Sign up</Link></li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-lp-line">
        <p className="mx-auto my-0 max-w-6xl px-4 py-6 text-[13px] text-lp-muted sm:px-6">
          © {new Date().getFullYear()} DocuMind. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
