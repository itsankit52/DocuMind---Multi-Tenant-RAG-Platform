/**
 * Authentication + active-organization state.
 *
 * Identity comes from GET /api/auth/me (cookie session). No token is ever read or stored.
 * The active organization is chosen only among memberships the backend returned, and a
 * switch is confirmed by POST /api/organizations/:id/select. The backend still validates
 * membership and role on every request.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { authApi, organizationApi } from '../api/endpoints';
import { setActiveOrganizationId, setSessionExpiredHandler } from '../api/client';

const AuthContext = createContext(null);
const ORG_PREF_KEY = 'documind.activeOrganization'; // non-secret UI preference only

function readOrgPreference() {
  try { return window.localStorage.getItem(ORG_PREF_KEY); } catch { return null; }
}
function writeOrgPreference(id) {
  try {
    if (id) window.localStorage.setItem(ORG_PREF_KEY, id);
    else window.localStorage.removeItem(ORG_PREF_KEY);
  } catch { /* storage unavailable */ }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [organizations, setOrganizations] = useState([]);
  const [activeOrgId, setActiveOrgId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const mounted = useRef(true);
  // Whether a signed-in user was loaded. "Session expired" is only meaningful for a user who
  // had a session: an anonymous first visit also 401s on /auth/me (and on the refresh attempt).
  const hadUser = useRef(false);

  const applyOrganization = useCallback((id) => {
    setActiveOrganizationId(id);
    setActiveOrgId(id);
    writeOrgPreference(id);
  }, []);

  const clearSession = useCallback(() => {
    hadUser.current = false;
    setUser(null);
    setOrganizations([]);
    setActiveOrganizationId(null);
    setActiveOrgId(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const result = await authApi.me();
      if (!mounted.current) return null;
      const orgs = result?.organizations || [];
      hadUser.current = !!result?.user;
      setUser(result?.user || null);
      setOrganizations(orgs);
      setSessionExpired(false);
      const preferred = readOrgPreference();
      const current = orgs.find(o => o.organization_id === preferred) || orgs[0] || null;
      applyOrganization(current ? current.organization_id : null);
      return result;
    } catch (err) {
      if (mounted.current) {
        const expired = err.status === 401 && hadUser.current;
        clearSession();
        if (expired) setSessionExpired(true);
      }
      if (err.status && err.status !== 401) throw err;
      return null;
    }
  }, [applyOrganization, clearSession]);

  useEffect(() => {
    mounted.current = true;
    setSessionExpiredHandler(() => {
      const expired = hadUser.current;
      clearSession();
      if (expired) setSessionExpired(true);
    });
    refreshUser()
      .catch(() => {})
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => {
      mounted.current = false;
      setSessionExpiredHandler(null);
    };
  }, [refreshUser, clearSession]);

  const login = useCallback(async (email, password) => {
    await authApi.login({ email, password });
    await refreshUser();
  }, [refreshUser]);

  const register = useCallback(async ({ email, password, fullName }) => {
    await authApi.register({ email, password, fullName: fullName || undefined });
    await authApi.login({ email, password });
    await refreshUser();
  }, [refreshUser]);

  const logout = useCallback(async () => {
    try { await authApi.logout(); } catch { /* clear local state regardless */ }
    writeOrgPreference(null); // an explicit sign-out forgets this browser's org preference
    clearSession();
    setSessionExpired(false);
  }, [clearSession]);

  const selectOrganization = useCallback(async (id) => {
    await organizationApi.select(id); // backend confirms active membership
    applyOrganization(id);
  }, [applyOrganization]);

  const createOrganization = useCallback(async ({ name, slug }) => {
    const created = await organizationApi.create({ name, slug });
    writeOrgPreference(created?.org?.id);
    await refreshUser();
  }, [refreshUser]);

  /**
   * After an invitation was accepted: reload memberships from the backend and make the
   * joined organization active (same convention as createOrganization). Other memberships
   * are untouched; the organization is only selected if the backend lists it.
   */
  const joinOrganization = useCallback(async (organizationId) => {
    writeOrgPreference(organizationId);
    await refreshUser();
  }, [refreshUser]);

  const activeOrganization = useMemo(
    () => organizations.find(o => o.organization_id === activeOrgId) || null,
    [organizations, activeOrgId],
  );

  const value = useMemo(() => ({
    user,
    organizations,
    activeOrganization,
    role: activeOrganization?.role || null,
    isAuthenticated: !!user,
    loading,
    sessionExpired,
    login,
    register,
    logout,
    refreshUser,
    selectOrganization,
    createOrganization,
    joinOrganization,
  }), [user, organizations, activeOrganization, loading, sessionExpired,
    login, register, logout, refreshUser, selectOrganization, createOrganization, joinOrganization]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

// ─── Role helpers ─────────────────────────────────────────────────────────────
// UX/navigation hints only. They are NOT a security boundary: every action is
// authorized again by the backend, which rejects anything the role doesn't allow.

export const ROLES = ['admin', 'member', 'viewer'];
export const ROLE_LABELS = { admin: 'Admin', member: 'Member', viewer: 'Viewer' };

/** Upload, rename, delete documents; rename/delete conversations. */
export function canWrite(role) {
  return role === 'admin' || role === 'member';
}

/** Organization settings: member list and role management. */
export function canManageMembers(role) {
  return role === 'admin';
}
