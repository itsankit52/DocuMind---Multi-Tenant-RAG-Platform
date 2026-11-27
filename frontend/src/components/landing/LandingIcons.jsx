/**
 * Landing page icons: the shared Lucide set (components/Icon.jsx) plus the DocuMind wordmark.
 */

import { Icon } from '../Icon';

export { Icon };

/** DocuMind mark + wordmark (solid accent square with the document icon). */
export function LandingLogo({ className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight text-lp-ink ${className}`}>
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] bg-lp-accent text-white">
        <Icon name="fileText" size={16} />
      </span>
      DocuMind
    </span>
  );
}
