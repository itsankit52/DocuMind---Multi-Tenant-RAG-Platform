/**
 * Conversation list for the active organization. The backend list is authoritative;
 * local updates after create/rename/delete only mirror successful server responses.
 *
 * Pages use the backend's page/limit pagination ("load more" appends the next page).
 * Switching organization resets the list, and a request sequence discards any response
 * still in flight for the previous organization so it cannot overwrite the new list.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { conversationApi } from '../api/endpoints';
import { hasMorePages, mergeById } from '../utils/pagination';

export function useConversations(organizationId, { limit = 50 } = {}) {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const active = useRef(true);
  const requestSeq = useRef(0);
  const pagesLoaded = useRef(1);
  const loadingMoreRef = useRef(false);
  const listRef = useRef(conversations);
  listRef.current = conversations;

  const load = useCallback(async ({ silent = false } = {}) => {
    const seq = ++requestSeq.current;
    if (!silent) setLoading(true);
    try {
      const pages = pagesLoaded.current;
      const results = await Promise.all(
        Array.from({ length: pages }, (_, i) => conversationApi.list({ page: i + 1, limit })),
      );
      if (!active.current || seq !== requestSeq.current) return;
      const list = mergeById([], results.flatMap(r => r?.conversations || []));
      const last = results[results.length - 1];
      setConversations(list);
      setHasMore(hasMorePages(last?.pagination, {
        page: pages, pageSize: limit, received: last?.conversations?.length || 0, loaded: list.length,
      }));
      setError(null);
    } catch (err) {
      if (active.current && seq === requestSeq.current && !silent) setError(err);
    } finally {
      if (active.current && seq === requestSeq.current && !silent) setLoading(false);
    }
  }, [limit]);

  /** Append the next page. Superseded (reload / org switch) responses are discarded. */
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const seq = ++requestSeq.current;
    const page = pagesLoaded.current + 1;
    setLoadingMore(true);
    try {
      const result = await conversationApi.list({ page, limit });
      if (!active.current || seq !== requestSeq.current) return;
      const next = result?.conversations || [];
      pagesLoaded.current = page;
      setConversations(prev => mergeById(prev, next));
      setHasMore(hasMorePages(result?.pagination, {
        page, pageSize: limit, received: next.length, loaded: mergeById(listRef.current, next).length,
      }));
      setError(null);
    } catch (err) {
      if (active.current && seq === requestSeq.current) setError(err);
    } finally {
      loadingMoreRef.current = false;
      if (active.current) setLoadingMore(false);
      // This request superseded any in-flight reload, whose own finally will not clear `loading`
      if (active.current && seq === requestSeq.current) setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    active.current = true;
    // Never show the previous organization's conversations while the new list loads
    requestSeq.current += 1;
    pagesLoaded.current = 1;
    setConversations([]);
    setHasMore(false);
    setError(null);
    if (organizationId) load();
    return () => { active.current = false; };
  }, [organizationId, load]);

  const create = useCallback(async (title) => {
    const result = await conversationApi.create(title);
    const conv = result?.conversation;
    if (conv) setConversations(prev => [conv, ...prev.filter(c => c.id !== conv.id)]);
    return conv;
  }, []);

  const rename = useCallback(async (id, title) => {
    const result = await conversationApi.rename(id, title);
    const conv = result?.conversation;
    if (conv) setConversations(prev => prev.map(c => (c.id === id ? { ...c, ...conv } : c)));
    return conv;
  }, []);

  const remove = useCallback(async (id) => {
    await conversationApi.remove(id);
    setConversations(prev => prev.filter(c => c.id !== id));
  }, []);

  /** Move a conversation to the top after activity (server also bumps updated_at). */
  const touch = useCallback((id) => {
    setConversations(prev => {
      const found = prev.find(c => c.id === id);
      if (!found) return prev;
      return [{ ...found, updated_at: new Date().toISOString() }, ...prev.filter(c => c.id !== id)];
    });
  }, []);

  return {
    conversations, loading, error, hasMore, loadingMore,
    reload: load, loadMore, create, rename, remove, touch,
  };
}
