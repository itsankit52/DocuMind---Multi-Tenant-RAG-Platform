/**
 * /settings — read-only overview of the organization, profile, security, usage and
 * integrations. Only settings that exist in DocuMind are shown; changes happen where they are
 * implemented (members/invitations for admins, /settings/account for sign-in methods).
 * No organization rename or preference endpoints exist, so none are offered.
 */

import { Link } from 'react-router-dom';
import { canManageMembers, canWrite, ROLE_LABELS, useAuth } from '../context/AuthContext';
import { useDocuments } from '../hooks/useDocuments';
import { PageHeader } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { GoogleLogo } from '../components/GoogleSignIn';
import { formatBytes, MAX_UPLOAD_MB } from '../utils/format';

const ROLE_SUMMARY = {
  admin: 'Manage members, roles and invitations, plus everything a member can do.',
  member: 'Upload, rename and delete documents; ask questions; manage conversations.',
  viewer: 'Read and download documents and ask questions. No changes.',
};

export function SettingsPage() {
  const { user, activeOrganization, organizations, role, googleSignInEnabled } = useAuth();
  const docs = useDocuments(activeOrganization?.organization_id, { limit: 100 });
  const methods = user?.authMethods || { password: false, google: false };
  const bytes = docs.documents.reduce((sum, d) => sum + (Number(d.file_size) || 0), 0);
  const partial = docs.totalCount > docs.documents.length;

  return (
    <div className="page">
      <PageHeader title="Settings" description="Your organization, profile and account security." />

      <Section id="org" title="Organization" description="The workspace you are signed in to.">
        <dl className="meta-grid">
          <Meta label="Organization name">{activeOrganization?.name}</Meta>
          <Meta label="Your role">{ROLE_LABELS[role] || '—'}</Meta>
          {activeOrganization?.slug && <Meta label="Identifier"><code className="font-mono text-[13px]">{activeOrganization.slug}</code></Meta>}
          <Meta label="Your organizations">{organizations.length}</Meta>
        </dl>
        <p className="muted small mb-0">{ROLE_SUMMARY[role]}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {canManageMembers(role) && (
            <>
              <Link to="/settings/members" className="btn btn-secondary btn-sm"><Icon name="users" size={14} /> Manage members</Link>
              <Link to="/settings/invitations" className="btn btn-secondary btn-sm"><Icon name="mail" size={14} /> Invitations</Link>
            </>
          )}
          <Link to="/onboarding" className="btn btn-secondary btn-sm"><Icon name="plus" size={14} /> New organization</Link>
        </div>
      </Section>

      <Section id="profile" title="Profile" description="How you appear to your organization.">
        <dl className="meta-grid">
          <Meta label="Name">{user?.fullName || '—'}</Meta>
          <Meta label="Email">{user?.email}</Meta>
        </dl>
      </Section>

      <Section id="security" title="Security" description="How you sign in to DocuMind.">
        <ul className="simple-list rounded-card border border-line px-4" aria-label="Sign-in methods">
          <li>
            <span className="list-icon"><Icon name="keyRound" /> Email and password</span>
            <span className={`badge ${methods.password ? 'badge-success' : 'badge-neutral'}`}>{methods.password ? 'Enabled' : 'Not set'}</span>
          </li>
          <li>
            <span className="list-icon"><GoogleLogo /> Google</span>
            <span className={`badge ${methods.google ? 'badge-success' : 'badge-neutral'}`}>{methods.google ? 'Linked' : 'Not linked'}</span>
          </li>
        </ul>
        <Link to="/settings/account" className="btn btn-secondary btn-sm mt-4">
          <Icon name="lock" size={14} /> Manage sign-in methods
        </Link>
      </Section>

      <Section id="usage" title="Usage" description="Documents stored in this organization.">
        <dl className="meta-grid">
          <Meta label="Documents">{docs.loading ? '…' : docs.totalCount}</Meta>
          <Meta label="Storage used">
            {docs.loading ? '…' : formatBytes(bytes)}
            {!docs.loading && partial && <span className="field-hint">Across the {docs.documents.length} most recent documents</span>}
          </Meta>
          <Meta label="Maximum file size">{MAX_UPLOAD_MB} MB</Meta>
          <Meta label="Supported formats">PDF, DOCX</Meta>
        </dl>
        {!canWrite(role) && <p className="muted small mb-0">Viewers can’t upload documents.</p>}
      </Section>

      {googleSignInEnabled && (
        <Section id="integrations" title="Integrations" description="Services connected to DocuMind.">
          <ul className="simple-list rounded-card border border-line px-4">
            <li>
              <span className="list-icon"><GoogleLogo /> <span>Google sign-in<span className="field-hint">Sign in with a Google account that uses your email.</span></span></span>
              <span className={`badge ${methods.google ? 'badge-success' : 'badge-neutral'}`}>{methods.google ? 'Connected' : 'Available'}</span>
            </li>
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ id, title, description, children }) {
  return (
    <section className="settings-section" aria-labelledby={`settings-${id}`}>
      <header>
        <h2 id={`settings-${id}`}>{title}</h2>
        <p>{description}</p>
      </header>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Meta({ label, children }) {
  return (
    <div className="min-w-0">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
