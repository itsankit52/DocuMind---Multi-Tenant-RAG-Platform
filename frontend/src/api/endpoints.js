/**
 * Typed wrappers over the existing backend routes (see backend/API.md).
 * Every function resolves to the `data` payload of the backend's success envelope.
 */

import { http } from './client';

const data = (res) => res.data?.data;

export const authApi = {
  register: (body) => http.post('/auth/register', body, { skipAuthRefresh: true, skipOrgHeader: true }).then(data),
  login: (body) => http.post('/auth/login', body, { skipAuthRefresh: true, skipOrgHeader: true }).then(data),
  logout: () => http.post('/auth/logout', null, { skipAuthRefresh: true, skipOrgHeader: true }),
  // /auth/me returns { user, organizations } (active memberships only)
  me: (config = {}) => http.get('/auth/me', { skipOrgHeader: true, ...config }).then(data),
};

export const organizationApi = {
  create: (body) => http.post('/organizations', body, { skipOrgHeader: true }).then(data),
  // Server-side membership validation before switching the active organization
  select: (organizationId) => http.post(`/organizations/${encodeURIComponent(organizationId)}/select`, null, { skipOrgHeader: true }).then(data),
  // Admin-only on the backend (403 otherwise). Returns active members: { id, email, full_name, role, status, created_at }
  listMembers: (organizationId) => http.get(`/organizations/${encodeURIComponent(organizationId)}/members`, { skipOrgHeader: true }).then(data),
  // Admin-only upsert: adds a registered user by email, or changes an existing member's role
  saveMember: (organizationId, { email, role }) =>
    http.post(`/organizations/${encodeURIComponent(organizationId)}/members`, { email, role }, { skipOrgHeader: true }).then(data),
};

export const documentApi = {
  list: ({ page = 1, limit = 50 } = {}, config = {}) =>
    http.get('/documents', { params: { page, limit }, ...config }).then(data),
  get: (id) => http.get(`/documents/${encodeURIComponent(id)}`).then(data),
  processing: (id) => http.get(`/documents/${encodeURIComponent(id)}/processing`).then(data),
  upload: (file, { onProgress, signal } = {}) => {
    const form = new FormData();
    form.append('file', file);
    return http.post('/documents', form, {
      signal,
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    }).then(data);
  },
  download: (id) => http.get(`/documents/${encodeURIComponent(id)}/download`, { responseType: 'blob' }),
  rename: (id, filename) => http.patch(`/documents/${encodeURIComponent(id)}`, { filename }).then(data),
  remove: (id) => http.delete(`/documents/${encodeURIComponent(id)}`),
  reprocess: (id) => http.post(`/documents/${encodeURIComponent(id)}/reprocess`).then(data),
};

export const conversationApi = {
  list: ({ page = 1, limit = 50 } = {}, config = {}) =>
    http.get('/conversations', { params: { page, limit }, ...config }).then(data),
  create: (title) => http.post('/conversations', title ? { title } : {}).then(data),
  // { conversation, messages[] } — assistant messages include persisted `citations`
  get: (id, config = {}) => http.get(`/conversations/${encodeURIComponent(id)}`, config).then(data),
  rename: (id, title) => http.patch(`/conversations/${encodeURIComponent(id)}`, { title }).then(data),
  remove: (id) => http.delete(`/conversations/${encodeURIComponent(id)}`),
  // Non-streaming Step 9 endpoint (kept for completeness; the UI streams)
  sendMessage: (id, content) => http.post(`/conversations/${encodeURIComponent(id)}/messages`, { content }).then(data),
};
