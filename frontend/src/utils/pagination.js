/** Helpers for the backend's page/limit list pagination ({ page, limit, totalCount, totalPages }). */

/** Append `next` to `prev`, dropping items already present (offset pages can shift between requests). */
export function mergeById(prev, next) {
  const seen = new Set(prev.map(item => item.id));
  const merged = [...prev];
  for (const item of next) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Whether another page exists after `page`.
 * @param {object} [pagination] the backend's pagination block for the last fetched page
 * @param {{ page: number, pageSize: number, received: number, loaded: number }} state
 */
export function hasMorePages(pagination, { page, pageSize, received, loaded }) {
  if (!received) return false;
  if (Number.isFinite(pagination?.totalPages)) return page < pagination.totalPages;
  if (Number.isFinite(pagination?.totalCount)) return loaded < pagination.totalCount;
  return received >= pageSize;
}
