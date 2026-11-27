import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureInvitationFromUrl, clearPendingInvitationToken, getPendingInvitationToken,
  isValidInvitationToken, setPendingInvitationFromLink,
} from '../invitations/invitationToken';

export const TOKEN = 'Tk_-abcdefghijklmnopqrstuvwxyz0123456789ABC'; // 43 base64url chars

beforeEach(() => {
  clearPendingInvitationToken();
  window.history.replaceState(null, '', '/');
});
afterEach(() => vi.restoreAllMocks());

describe('invitation token handling (memory only)', () => {
  it('accepts exactly 43 base64url characters', () => {
    expect(TOKEN).toHaveLength(43);
    expect(isValidInvitationToken(TOKEN)).toBe(true);
    expect(isValidInvitationToken(TOKEN.slice(1))).toBe(false);
    expect(isValidInvitationToken(`${TOKEN}A`)).toBe(false);
    expect(isValidInvitationToken(`${TOKEN.slice(1)}=`)).toBe(false);
    expect(isValidInvitationToken(`${TOKEN.slice(1)}+`)).toBe(false);
    expect(isValidInvitationToken(null)).toBe(false);
  });

  it('reads #token=, removes the fragment from the URL immediately and keeps the token in memory', () => {
    window.history.replaceState({ keep: 1 }, '', `/invite?x=1#token=${TOKEN}`);
    const replace = vi.spyOn(window.history, 'replaceState');
    expect(captureInvitationFromUrl()).toBe('captured');
    expect(replace).toHaveBeenCalledWith({ keep: 1 }, '', '/invite?x=1');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    expect(getPendingInvitationToken()).toBe(TOKEN);
    expect(JSON.stringify(window.history.state)).not.toContain(TOKEN);
  });

  it('never writes the token to localStorage or sessionStorage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    window.history.replaceState(null, '', `/invite#token=${TOKEN}`);
    captureInvitationFromUrl();
    setPendingInvitationFromLink(`https://app.example/invite#token=${TOKEN}`);
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(TOKEN);
  });

  it('strips a malformed token from the URL and does not keep it', () => {
    window.history.replaceState(null, '', '/invite#token=short');
    expect(captureInvitationFromUrl()).toBe('malformed');
    expect(window.location.hash).toBe('');
    expect(getPendingInvitationToken()).toBeNull();
  });

  it('ignores a URL without a token fragment and keeps an existing in-memory token', () => {
    setPendingInvitationFromLink(TOKEN);
    window.history.replaceState(null, '', '/invite');
    expect(captureInvitationFromUrl()).toBe('none');
    expect(getPendingInvitationToken()).toBe(TOKEN);
  });

  it('accepts a pasted invitation link or bare token, and nothing else', () => {
    expect(setPendingInvitationFromLink(`  https://app.example/invite#token=${TOKEN}  `)).toBe(true);
    expect(getPendingInvitationToken()).toBe(TOKEN);
    clearPendingInvitationToken();
    expect(setPendingInvitationFromLink('Acme Corp')).toBe(false);
    expect(setPendingInvitationFromLink(`https://app.example/invite?token=${TOKEN}`)).toBe(false);
    expect(setPendingInvitationFromLink('https://app.example/invite#token=abc')).toBe(false);
    expect(getPendingInvitationToken()).toBeNull();
  });
});
