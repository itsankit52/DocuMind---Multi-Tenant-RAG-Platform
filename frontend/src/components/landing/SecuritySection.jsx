/**
 * Security and architecture, written for customers. Every point is implemented:
 * FORCE ROW LEVEL SECURITY on tenant tables with app.current_tenant set per transaction;
 * tenant middleware (membership) + RBAC (admin/member/viewer); Qdrant search that requires an
 * organization filter; MinIO keys under organizations/{id}/ served only through the API; uploads
 * checked by content signature and size, queued through a transactional outbox to RabbitMQ and
 * processed by a separate worker with its own restricted database role. No certifications claimed.
 */

import { Section, SectionHeader } from './LandingPrimitives';

const POINTS = [
  {
    title: 'PostgreSQL Row Level Security',
    text: 'The database itself checks which organization every record belongs to. Documents, passages, conversations, messages and invitations are only returned for the organization a request is working in — a safeguard beneath the application’s own checks.',
  },
  {
    title: 'Organization-level data isolation',
    text: 'Every request runs in the context of one organization the person belongs to. Search, documents and conversations are always scoped to it — including the vector index used to find relevant passages.',
  },
  {
    title: 'Role-based access control',
    text: 'Admins manage members and invitations, members upload and manage documents, and viewers can read and ask questions. Membership is verified before any organization data is touched.',
  },
  {
    title: 'Tenant-aware document storage',
    text: 'Files are kept in private object storage under each organization’s own path, and are only delivered through DocuMind after a membership and role check — never through public links.',
  },
  {
    title: 'Secure document processing pipeline',
    text: 'Uploads are checked to be genuine PDF or DOCX files within the size limit, then processed by a separate background worker with its own restricted database access. Jobs are recorded before they are queued, so none are lost if the queue is briefly unavailable.',
  },
];

const PIPELINE = ['upload', 'checks', 'private storage', 'queue', 'worker', 'search index'];

export function SecuritySection() {
  return (
    <Section id="security" labelledBy="security-title" alt>
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-5">
          <SectionHeader id="security-title" eyebrow="Security & architecture" title="Built for organizational knowledge.">
            <p className="m-0">
              Many organizations can share one DocuMind installation without ever seeing each other’s data.
              Separation is enforced at several layers — the database, the search index, file storage and the API.
            </p>
          </SectionHeader>
          <div className="mt-8 rounded-lp border border-lp-line bg-white p-4">
            <p className="m-0 font-mono text-[11px] tracking-[0.08em] text-lp-muted uppercase">Document pipeline</p>
            <ol className="m-0 mt-3 flex list-none flex-wrap items-center gap-x-1.5 gap-y-2 p-0 font-mono text-[12px] text-lp-ink">
              {PIPELINE.map((s, i) => (
                <li key={s} className="flex items-center gap-1.5">
                  <span className="rounded-[4px] border border-lp-line px-1.5 py-0.5">{s}</span>
                  {i < PIPELINE.length - 1 && <span aria-hidden="true" className="text-lp-muted">→</span>}
                </li>
              ))}
            </ol>
          </div>
        </div>
        <dl className="m-0 border-t border-lp-line lg:col-span-7 lg:col-start-6">
          {POINTS.map(p => (
            <div key={p.title} className="grid gap-2 border-b border-lp-line py-6 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:gap-8">
              <dt className="text-[15px] font-semibold text-lp-ink">{p.title}</dt>
              <dd className="m-0 text-[14.5px] leading-relaxed text-lp-muted">{p.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}
