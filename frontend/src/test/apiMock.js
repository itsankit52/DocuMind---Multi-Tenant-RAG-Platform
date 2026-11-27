/** vi.fn() stand-ins for every endpoint wrapper (used via vi.mock('../api/endpoints')). */
import { vi } from 'vitest';

export const authApi = { register: vi.fn(), login: vi.fn(), logout: vi.fn(), me: vi.fn() };
export const organizationApi = { create: vi.fn(), select: vi.fn(), listMembers: vi.fn(), saveMember: vi.fn() };
export const documentApi = {
  list: vi.fn(), get: vi.fn(), processing: vi.fn(), upload: vi.fn(),
  download: vi.fn(), rename: vi.fn(), remove: vi.fn(), reprocess: vi.fn(),
};
export const conversationApi = {
  list: vi.fn(), create: vi.fn(), get: vi.fn(), rename: vi.fn(), remove: vi.fn(), sendMessage: vi.fn(),
};
export const invitationApi = {
  create: vi.fn(), list: vi.fn(), revoke: vi.fn(), resend: vi.fn(), preview: vi.fn(), accept: vi.fn(),
};
