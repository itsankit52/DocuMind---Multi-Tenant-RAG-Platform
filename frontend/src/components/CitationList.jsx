/**
 * Sources for an assistant answer. Shows only user-facing fields from the backend; a source with
 * a documentId links to that document's details page (the backend re-checks access).
 */

import { Link } from 'react-router-dom';
import { Icon } from './Icon';

function meta(c) {
  return [
    c.page ? `Page ${c.page}` : null,
    typeof c.chunkIndex === 'number' ? `Section ${c.chunkIndex + 1}` : null,
  ].filter(Boolean).join(' · ')
    + (typeof c.relevanceScore === 'number' ? ` · ${Math.round(c.relevanceScore * 100)}% match` : '');
}

export function CitationList({ citations }) {
  if (!citations || citations.length === 0) return null;
  return (
    <div className="citations" aria-label="Sources">
      <p className="citations-title">Sources</p>
      <ol className="citation-list">
        {citations.map((c, i) => {
          const body = (
            <>
              <span className="citation-num" aria-hidden="true">{i + 1}</span>
              <span className="citation-body">
                <span className="citation-name inline-flex items-center gap-1.5">
                  <Icon name="fileText" size={13} className="text-muted" />
                  <span className="truncate">{c.documentName || 'Document'}</span>
                </span>
                <span className="citation-meta">{meta(c)}</span>
              </span>
            </>
          );
          return (
            <li key={c.id || `${c.documentId}-${c.chunkIndex}-${i}`} className="citation">
              {c.documentId ? <Link to={`/documents/${encodeURIComponent(c.documentId)}`}>{body}</Link> : <span>{body}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
