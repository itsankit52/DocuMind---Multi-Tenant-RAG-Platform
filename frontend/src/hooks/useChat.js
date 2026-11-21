/**
 * Chat state for one conversation: loads persisted history from the backend and streams
 * new answers over SSE. The backend is the source of truth; local state only mirrors it
 * and shows in-flight progress.
 *
 * One AbortController per stream. It is aborted on Stop, on conversation switch and on
 * unmount; the backend then cancels generation and persists nothing for that turn.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { conversationApi } from '../api/endpoints';
import { streamChatMessage } from '../api/sse';

let localSeq = 0;
const localId = (prefix) => `${prefix}-local-${Date.now()}-${++localSeq}`;
const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : localId('key'));

function fromServer(m) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.created_at,
    citations: m.citations || [],
    status: 'complete',
  };
}

export function useChat(conversationId, { onActivity } = {}) {
  const [messages, setMessages] = useState([]);
  const [conversation, setConversation] = useState(null);
  // Id whose history has finished loading; `loading` is derived so the first render
  // after a conversation change is already "loading" (no stale window to send in).
  const [loadedFor, setLoadedFor] = useState(null);
  const loading = !!conversationId && loadedFor !== conversationId;
  const [loadError, setLoadError] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const controllerRef = useRef(null);
  const streamingRef = useRef(false);
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const update = (id, patch) =>
    setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)));

  // Load history whenever the conversation changes; abort any in-flight stream/load.
  useEffect(() => {
    setMessages([]);
    setConversation(null);
    setLoadError(null);
    if (!conversationId) return undefined;

    const loadController = new AbortController();
    conversationApi.get(conversationId, { signal: loadController.signal })
      .then((result) => {
        setConversation(result?.conversation || null);
        setMessages((result?.messages || []).map(fromServer));
      })
      .catch((err) => { if (!err.cancelled) setLoadError(err); })
      .finally(() => { if (!loadController.signal.aborted) setLoadedFor(conversationId); });

    return () => {
      loadController.abort();
      controllerRef.current?.abort();
      controllerRef.current = null;
      streamingRef.current = false;
      setStreaming(false);
    };
  }, [conversationId]);

  const send = useCallback(async (rawContent) => {
    const content = (rawContent || '').trim();
    if (!content || !conversationId || streamingRef.current) return false;

    streamingRef.current = true;
    setStreaming(true);
    const controller = new AbortController();
    controllerRef.current = controller;

    const userId = localId('user');
    const assistantId = localId('assistant');
    let started = false;
    setMessages(prev => [
      ...prev,
      { id: userId, role: 'user', content, createdAt: new Date().toISOString(), citations: [], status: 'pending' },
      { id: assistantId, role: 'assistant', content: '', createdAt: null, citations: [], status: 'streaming' },
    ]);

    // Server ids replace local ids as events arrive
    let userKey = userId;
    let assistantKey = assistantId;

    try {
      await streamChatMessage({
        conversationId,
        content,
        signal: controller.signal,
        idempotencyKey: newKey(),
        onEvent: ({ event, data }) => {
          if (controller.signal.aborted) return;
          if (event === 'start') {
            started = true;
            const serverId = data.userMessageId || userKey;
            update(userKey, { id: serverId, status: 'complete' });
            userKey = serverId;
          } else if (event === 'token' && typeof data.text === 'string') {
            update(assistantKey, m => ({ content: m.content + data.text }));
          } else if (event === 'citation') {
            update(assistantKey, m => ({ citations: [...m.citations, data] }));
          } else if (event === 'done') {
            const serverId = data.messageId || assistantKey;
            update(assistantKey, { id: serverId, status: 'complete', createdAt: new Date().toISOString() });
            assistantKey = serverId;
          } else if (event === 'error') {
            update(assistantKey, {
              status: 'error',
              errorMessage: typeof data.message === 'string' ? data.message : 'Unable to generate a response.',
            });
          }
        },
      });
    } catch (err) {
      if (err.cancelled) {
        update(assistantKey, { status: 'stopped' });
        if (!started) update(userKey, { status: 'complete' });
      } else if (!started) {
        // Rejected before streaming began (e.g. 404/429): nothing was saved for this turn
        setMessages(prev => prev.filter(m => m.id !== assistantKey));
        update(userKey, { status: 'failed', errorMessage: err.message });
      } else {
        update(assistantKey, { status: 'error', errorMessage: err.message });
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      streamingRef.current = false;
      setStreaming(false);
      if (started) activityRef.current?.(conversationId);
    }
    return true;
  }, [conversationId]);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  /** Re-ask a question whose turn failed; removes the failed local entries first. */
  const retry = useCallback((messageId) => {
    if (streamingRef.current) return;
    const current = messagesRef.current;
    const idx = current.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    const target = current[idx];
    const userMsg = target.role === 'user'
      ? target
      : [...current.slice(0, idx)].reverse().find(m => m.role === 'user');
    if (!userMsg) return;
    const drop = new Set([messageId, userMsg.id]);
    setMessages(prev => prev.filter(m => !drop.has(m.id)));
    send(userMsg.content);
  }, [send]);

  return { conversation, messages, loading, loadError, streaming, send, stop, retry };
}
