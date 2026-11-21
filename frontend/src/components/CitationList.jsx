/** Sources for an assistant answer. Shows only user-facing fields from the backend. */

export function CitationList({ citations }) {
  if (!citations || citations.length === 0) return null;
  return (
    <div className="citations" aria-label="Sources">
      <p className="citations-title">Sources</p>
      <ol className="citation-list">
        {citations.map((c, i) => (
          <li key={c.id || `${c.documentId}-${c.chunkIndex}-${i}`} className="citation">
            <span className="citation-name">{c.documentName || 'Document'}</span>
            <span className="citation-meta">
              {c.page ? `Page ${c.page}` : null}
              {c.page && typeof c.chunkIndex === 'number' ? ' · ' : null}
              {typeof c.chunkIndex === 'number' ? `Section ${c.chunkIndex + 1}` : null}
              {typeof c.relevanceScore === 'number' ? ` · ${Math.round(c.relevanceScore * 100)}% match` : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
