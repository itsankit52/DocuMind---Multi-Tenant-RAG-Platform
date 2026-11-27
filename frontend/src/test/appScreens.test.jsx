import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CitationList } from '../components/CitationList';
import { conversationApi, documentApi, organizationApi } from './apiMock';
import { mockSignedIn, renderApp, resetApiMocks, USER } from './utils';

vi.mock('../api/endpoints', () => import('./apiMock'));

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const doc = (over = {}) => ({
  id: 'd1', filename: 'policy.pdf', original_name: 'policy.pdf', mime_type: PDF, file_size: 1024 * 1024,
  status: 'ready', uploaded_by: USER.id, created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:05:00Z', ...over,
});

beforeEach(() => {
  resetApiMocks();
  mockSignedIn();
});

describe('Dashboard', () => {
  it('shows real totals from the list endpoints and the admin-only member count', async () => {
    documentApi.list.mockResolvedValue({ documents: [doc(), doc({ id: 'd2', filename: 'b.docx', mime_type: DOCX, status: 'processing' })], pagination: { totalCount: 2 } });
    conversationApi.list.mockResolvedValue({ conversations: [{ id: 'c1', title: 'Leave', updated_at: '2026-09-20T10:00:00Z' }], pagination: { totalCount: 7 } });
    organizationApi.listMembers.mockResolvedValue({ members: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] });
    renderApp('/');
    const stats = within(await screen.findByRole('region', { name: 'Organization statistics' }));
    expect(await stats.findByText('7')).toBeInTheDocument(); // conversations total from pagination
    expect(await stats.findByText('3')).toBeInTheDocument(); // members
    expect(stats.getByText('2')).toBeInTheDocument();
    expect(stats.getByText('1 ready · 1 processing')).toBeInTheDocument();
    expect(stats.getByText('2.0 MB')).toBeInTheDocument(); // sum of file sizes
  });

  it('non-admins see their role instead of a member count (members API is admin-only)', async () => {
    mockSignedIn({ role: 'viewer' });
    renderApp('/');
    const stats = within(await screen.findByRole('region', { name: 'Organization statistics' }));
    expect(stats.getByText('Your role')).toBeInTheDocument();
    expect(organizationApi.listMembers).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /Upload document/ })).not.toBeInTheDocument();
  });
});

describe('Documents filters', () => {
  it('searches, filters by type and status over the loaded documents', async () => {
    documentApi.list.mockResolvedValue({
      documents: [doc(), doc({ id: 'd2', filename: 'handbook.docx', mime_type: DOCX }), doc({ id: 'd3', filename: 'broken.pdf', status: 'failed' })],
      pagination: { totalCount: 3 },
    });
    const user = userEvent.setup();
    renderApp('/documents');
    expect(await screen.findAllByRole('row')).toHaveLength(4);
    await user.type(screen.getByLabelText('Search documents'), 'hand');
    expect(screen.getAllByRole('row')).toHaveLength(2);
    await user.clear(screen.getByLabelText('Search documents'));
    await user.selectOptions(screen.getByLabelText('File type'), 'PDF');
    await user.selectOptions(screen.getByLabelText('Processing status'), 'failed');
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText('broken.pdf')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View broken.pdf' })).toHaveAttribute('href', '/documents/d3');
  });
});

describe('Document details', () => {
  it('shows metadata, processing state and permitted actions', async () => {
    documentApi.get.mockResolvedValue({ document: doc() });
    documentApi.processing.mockResolvedValue({ documentStatus: 'ready', chunkCount: 12, job: { status: 'completed', stage: 'completed', attempts: 1, maxAttempts: 3 } });
    renderApp('/documents/d1');
    expect(await screen.findByRole('heading', { level: 1, name: 'policy.pdf' })).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument(); // uploaded by the signed-in user
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete/ })).toBeInTheDocument();
  });

  it('viewers get no modification actions; unknown documents show not found', async () => {
    mockSignedIn({ role: 'viewer' });
    documentApi.get.mockResolvedValue({ document: doc() });
    documentApi.processing.mockResolvedValue(null);
    const { unmount } = renderApp('/documents/d1');
    expect(await screen.findByRole('button', { name: /Download/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rename|Delete/ })).not.toBeInTheDocument();
    unmount();

    const notFound = Object.assign(new Error('Document not found.'), { status: 404 });
    documentApi.get.mockRejectedValue(notFound);
    renderApp('/documents/missing');
    expect(await screen.findByText('Document not found')).toBeInTheDocument();
  });
});

describe('Citations', () => {
  it('link to the cited document when the backend provides its id', () => {
    render(
      <MemoryRouter>
        <CitationList citations={[
          { id: 'a', documentId: 'd9', documentName: 'hr.pdf', page: 2, chunkIndex: 0, relevanceScore: 0.9 },
          { id: 'b', documentName: 'legacy.pdf', chunkIndex: 3 },
        ]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /hr\.pdf/ })).toHaveAttribute('href', '/documents/d9');
    expect(screen.getByText('Page 2 · Section 1 · 90% match')).toBeInTheDocument();
    expect(screen.getByText('legacy.pdf').closest('a')).toBeNull();
  });
});

describe('Settings', () => {
  it('shows organization, profile, security and usage without fake settings', async () => {
    documentApi.list.mockResolvedValue({ documents: [doc()], pagination: { totalCount: 1 } });
    renderApp('/settings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    for (const name of ['Organization', 'Profile', 'Security', 'Usage']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    expect(within(screen.getByRole('region', { name: 'Profile' })).getByText(USER.email)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage sign-in methods' })).toHaveAttribute('href', '/settings/account');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); // read-only: no unsupported edits
  });
});
