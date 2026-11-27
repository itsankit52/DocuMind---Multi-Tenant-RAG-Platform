import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCanonicalOrigin, resolveInvitationLink } from '../invitations/invitationLink';

const TOKEN = 'Tk_-abcdefghijklmnopqrstuvwxyz0123456789ABC';
const PROD = { allowCurrentOrigin: false, production: true, currentOrigin: 'https://preview-123.example.net' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('invitation link selection', () => {
  it('prefers the backend inviteUrl when it is non-empty', () => {
    const inviteUrl = `https://docs.example.com/invite#token=${TOKEN}`;
    expect(resolveInvitationLink({ inviteUrl, token: TOKEN }, { ...PROD, configuredBase: 'https://other.example' })).toBe(inviteUrl);
    expect(resolveInvitationLink({ inviteUrl: '   ', token: TOKEN }, { ...PROD, configuredBase: 'https://app.example' }))
      .toBe(`https://app.example/invite#token=${TOKEN}`);
  });

  it('uses the configured canonical frontend URL when the backend gives none, normalizing a trailing slash', () => {
    expect(resolveInvitationLink({ inviteUrl: null, token: TOKEN }, { ...PROD, configuredBase: 'https://app.example/' }))
      .toBe(`https://app.example/invite#token=${TOKEN}`);
    expect(resolveInvitationLink({ token: TOKEN }, { ...PROD, configuredBase: '  https://app.example:8443  ' }))
      .toBe(`https://app.example:8443/invite#token=${TOKEN}`);
  });

  it('a production build never falls back to the current (possibly preview) origin or a guessed domain', () => {
    expect(resolveInvitationLink({ inviteUrl: null, token: TOKEN }, PROD)).toBeNull();
    expect(resolveInvitationLink({ inviteUrl: null, token: TOKEN }, { ...PROD, configuredBase: '' })).toBeNull();
  });

  it('the current origin is used only where allowed (the Vite dev server)', () => {
    expect(resolveInvitationLink({ token: TOKEN }, { allowCurrentOrigin: true, currentOrigin: 'http://localhost:5173' }))
      .toBe(`http://localhost:5173/invite#token=${TOKEN}`);
  });

  it('follows the build environment by default: dev server → current origin; production build → nothing', () => {
    vi.stubEnv('VITE_PUBLIC_APP_URL', '');
    vi.stubEnv('DEV', true);
    vi.stubEnv('PROD', false);
    expect(resolveInvitationLink({ token: TOKEN })).toBe(`${window.location.origin}/invite#token=${TOKEN}`);
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    expect(resolveInvitationLink({ token: TOKEN })).toBeNull();
    vi.stubEnv('VITE_PUBLIC_APP_URL', 'https://docs.example.com');
    expect(resolveInvitationLink({ token: TOKEN })).toBe(`https://docs.example.com/invite#token=${TOKEN}`);
  });

  it('rejects unsafe configured bases instead of building a link from them', () => {
    const bad = [
      'docs.example.com', 'ftp://docs.example.com', 'javascript:alert(1)', 'https://user:pw@docs.example.com',
      'https://docs.example.com/app', 'https://docs.example.com/?x=1', 'https://docs.example.com/#x',
      'https://docs.example.com\\evil', 'https://evil@docs.example.com',
    ];
    for (const configuredBase of bad) {
      expect(resolveInvitationLink({ token: TOKEN }, { ...PROD, configuredBase })).toBeNull();
    }
    expect(parseCanonicalOrigin('http://docs.example.com', { production: true })).toBeNull(); // https only in production
    expect(parseCanonicalOrigin('http://localhost:5173', { production: false })).toBe('http://localhost:5173');
  });

  it('keeps the token in the /invite#token= fragment, never in a query parameter, and logs nothing', () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map(m => vi.spyOn(console, m).mockImplementation(() => {}));
    const link = resolveInvitationLink({ token: TOKEN }, { ...PROD, configuredBase: 'https://app.example' });
    const url = new URL(link);
    expect(url.pathname).toBe('/invite');
    expect(url.hash).toBe(`#token=${TOKEN}`);
    expect(url.search).toBe('');
    expect(resolveInvitationLink({ token: TOKEN }, PROD)).toBeNull();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('without a token there is nothing to share', () => {
    expect(resolveInvitationLink({ inviteUrl: null, token: null }, { allowCurrentOrigin: true, currentOrigin: 'http://localhost:5173' })).toBeNull();
  });
});
