/**
 * Product previews for the landing page, built from the REAL application UI: the app's own CSS
 * classes (app-shell, sidebar, chat-page, message, table, …) and its own components
 * (MessageContent, CitationList, StatusBadge, format helpers), filled with clearly labelled
 * sample content. They mirror Layout.jsx, ChatPage.jsx, ConversationSidebar.jsx and
 * DocumentsPage.jsx, but are static: wrapped in `inert` + aria-hidden (a picture of the product,
 * described by the surrounding figcaption) and pinned to the app's light theme (.lp-app).
 */

import { MessageContent } from '../MessageContent';
import { CitationList } from '../CitationList';
import { StatusBadge } from '../Feedback';
import { Icon, LogoMark } from '../Icon';
import { fileTypeLabel, formatBytes, formatDateTime, formatTime } from '../../utils/format';

const NAV = [
  { section: 'Workspace', items: [['Dashboard', 'layoutDashboard'], ['Documents', 'fileText'], ['Chat', 'messageSquare']] },
  { section: 'Organization', items: [['Members', 'users'], ['Invitations', 'mail'], ['Settings', 'settings']] },
];
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Thin window frame around a preview; the label names the screen shown. */
export function PreviewFrame({ label, className = '', children }) {
  return (
    <div className={`min-w-0 overflow-hidden rounded-[10px] border border-lp-line bg-white ${className}`}>
      <div className="flex h-8 items-center gap-2 border-b border-lp-line bg-lp-alt px-3">
        <span aria-hidden="true" className="h-2 w-2 rounded-full border border-lp-line bg-white" />
        <span className="truncate font-mono text-[11px] text-lp-muted">{label}</span>
      </div>
      <div className="lp-app" inert aria-hidden="true">{children}</div>
    </div>
  );
}

/** Layout.jsx: sidebar (brand, organization switcher, nav, user) + header + main area. */
function AppShell({ active, height, children }) {
  return (
    <div className="app-shell" style={{ height }}>
      <div className="sidebar">
        <span className="brand brand-sidebar"><LogoMark size={24} /> DocuMind</span>
        <div className="org-switcher">
          <span className="field-label">Organization</span>
          <select className="input" value="acme" disabled onChange={() => {}}><option value="acme">NiXAt Tech</option></select>
        </div>
        {NAV.map(group => (
          <div key={group.section}>
            <p className="nav-section">{group.section}</p>
            <ul className="nav-list">
              {group.items.map(([label, icon]) => (
                <li key={label}><span className={`nav-link ${label === active ? 'active' : ''}`}><Icon name={icon} /> {label}</span></li>
              ))}
            </ul>
          </div>
        ))}
        <div className="sidebar-footer">
          <div className="user-box">
            <span className="avatar">AT</span>
            <span className="user-meta"><span className="user-name">Ankit Thakur</span></span>
          </div>
        </div>
      </div>
      <div className="app-main">
        <div className="app-header">
          <ol className="crumbs"><li>NiXAt Tech <Icon name="chevronRight" size={14} /></li><li><span aria-current="page">{active}</span></li></ol>
          <span className="badge badge-role badge-role-admin">Admin</span>
        </div>
        <div className="main">{children}</div>
      </div>
    </div>
  );
}

/** One chat message, as ChatPage.jsx renders a completed message. */
export function PreviewMessage({ role, content, citations, createdAt }) {
  const isUser = role === 'user';
  return (
    <article className={`message ${isUser ? 'message-user' : 'message-assistant'}`}>
      {!isUser && <span className="message-author"><LogoMark size={20} /> DocuAI</span>}
      <div className="message-bubble">
        {isUser ? <p className="message-text">{content}</p> : <MessageContent text={content} />}
        {!isUser && <CitationList citations={citations} />}
      </div>
      <div className="message-meta"><time dateTime={createdAt}>{formatTime(createdAt)}</time></div>
    </article>
  );
}

/** Conversations screen: conversation list + chat panel + composer. */
export function ChatScreen({ title, conversations, messages, height = 560 }) {
  return (
    <AppShell active="Chat" height={height}>
      <div className="chat-page">
        <div className="conv-sidebar">
          <div className="conv-sidebar-header">
            <p className="m-0 text-[13px] font-semibold">Conversations</p>
            <span className="btn btn-primary btn-sm"><Icon name="plus" size={14} /> New</span>
          </div>
          <ul className="conv-list">
            {conversations.map((c, i) => (
              <li key={c.title} className={`conv-item ${i === 0 ? 'active' : ''}`}>
                <span className="conv-link">
                  <span className="truncate">{c.title}</span>
                  <span className="muted small">{formatDateTime(c.updatedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="chat-panel">
          <div className="chat-header"><p className="m-0 truncate text-[15px] font-semibold">{title}</p></div>
          <div className="message-list">
            {messages.map(m => <PreviewMessage key={m.createdAt + m.role} {...m} />)}
          </div>
          <div className="composer">
            <div className="composer-box">
              <textarea className="input composer-input" rows={1} disabled
                placeholder="Ask a question about your documents…" />
              <div className="composer-actions"><span className="btn btn-primary">Send</span></div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/** Documents screen (DocumentsPage.jsx): header + documents table; `columns` crops the table. */
export function DocumentsScreen({ documents, columns = ['name', 'type', 'size', 'status', 'uploaded'], height, shell = true }) {
  const pending = documents.filter(d => d.status === 'uploaded' || d.status === 'processing').length;
  const cells = {
    name: ['Document name', d => <span><Icon name="fileText" className="text-muted" /><span className="truncate">{d.filename}</span></span>, 'cell-name'],
    type: ['Type', d => fileTypeLabel(d.mime_type)],
    size: ['Size', d => formatBytes(d.file_size)],
    status: ['Processing status', d => <StatusBadge status={d.status} />],
    uploaded: ['Uploaded', d => formatDateTime(d.created_at)],
  };
  const page = (
    <div className="page">
      <div className="page-header">
        <div>
          <p className="m-0 text-[22px] font-semibold">Documents</p>
          <p className="muted m-0 mt-1.5">
            {documents.length} documents{pending > 0 && ` · ${pending} processing (updates automatically)`}
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr>{columns.map(c => <th key={c} scope="col">{cells[c][0]}</th>)}</tr></thead>
          <tbody>
            {documents.map(d => (
              <tr key={d.filename}>{columns.map(c => <td key={c} className={cells[c][2]}>{cells[c][1](d)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
  return shell ? <AppShell active="Documents" height={height}>{page}</AppShell> : page;
}

// ── Sample workspace (illustrative content, labelled as such where shown) ────────────────
export const SAMPLE_DOCUMENTS = [
  { filename: 'Employee Handbook 2026.pdf', mime_type: PDF, file_size: 2_310_000, status: 'ready', created_at: '2026-11-18T09:12:00Z' },
  { filename: 'Records Retention Policy.docx', mime_type: DOCX, file_size: 184_000, status: 'ready', created_at: '2026-11-18T09:15:00Z' },
  { filename: 'Vendor Security Standard.pdf', mime_type: PDF, file_size: 961_000, status: 'ready', created_at: '2026-11-20T14:02:00Z' },
  { filename: 'Travel & Expense Policy.pdf', mime_type: PDF, file_size: 540_000, status: 'ready', created_at: '2026-11-24T08:40:00Z' },
  { filename: 'Q4 Board Minutes.docx', mime_type: DOCX, file_size: 92_000, status: 'processing', created_at: '2026-11-27T10:05:00Z' },
];
export { DOCX, PDF };
