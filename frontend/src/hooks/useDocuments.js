/**
 * Documents for the active organization, with status polling while any document is
 * queued/processing. Polling uses the existing list endpoint (one request per tick),
 * stops when nothing is pending, backs off on errors, and is cleared on unmount.
 *
 * Pages are fetched with the backend's page/limit pagination; "load more" appends the next
 * page and a reload/poll refreshes every page loaded so far. Switching organization resets
 * the list and discards any response still in flight for the previous organization.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { documentApi } from '../api/endpoints';
import { isDocumentPending } from '../utils/format';
import { hasMorePages, mergeById } from '../utils/pagination';

export const POLL_INTERVAL_MS = 3000;
const MAX_POLL_INTERVAL_MS = 15000;
const MAX_POLL_ERRORS = 5;

export function useDocuments(organizationId, { limit = 50, pollIntervalMs = POLL_INTERVAL_MS } = {}) {
  const [documents, setDocuments] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const timer = useRef(null);
  const pollErrors = useRef(0);
  const active = useRef(true);
  const requestSeq = useRef(0);
  const pagesLoaded = useRef(1);
  const loadingMoreRef = useRef(false);
  const docsRef = useRef(documents);
  docsRef.current = documents;

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const load = useCallback(async ({ silent = false } = {}) => {
    const seq = ++requestSeq.current;
    if (!silent) setLoading(true);
    try {
      const pages = pagesLoaded.current;
      const results = await Promise.all(
        Array.from({ length: pages }, (_, i) => documentApi.list({ page: i + 1, limit })),
      );
      if (!active.current || seq !== requestSeq.current) return null;
      const docs = mergeById([], results.flatMap(r => r?.documents || []));
      const last = results[results.length - 1];
      const total = last?.pagination?.totalCount ?? docs.length;
      setDocuments(docs);
      setTotalCount(total);
      setHasMore(hasMorePages(last?.pagination, {
        page: pages, pageSize: limit, received: last?.documents?.length || 0, loaded: docs.length,
      }));
      setError(null);
      pollErrors.current = 0;
      return docs;
    } catch (err) {
      if (!active.current || seq !== requestSeq.current) return null;
      if (!silent) setError(err);
      pollErrors.current += 1;
      return null;
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
      const result = await documentApi.list({ page, limit });
      if (!active.current || seq !== requestSeq.current) return;
      const next = result?.documents || [];
      pagesLoaded.current = page;
      setDocuments(prev => mergeById(prev, next));
      const total = result?.pagination?.totalCount;
      if (Number.isFinite(total)) setTotalCount(total);
      setHasMore(hasMorePages(result?.pagination, {
        page, pageSize: limit, received: next.length, loaded: mergeById(docsRef.current, next).length,
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

  // Schedule the next poll only while something is still processing
  useEffect(() => {
    clearTimer();
    const pending = documents.some(d => isDocumentPending(d.status));
    if (!pending || pollErrors.current >= MAX_POLL_ERRORS) return undefined;
    const delay = Math.min(pollIntervalMs * 2 ** pollErrors.current, MAX_POLL_INTERVAL_MS);
    timer.current = setTimeout(async () => {
      const docs = await load({ silent: true });
      if (docs === null && active.current) {
        // keep polling with backoff after a failed tick
        setDocuments(prev => [...prev]);
      }
    }, delay);
    return clearTimer;
  }, [documents, load, pollIntervalMs]);

  useEffect(() => {
    active.current = true;
    // Never show the previous organization's documents while the new list loads
    requestSeq.current += 1;
    pagesLoaded.current = 1;
    pollErrors.current = 0;
    setDocuments([]);
    setTotalCount(0);
    setHasMore(false);
    setError(null);
    if (organizationId) load();
    return () => {
      active.current = false;
      clearTimer();
    };
  }, [organizationId, load]);

  const upload = useCallback(async (file, onProgress) => {
    const result = await documentApi.upload(file, { onProgress });
    await load({ silent: true });
    return result?.document;
  }, [load]);

  const rename = useCallback(async (id, filename) => {
    const result = await documentApi.rename(id, filename);
    const updated = result?.document;
    if (updated) setDocuments(prev => prev.map(d => (d.id === id ? { ...d, ...updated } : d)));
    return updated;
  }, []);

  const remove = useCallback(async (id) => {
    await documentApi.remove(id);
    setDocuments(prev => prev.filter(d => d.id !== id));
    setTotalCount(c => Math.max(0, c - 1));
  }, []);

  const reprocess = useCallback(async (id) => {
    await documentApi.reprocess(id);
    await load({ silent: true });
  }, [load]);

  return {
    documents, totalCount, loading, error, hasMore, loadingMore,
    reload: load, loadMore, upload, rename, remove, reprocess,
  };
}

/** Trigger a browser download of a document fetched with the tenant header. */
export async function downloadDocument(doc) {
  const res = await documentApi.download(doc.id);
  const url = URL.createObjectURL(res.data);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.original_name || doc.filename || 'document';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
