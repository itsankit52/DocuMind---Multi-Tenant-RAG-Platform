import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, toApiError } from '../api/client';
import { streamChatMessage } from '../api/sse';
import { conversationApi } from './apiMock';
import { deferred, mockSignedIn, renderApp, resetApiMocks } from './utils';

vi.mock('../api/endpoints', () => import('./apiMock'));
vi.mock('../api/sse', async (importOriginal) => ({
  ...(await importOriginal()),
  streamChatMessage: vi.fn(),
}));

/** The composer is disabled while history loads; wait until a user could type. */
async function readyComposer() {
  const box = await screen.findByLabelText('Ask a question');
  await waitFor(() => expect(box).toBeEnabled());
  return box;
}

const conv = (id, title, updated = '2026-09-20T10:00:00Z') => ({ id, title, updated_at: updated });
const CONVS = [conv('c1', 'Leave policy'), conv('c2', 'Insurance questions')];

const history = (id) => ({
  conversation: conv(id, id === 'c1' ? 'Leave policy' : 'Insurance questions'),
  messages: id === 'c1' ? [
    { id: 'm1', role: 'user', content: 'What is the leave policy?', created_at: '2026-09-20T10:00:00Z', citations: [] },
    { id: 'm2', role: 'assistant', content: 'Employees get **24 days**.', created_at: '2026-09-20T10:00:05Z',
      citations: [{ id: 'ct1', documentName: 'hr-policy.pdf', page: 3, chunkIndex: 1, relevanceScore: 0.82 }] },
  ] : [],
});

beforeEach(() => {
  resetApiMocks();
  streamChatMessage.mockReset();
  mockSignedIn();
  conversationApi.list.mockResolvedValue({ conversations: CONVS });
  conversationApi.get.mockImplementation((id) => Promise.resolve(history(id)));
});

describe('Conversation sidebar', () => {
  it('lists conversations from the backend and highlights the active one', async () => {
    renderApp('/chat/c1');
    const active = await screen.findByRole('link', { name: /Leave policy/ });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Insurance questions/ })).not.toHaveAttribute('aria-current');
  });

  it('shows an empty state with no conversations', async () => {
    conversationApi.list.mockResolvedValue({ conversations: [] });
    renderApp('/chat');
    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
  });

  it('creates a conversation and opens it', async () => {
    conversationApi.create.mockResolvedValue({ conversation: conv('c3', 'New conversation') });
    renderApp('/chat');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New' }));
    await waitFor(() => expect(conversationApi.get).toHaveBeenCalledWith('c3', expect.anything()));
    expect(await screen.findByRole('link', { name: /New conversation/ })).toHaveAttribute('aria-current', 'page');
  });

  it('selecting a conversation loads its messages', async () => {
    renderApp('/chat/c2');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: /Leave policy/ }));
    expect(await screen.findByText('What is the leave policy?')).toBeInTheDocument();
    expect(conversationApi.get).toHaveBeenLastCalledWith('c1', expect.anything());
  });

  it('renames a conversation', async () => {
    conversationApi.rename.mockResolvedValue({ conversation: conv('c1', 'Annual leave') });
    renderApp('/chat/c1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rename Leave policy' }));
    const input = screen.getByLabelText('Conversation title');
    await user.clear(input);
    await user.type(input, 'Annual leave{Enter}');
    expect(conversationApi.rename).toHaveBeenCalledWith('c1', 'Annual leave');
    expect(await screen.findByRole('link', { name: /Annual leave/ })).toBeInTheDocument();
  });

  it('deletes the active conversation and leaves it', async () => {
    conversationApi.remove.mockResolvedValue({});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/chat/c1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete Leave policy' }));
    expect(conversationApi.remove).toHaveBeenCalledWith('c1');
    await waitFor(() => expect(screen.queryByRole('link', { name: /Leave policy/ })).not.toBeInTheDocument());
    // react-router commits navigation inside a transition, so wait for it instead of asserting synchronously
    expect(await screen.findByRole('heading', { name: 'New conversation' })).toBeInTheDocument();
  });

  it('shows "not found" for a conversation the backend refuses (e.g. another organization)', async () => {
    conversationApi.get.mockRejectedValue(toApiError(404, 'Conversation not found.'));
    renderApp('/chat/foreign-id');
    expect(await screen.findByText('Conversation not found')).toBeInTheDocument();
    expect(screen.queryByLabelText('Ask a question')).not.toBeInTheDocument();
  });
});

describe('Chat', () => {
  it('loads persisted messages with rendered markdown and citations', async () => {
    renderApp('/chat/c1');
    expect(await screen.findByText('What is the leave policy?')).toBeInTheDocument();
    expect(screen.getByText('24 days').tagName).toBe('STRONG');
    const sources = screen.getByLabelText('Sources');
    expect(within(sources).getByText('hr-policy.pdf')).toBeInTheDocument();
    expect(within(sources).getByText(/Page 3 · Section 2 · 82% match/)).toBeInTheDocument();
  });

  it('streams tokens incrementally, then shows citations and re-enables input', async () => {
    const gate = deferred();
    streamChatMessage.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: 'start', data: { conversationId: 'c2', userMessageId: 'u9' } });
      onEvent({ event: 'token', data: { text: 'Health' } });
      onEvent({ event: 'token', data: { text: ' cover' } });
      await gate.promise;
      onEvent({ event: 'token', data: { text: 'age is included.' } });
      onEvent({ event: 'citation', data: { id: 'ct9', documentName: 'benefits.pdf', page: 1, chunkIndex: 0 } });
      const done = { event: 'done', data: { conversationId: 'c2', messageId: 'a9', finishReason: 'stop' } };
      onEvent(done);
      return done;
    });
    renderApp('/chat/c2');
    const user = userEvent.setup();
    await user.type(await readyComposer(), 'Is health insurance included?{Enter}');

    // partial answer is visible before the stream completes
    expect(await screen.findByText('Health cover')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Sources')).not.toBeInTheDocument();

    gate.resolve();
    expect(await screen.findByText('Health coverage is included.')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Sources')).getByText('benefits.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(streamChatMessage).toHaveBeenCalledTimes(1);
    expect(streamChatMessage.mock.calls[0][0]).toMatchObject({ conversationId: 'c2', content: 'Is health insurance included?' });
  });

  it('announces a finished answer once instead of making every streamed token a live update', async () => {
    const gate = deferred();
    streamChatMessage.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: 'start', data: { conversationId: 'c2', userMessageId: 'u9' } });
      onEvent({ event: 'token', data: { text: 'Partial' } });
      await gate.promise;
      onEvent({ event: 'token', data: { text: ' answer.' } });
      const done = { event: 'done', data: { conversationId: 'c2', messageId: 'a9', finishReason: 'stop' } };
      onEvent(done);
      return done;
    });
    renderApp('/chat/c2');
    const user = userEvent.setup();
    await user.type(await readyComposer(), 'Question?{Enter}');
    expect(await screen.findByText('Partial')).toBeInTheDocument();

    const announcer = screen.getByTestId('answer-announcer');
    expect(announcer).toHaveAttribute('aria-live', 'polite');
    expect(announcer).toHaveTextContent(/^$/); // nothing announced mid-stream
    expect(document.querySelector('.message-list')).not.toHaveAttribute('aria-live');

    gate.resolve();
    await waitFor(() => expect(announcer).toHaveTextContent('Answer complete: Partial answer.'));
  });

  it('keeps the same conversation id across turns (multi-turn)', async () => {
    streamChatMessage.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: 'start', data: {} });
      onEvent({ event: 'token', data: { text: 'ok' } });
      const done = { event: 'done', data: { messageId: `a-${Math.random()}` } };
      onEvent(done);
      return done;
    });
    renderApp('/chat/c1');
    const user = userEvent.setup();
    const box = await readyComposer();
    await user.type(box, 'What about contractors?{Enter}');
    await screen.findByText('What about contractors?');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument());
    await user.type(box, 'And interns?{Enter}');
    await waitFor(() => expect(streamChatMessage).toHaveBeenCalledTimes(2));
    expect(streamChatMessage.mock.calls.map(c => c[0].conversationId)).toEqual(['c1', 'c1']);
    expect(screen.getByText('What is the leave policy?')).toBeInTheDocument(); // history kept
  });

  it('Shift+Enter inserts a newline instead of sending', async () => {
    renderApp('/chat/c2');
    const user = userEvent.setup();
    const box = await readyComposer();
    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(box).toHaveValue('line one\nline two');
    expect(streamChatMessage).not.toHaveBeenCalled();
  });

  it('shows a backend ERROR event with retry, and no answer is marked complete', async () => {
    streamChatMessage.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: 'start', data: {} });
      onEvent({ event: 'token', data: { text: 'Part' } });
      const err = { event: 'error', data: { code: 'LLM_STREAM_ERROR', message: 'Unable to generate a response.' } };
      onEvent(err);
      return err;
    });
    renderApp('/chat/c2');
    const user = userEvent.setup();
    await user.type(await readyComposer(), 'Question?{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unable to generate a response.');

    streamChatMessage.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: 'start', data: {} });
      onEvent({ event: 'token', data: { text: 'Second try' } });
      const done = { event: 'done', data: { messageId: 'a2' } };
      onEvent(done);
      return done;
    });
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Second try')).toBeInTheDocument();
    expect(screen.getAllByText('Question?')).toHaveLength(1); // no duplicate bubble
    expect(streamChatMessage.mock.calls[1][0].content).toBe('Question?');
  });

  it('shows a safe message when the request is rejected before streaming (e.g. 429)', async () => {
    streamChatMessage.mockRejectedValue(toApiError(429, 'raw'));
    renderApp('/chat/c2');
    const user = userEvent.setup();
    await user.type(await readyComposer(), 'Hello?{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    expect(screen.queryByLabelText('Assistant message')).not.toBeInTheDocument();
  });

  it('Stop aborts the stream, keeps the partial text marked as not saved, and restores input', async () => {
    streamChatMessage.mockImplementation(({ onEvent, signal }) => new Promise((resolve, reject) => {
      onEvent({ event: 'start', data: {} });
      onEvent({ event: 'token', data: { text: 'Partial answer' } });
      signal.addEventListener('abort', () => {
        const err = new ApiError(0, 'Generation stopped.');
        err.cancelled = true;
        reject(err);
      });
    }));
    renderApp('/chat/c2');
    const user = userEvent.setup();
    await user.type(await readyComposer(), 'Long question{Enter}');
    await screen.findByText('Partial answer');
    await user.click(screen.getByRole('button', { name: 'Stop generating' }));

    expect(await screen.findByText(/Generation stopped — this answer was not saved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(streamChatMessage.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it('aborts an in-flight stream when switching conversations', async () => {
    let captured;
    streamChatMessage.mockImplementation(({ signal }) => {
      captured = signal;
      return new Promise(() => {});
    });
    renderApp('/chat/c2');
    const user = userEvent.setup();
    await user.type(await readyComposer(), 'Question{Enter}');
    await waitFor(() => expect(captured).toBeDefined());
    await user.click(screen.getByRole('link', { name: /Leave policy/ }));
    await waitFor(() => expect(captured.aborted).toBe(true));
  });

  it('asking with no conversation selected creates one and streams into it', async () => {
    conversationApi.create.mockResolvedValue({ conversation: conv('c7', 'Who approves leave?') });
    streamChatMessage.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: 'start', data: {} });
      onEvent({ event: 'token', data: { text: 'Managers do.' } });
      const done = { event: 'done', data: { messageId: 'a7' } };
      onEvent(done);
      return done;
    });
    renderApp('/chat');
    const user = userEvent.setup();
    await user.type(await readyComposer(), 'Who approves leave?{Enter}');
    expect(await screen.findByText('Managers do.')).toBeInTheDocument();
    expect(conversationApi.create).toHaveBeenCalledWith('Who approves leave?');
    expect(streamChatMessage).toHaveBeenCalledTimes(1);
    expect(streamChatMessage.mock.calls[0][0].conversationId).toBe('c7');
  });

  it('never renders HTML from assistant content (XSS)', async () => {
    conversationApi.get.mockResolvedValue({
      conversation: conv('c1', 'x'),
      messages: [{ id: 'm', role: 'assistant', content: '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>[link](javascript:alert(1))', citations: [] }],
    });
    const { container } = renderApp('/chat/c1');
    await screen.findByLabelText('Assistant message');
    expect(container.querySelector('.markdown img')).toBeNull();
    expect(container.querySelector('.markdown script')).toBeNull();
    const link = container.querySelector('.markdown a');
    expect(link?.getAttribute('href') || '').not.toMatch(/javascript:/i);
    expect(window.__xss).toBeUndefined();
  });
});
