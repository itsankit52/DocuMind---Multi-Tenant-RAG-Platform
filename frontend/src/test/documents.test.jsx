import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toApiError } from '../api/client';
import { useDocuments } from '../hooks/useDocuments';
import { documentApi } from './apiMock';
import { deferred, mockSignedIn, renderApp, resetApiMocks } from './utils';

vi.mock('../api/endpoints', () => import('./apiMock'));

const doc = (over = {}) => ({
  id: 'd1',
  filename: 'policy.pdf',
  original_name: 'policy.pdf',
  mime_type: 'application/pdf',
  file_size: 204800,
  status: 'ready',
  created_at: '2026-09-20T10:00:00Z',
  updated_at: '2026-09-20T10:05:00Z',
  ...over,
});

const listOf = (...docs) => ({ documents: docs, pagination: { totalCount: docs.length } });
const pdf = (name = 'report.pdf') => new File(['%PDF-1.4 test'], name, { type: 'application/pdf' });

beforeEach(() => {
  resetApiMocks();
  mockSignedIn();
});

describe('Documents page', () => {
  it('lists documents with name, type, size and status', async () => {
    documentApi.list.mockResolvedValue(listOf(
      doc(),
      doc({ id: 'd2', filename: 'handbook.docx', original_name: 'handbook.docx', status: 'processing',
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', file_size: 1536 }),
      doc({ id: 'd3', filename: 'broken.pdf', original_name: 'broken.pdf', status: 'failed' }),
      doc({ id: 'd4', filename: 'new.pdf', original_name: 'new.pdf', status: 'uploaded' }),
    ));
    renderApp('/documents');
    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(5); // header + 4
    const first = within(rows[1]);
    expect(first.getByText('policy.pdf')).toBeInTheDocument();
    expect(first.getByText('PDF')).toBeInTheDocument();
    expect(first.getByText('200.0 KB')).toBeInTheDocument();
    expect(first.getByTestId('doc-status')).toHaveTextContent('Ready');
    expect(within(rows[2]).getByText('DOCX')).toBeInTheDocument();
    expect(within(rows[2]).getByTestId('doc-status')).toHaveTextContent('Processing');
    expect(within(rows[3]).getByTestId('doc-status')).toHaveTextContent('Failed');
    expect(within(rows[3]).getByRole('button', { name: 'Retry processing broken.pdf' })).toBeInTheDocument();
    expect(within(rows[4]).getByTestId('doc-status')).toHaveTextContent('Queued');
  });

  it('shows an empty state when there are no documents', async () => {
    renderApp('/documents');
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
  });

  it('uploads a file with progress, then refreshes the list', async () => {
    const pending = deferred();
    documentApi.upload.mockImplementation((file, { onProgress }) => {
      onProgress(40);
      return pending.promise;
    });
    renderApp('/documents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Upload document' }));
    await user.upload(screen.getByLabelText(/Upload a document/), pdf());
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByRole('progressbar', { name: 'Upload progress' })).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByRole('button', { name: 'Uploading…' })).toBeDisabled();
    expect(documentApi.upload.mock.calls[0][0].name).toBe('report.pdf');

    documentApi.list.mockResolvedValue(listOf(doc({ id: 'n1', filename: 'report.pdf', original_name: 'report.pdf', status: 'uploaded' })));
    pending.resolve({ document: { id: 'n1', original_name: 'report.pdf', status: 'uploaded' } });

    expect(await screen.findByText(/Uploaded report.pdf/)).toBeInTheDocument();
    expect(await screen.findByText('report.pdf', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByTestId('doc-status')).toHaveTextContent('Queued');
  });

  it('shows the server reason when an upload fails', async () => {
    documentApi.upload.mockRejectedValue(toApiError(413, 'File size exceeds maximum limit of 10MB.'));
    renderApp('/documents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Upload document' }));
    await user.upload(screen.getByLabelText(/Upload a document/), pdf());
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('File size exceeds maximum limit of 10MB.');
  });

  it('rejects unsupported file types before uploading (UX check only)', async () => {
    renderApp('/documents');
    const user = userEvent.setup({ applyAccept: false });
    await user.click(await screen.findByRole('button', { name: 'Upload document' }));
    await user.upload(screen.getByLabelText(/Upload a document/), new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only PDF and DOCX files are supported.');
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(documentApi.upload).not.toHaveBeenCalled();
  });

  it('deletes a document after confirmation', async () => {
    documentApi.list.mockResolvedValue(listOf(doc()));
    documentApi.remove.mockResolvedValue({});
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/documents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete policy.pdf' }));
    expect(confirm).toHaveBeenCalled();
    expect(documentApi.remove).toHaveBeenCalledWith('d1');
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
  });

  it('does not delete when the confirmation is cancelled', async () => {
    documentApi.list.mockResolvedValue(listOf(doc()));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderApp('/documents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete policy.pdf' }));
    expect(documentApi.remove).not.toHaveBeenCalled();
  });

  it('renames a document', async () => {
    documentApi.list.mockResolvedValue(listOf(doc()));
    documentApi.rename.mockResolvedValue({ document: doc({ filename: 'renamed.pdf' }) });
    renderApp('/documents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rename policy.pdf' }));
    const input = screen.getByLabelText('New name');
    await user.clear(input);
    await user.type(input, 'renamed.pdf{Enter}');
    expect(documentApi.rename).toHaveBeenCalledWith('d1', 'renamed.pdf');
    expect(await screen.findByText('renamed.pdf')).toBeInTheDocument();
  });

  it('hides write actions for viewers (the backend still enforces RBAC)', async () => {
    mockSignedIn({ role: 'viewer' });
    documentApi.list.mockResolvedValue(listOf(doc()));
    renderApp('/documents');
    expect(await screen.findByRole('button', { name: 'Download policy.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload document' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete policy.pdf' })).not.toBeInTheDocument();
    expect(screen.getByText(/read-only access/)).toBeInTheDocument();
  });

  it('shows a retryable error when the list fails to load', async () => {
    documentApi.list.mockRejectedValueOnce(toApiError(500, 'stack trace here'));
    renderApp('/documents');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on the server');
    expect(alert).not.toHaveTextContent('stack trace');
    documentApi.list.mockResolvedValue(listOf(doc()));
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('policy.pdf')).toBeInTheDocument();
  });
});

describe('useDocuments status polling', () => {
  it('polls while documents are processing and stops once they finish', async () => {
    documentApi.list
      .mockResolvedValueOnce(listOf(doc({ status: 'uploaded' })))
      .mockResolvedValueOnce(listOf(doc({ status: 'processing' })))
      .mockResolvedValue(listOf(doc({ status: 'ready' })));
    const { result } = renderHook(() => useDocuments('org-a', { pollIntervalMs: 20 }));
    await waitFor(() => expect(result.current.documents[0]?.status).toBe('ready'));
    const calls = documentApi.list.mock.calls.length;
    expect(calls).toBe(3);
    await new Promise(r => setTimeout(r, 120));
    expect(documentApi.list).toHaveBeenCalledTimes(calls); // no polling after completion
  });

  it('stops polling on unmount', async () => {
    documentApi.list.mockResolvedValue(listOf(doc({ status: 'processing' })));
    const { unmount } = renderHook(() => useDocuments('org-a', { pollIntervalMs: 20 }));
    await waitFor(() => expect(documentApi.list.mock.calls.length).toBeGreaterThanOrEqual(2));
    unmount();
    const calls = documentApi.list.mock.calls.length;
    await new Promise(r => setTimeout(r, 120));
    expect(documentApi.list).toHaveBeenCalledTimes(calls);
  });

  it('gives up after repeated polling errors instead of polling forever', async () => {
    documentApi.list
      .mockResolvedValueOnce(listOf(doc({ status: 'processing' })))
      .mockRejectedValue(toApiError(0));
    renderHook(() => useDocuments('org-a', { pollIntervalMs: 5 }));
    await new Promise(r => setTimeout(r, 600));
    const calls = documentApi.list.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(7); // 1 load + at most 5 failed polls (+ scheduling slack)
    await new Promise(r => setTimeout(r, 200));
    expect(documentApi.list).toHaveBeenCalledTimes(calls);
  });
});
