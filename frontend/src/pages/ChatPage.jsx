import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { canWrite, useAuth } from '../context/AuthContext';
import { useConversations } from '../hooks/useConversations';
import { useChat } from '../hooks/useChat';
import { ConversationSidebar } from '../components/ConversationSidebar';
import { MessageContent } from '../components/MessageContent';
import { CitationList } from '../components/CitationList';
import { Alert, EmptyState, Spinner } from '../components/Feedback';
import { formatTime } from '../utils/format';

const MAX_QUESTION_LENGTH = Number(import.meta.env.VITE_MAX_QUESTION_LENGTH) || 1000;

export function ChatPage() {
  const { conversationId } = useParams();
  const { activeOrganization, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const convs = useConversations(activeOrganization?.organization_id);
  const chat = useChat(conversationId, { onActivity: convs.touch });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const handledPending = useRef(null);
  const writable = canWrite(role);

  // A question typed before any conversation existed: send it once the new one is loaded
  const pendingQuestion = location.state?.pendingQuestion;
  useEffect(() => {
    if (!pendingQuestion || !conversationId || chat.loading || chat.loadError) return;
    if (handledPending.current === location.key) return;
    handledPending.current = location.key;
    navigate(location.pathname, { replace: true, state: null });
    chat.send(pendingQuestion);
  }, [pendingQuestion, conversationId, chat.loading, chat.loadError, chat, location.key, location.pathname, navigate]);

  const createConversation = async (title) => {
    setCreating(true);
    setCreateError(null);
    try {
      return await convs.create(title);
    } catch (err) {
      setCreateError(err);
      return null;
    } finally {
      setCreating(false);
    }
  };

  const onNew = async () => {
    const conv = await createConversation();
    if (conv) navigate(`/chat/${conv.id}`);
  };

  const onDelete = async (id) => {
    await convs.remove(id);
    if (id === conversationId) navigate('/chat', { replace: true });
  };

  const onSend = async (question) => {
    if (conversationId) return chat.send(question);
    const conv = await createConversation(question.slice(0, 60));
    if (!conv) return false;
    navigate(`/chat/${conv.id}`, { state: { pendingQuestion: question } });
    return true;
  };

  const notFound = chat.loadError?.status === 404;

  return (
    <div className="chat-page">
      <ConversationSidebar
        conversations={convs.conversations}
        loading={convs.loading}
        error={convs.error}
        activeId={conversationId}
        creating={creating}
        onCreate={onNew}
        onRename={writable ? convs.rename : undefined}
        onDelete={writable ? onDelete : undefined}
        onReload={() => convs.reload()}
        hasMore={convs.hasMore}
        loadingMore={convs.loadingMore}
        onLoadMore={() => convs.loadMore()}
      />
      <section className="chat-panel" aria-label="Chat">
        <header className="chat-header">
          <h1 className="truncate">
            {conversationId ? (chat.conversation?.title || (chat.loading ? 'Loading…' : 'Conversation')) : 'New conversation'}
          </h1>
        </header>
        {createError && <Alert error={createError} onDismiss={() => setCreateError(null)} />}
        {notFound ? (
          <EmptyState title="Conversation not found">It may have been deleted, or it belongs to another organization.</EmptyState>
        ) : (
          <>
            {chat.loadError && <Alert error={chat.loadError} />}
            <MessageList chat={chat} hasConversation={!!conversationId} />
            <AnswerAnnouncer messages={chat.messages} streaming={chat.streaming} />
            <Composer
              onSend={onSend}
              onStop={chat.stop}
              streaming={chat.streaming}
              disabled={creating || chat.loading || !!chat.loadError}
            />
          </>
        )}
      </section>
    </div>
  );
}

function MessageList({ chat, hasConversation }) {
  const listRef = useRef(null);
  const stickToBottom = useRef(true);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // Follow new tokens while the user is at the bottom; don't yank them if they scrolled up.
  // Scroll only the list itself (scrollIntoView would also scroll the page on small screens).
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  if (chat.loading) return <div className="message-list"><Spinner label="Loading messages…" /></div>;

  return (
    <div className="message-list" ref={listRef} onScroll={onScroll} aria-busy={chat.streaming}>
      {chat.messages.length === 0 ? (
        <EmptyState title={hasConversation ? 'No messages yet' : 'Ask a question about your documents'}>
          Answers are grounded in your organization's documents and include their sources.
        </EmptyState>
      ) : chat.messages.map(m => <Message key={m.id} message={m} onRetry={() => chat.retry(m.id)} canRetry={!chat.streaming} />)}
    </div>
  );
}

/**
 * Screen-reader announcement of a finished answer. The message list itself is not a live
 * region (that would announce every streamed token); this announces once per completed turn.
 * Errors are announced by their own role="alert" message.
 */
function AnswerAnnouncer({ messages, streaming }) {
  const [text, setText] = useState('');
  const wasStreaming = useRef(false);

  useEffect(() => {
    if (streaming) {
      wasStreaming.current = true;
      setText('');
      return;
    }
    if (!wasStreaming.current) return;
    wasStreaming.current = false;
    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant') return;
    if (last.status === 'complete') setText(`Answer complete: ${last.content}`);
    else if (last.status === 'stopped') setText('Generation stopped.');
  }, [streaming, messages]);

  return <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="answer-announcer">{text}</div>;
}

function Message({ message, onRetry, canRetry }) {
  const isUser = message.role === 'user';
  return (
    <article className={`message ${isUser ? 'message-user' : 'message-assistant'}`} data-status={message.status}
      aria-label={isUser ? 'Your message' : 'Assistant message'}>
      <div className="message-bubble">
        {isUser
          ? <p className="message-text">{message.content}</p>
          : message.content
            ? <MessageContent text={message.content} />
            : message.status === 'streaming' && <Spinner inline label="Generating answer…" />}
        {message.status === 'streaming' && message.content && <span className="cursor" aria-hidden="true">▍</span>}
        {!isUser && message.status === 'complete' && <CitationList citations={message.citations} />}
      </div>
      <div className="message-meta">
        {message.createdAt && message.status !== 'streaming' && <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>}
        {message.status === 'stopped' && <span className="muted">Generation stopped — this answer was not saved.</span>}
        {(message.status === 'error' || message.status === 'failed') && (
          <span className="message-error" role="alert">
            {message.errorMessage || 'Something went wrong.'}
            {canRetry && <button type="button" className="btn btn-link btn-sm" onClick={onRetry}>Retry</button>}
          </span>
        )}
      </div>
    </article>
  );
}

function Composer({ onSend, onStop, streaming, disabled }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const tooLong = text.length > MAX_QUESTION_LENGTH;
  const blocked = disabled || streaming || sending || !text.trim() || tooLong;

  const submit = async () => {
    if (blocked) return;
    const question = text.trim();
    setSending(true);
    setText('');
    try {
      const ok = await onSend(question);
      if (ok === false) setText(question);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <label htmlFor="composer-input" className="visually-hidden">Ask a question</label>
      <textarea
        id="composer-input"
        className="input composer-input"
        rows={2}
        placeholder="Ask a question about your documents… (Enter to send, Shift+Enter for a new line)"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-invalid={tooLong}
      />
      <div className="composer-actions">
        {tooLong && <span className="small text-danger">{text.length}/{MAX_QUESTION_LENGTH}</span>}
        {streaming ? (
          <button type="button" className="btn btn-secondary" onClick={onStop}>Stop generating</button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={blocked}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        )}
      </div>
    </form>
  );
}
