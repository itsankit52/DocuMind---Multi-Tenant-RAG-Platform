import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConversations } from '../hooks/useConversations';
import { useDocuments } from '../hooks/useDocuments';
import { conversationApi, documentApi } from './apiMock';
import { deferred, mockSignedIn, renderApp, resetApiMocks } from './utils';

vi.mock('../api/endpoints', () => import('./apiMock'));

const conv = (id) => ({ id, title: `Conversation ${id}`, updated_at: '2026-09-20T10:00:00Z' });
const doc = (id) => ({
  id, filename: `${id}.pdf`, original_name: `${id}.pdf`, mime_type: 'application/pdf',
  file_size: 1024, status: 'ready', created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z',
});
const page = (key, items, { page: p, limit, totalCount }) => ({
  [key]: items, pagination: { page: p, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
});

beforeEach(() => {
  resetApiMocks();
  mockSignedIn();
});

describe('Organization switch', () => {
  it('a slow conversation list for the previous org cannot overwrite the new org\'s list', async () => {
    const slowA = deferred();
    conversationApi.list.mockImplementation(() => slowA.promise);
    const { result, rerender } = renderHook(({ org }) => useConversations(org), { initialProps: { org: 'org-a' } });

    conversationApi.list.mockResolvedValue({ conversations: [conv('b1')] });
    rerender({ org: 'org-b' });
    await waitFor(() => expect(result.current.conversations.map(c => c.id)).toEqual(['b1']));

    await act(async () => { slowA.resolve({ conversations: [conv('a1'), conv('a2')] }); });
    expect(result.current.conversations.map(c => c.id)).toEqual(['b1']);
    expect(result.current.loading).toBe(false);
  });

  it('clears the previous org\'s conversations and documents as soon as the org changes', async () => {
    conversationApi.list.mockResolvedValue({ conversations: [conv('a1')] });
    documentApi.list.mockResolvedValue({ documents: [doc('a-doc')], pagination: { totalCount: 1 } });
    const convs = renderHook(({ org }) => useConversations(org), { initialProps: { org: 'org-a' } });
    const docs = renderHook(({ org }) => useDocuments(org), { initialProps: { org: 'org-a' } });
    await waitFor(() => expect(convs.result.current.conversations).toHaveLength(1));
    await waitFor(() => expect(docs.result.current.documents).toHaveLength(1));

    conversationApi.list.mockReturnValue(new Promise(() => {}));
    documentApi.list.mockReturnValue(new Promise(() => {}));
    convs.rerender({ org: 'org-b' });
    docs.rerender({ org: 'org-b' });
    expect(convs.result.current.conversations).toEqual([]);
    expect(docs.result.current.documents).toEqual([]);
    expect(docs.result.current.totalCount).toBe(0);
  });
});

describe('Load more', () => {
  it('useConversations fetches the next page and appends it without duplicates', async () => {
    conversationApi.list
      .mockResolvedValueOnce(page('conversations', [conv('c1'), conv('c2')], { page: 1, limit: 2, totalCount: 3 }))
      .mockResolvedValueOnce(page('conversations', [conv('c2'), conv('c3')], { page: 2, limit: 2, totalCount: 3 }));
    const { result } = renderHook(() => useConversations('org-a', { limit: 2 }));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(() => result.current.loadMore());
    expect(conversationApi.list).toHaveBeenLastCalledWith({ page: 2, limit: 2 });
    expect(result.current.conversations.map(c => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(result.current.hasMore).toBe(false);
  });

  it('the Documents page shows "Load more" beyond the first page and appends the next one', async () => {
    documentApi.list.mockImplementation(({ page: p }) => Promise.resolve(p === 1
      ? page('documents', Array.from({ length: 50 }, (_, i) => doc(`d${i}`)), { page: 1, limit: 50, totalCount: 51 })
      : page('documents', [doc('d50')], { page: 2, limit: 50, totalCount: 51 })));
    renderApp('/documents');
    const button = await screen.findByRole('button', { name: /Load more \(50 of 51 shown\)/ });
    expect(screen.queryByText('d50.pdf')).not.toBeInTheDocument();

    await userEvent.setup().click(button);
    expect(await screen.findByText('d50.pdf')).toBeInTheDocument();
    expect(documentApi.list).toHaveBeenLastCalledWith({ page: 2, limit: 50 });
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument();
  });

  it('the conversation sidebar offers "Load more conversations" when more pages exist', async () => {
    conversationApi.list.mockImplementation(({ page: p }) => Promise.resolve(p === 1
      ? page('conversations', Array.from({ length: 50 }, (_, i) => conv(`c${i}`)), { page: 1, limit: 50, totalCount: 51 })
      : page('conversations', [conv('c50')], { page: 2, limit: 50, totalCount: 51 })));
    renderApp('/chat');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Load more conversations' }));
    expect(await screen.findByText('Conversation c50')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more conversations' })).not.toBeInTheDocument();
  });
});
