import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useActiveProject } from '../../lib/useActiveProject';
import { reportChatApi } from '../../lib/reportChatApi';
import { useChatScreen } from './ChatContext';
import ChatMessage from './ChatMessage';
import { buildScreenCopy, screenName, starterQuestions } from './chatModel';

// ── "Ask about this report" ─────────────────────────────────────────────────
//
// A floating assistant for the header's project. On a report screen (one that
// renders a Legend) it answers about that report and the project; anywhere
// else, from the project's data alone, and the header says which.
//
// The conversation is the server's: it loads when the panel first opens for a
// project and is kept per person, per project. An answer keeps streaming if
// the panel is closed mid-way, and is there when it opens again.

function BubbleIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5v-8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M8.5 8.5h7M8.5 11.5h4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export default function ChatBubble() {
  const { project } = useActiveProject();
  const { screen, getCtx, getWorking } = useChatScreen();
  const projectId = project?.id || null;

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [loadedFor, setLoadedFor] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [input, setInput] = useState('');
  // Answers whose "Connect with a Position2 specialist" was clicked. The
  // connection itself is a placeholder for now; connectExpert below is the one
  // place the real action (email, booking link, CRM) goes.
  const [connectRequested, setConnectRequested] = useState(() => new Set());

  const panelId = useId();
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  // A different project is a different conversation.
  useEffect(() => {
    abortRef.current?.abort();
    setMessages([]);
    setLoadedFor(null);
    setLoadError(null);
    setError(null);
    setSending(false);
  }, [projectId]);

  useEffect(() => {
    if (!open || !projectId || loadedFor === projectId) return undefined;
    let alive = true;
    reportChatApi.thread(projectId)
      .then((res) => { if (alive) { setMessages(res.messages || []); setLoadedFor(projectId); } })
      .catch((e) => { if (alive) setLoadError(e.message); });
    return () => { alive = false; };
  }, [open, projectId, loadedFor]);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  const send = useCallback(async (text) => {
    const question = text.trim();
    if (!question || sending || !projectId) return;
    setInput('');
    setError(null);
    setSending(true);

    const tempUser = { id: `local-user-${Date.now()}`, role: 'user', content: question };
    const tempAnswer = { id: `local-answer-${Date.now()}`, role: 'assistant', content: '', pending: true };
    setMessages((list) => [...list, tempUser, tempAnswer]);
    const patchAnswer = (fn) => setMessages((list) => list.map((m) => (m.id === tempAnswer.id ? fn(m) : m)));

    const controller = new AbortController();
    abortRef.current = controller;
    const ctx = getCtx();
    let failed = false;
    let finished = false;
    try {
      await reportChatApi.ask(projectId, {
        message: question,
        screen,
        screenCopy: screen ? buildScreenCopy(screen, ctx, getWorking()) : null,
      }, {
        signal: controller.signal,
        onEvent: (event, data) => {
          if (event === 'start') {
            setMessages((list) => list.map((m) => (m.id === tempUser.id ? data.userMessage : m)));
          } else if (event === 'delta') {
            patchAnswer((m) => ({ ...m, content: m.content + data.text }));
          } else if (event === 'done') {
            finished = true;
            setMessages((list) => list.map((m) => (m.id === tempAnswer.id ? data.message : m)));
          } else if (event === 'error') {
            failed = true;
            setError(data.error);
          }
        },
      });
      // The connection closed without a done or error event (a dropped
      // network, a proxy timeout): say so rather than leave a silent bubble.
      if (!finished && !failed) {
        failed = true;
        setError('The answer was cut off. Please ask again.');
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      failed = true;
      setError(e.message);
      // Refused before it started: the question was not saved, so put it back.
      if (e.status) {
        setMessages((list) => list.filter((m) => m.id !== tempUser.id));
        setInput(question);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (failed) setMessages((list) => list.filter((m) => !(m.id === tempAnswer.id && !m.content)));
      setMessages((list) => list.map((m) => (m.id === tempAnswer.id ? { ...m, pending: false } : m)));
      setSending(false);
    }
  }, [sending, projectId, screen, getCtx, getWorking]);

  const connectExpert = useCallback((message) => {
    setConnectRequested((prev) => new Set(prev).add(message.id));
  }, []);

  const newConversation = useCallback(async () => {
    if (!projectId || sending) return;
    try {
      await reportChatApi.newThread(projectId);
      setMessages([]);
      setError(null);
      inputRef.current?.focus();
    } catch (e) { setError(e.message); }
  }, [projectId, sending]);

  if (!projectId) return null;

  const name = screenName(screen);
  const scope = name ? `${name} report and ${project.name} project data` : `${project.name} project data`;
  const empty = loadedFor === projectId && messages.length === 0;

  return createPortal(
    <>
      {open && (
        <div id={panelId} role="dialog" aria-label="Ask about this report" className="report-chat">
          <div className="report-chat__head">
            <div className="report-chat__heading">
              <span className="explain-kicker">Ask about this report</span>
              <span className="report-chat__scope">Reading: {scope}</span>
            </div>
            <div className="report-chat__actions">
              {messages.length > 0 && (
                <button type="button" className="report-chat__new" onClick={newConversation} disabled={sending}>
                  New conversation
                </button>
              )}
              <button type="button" className="explain-close explain-close--lg" aria-label="Close assistant" onClick={() => setOpen(false)}>×</button>
            </div>
          </div>

          <div className="report-chat__list" ref={listRef} aria-live="polite">
            {loadError && <p className="report-chat__error">Could not load the conversation: {loadError}</p>}
            {!loadError && loadedFor !== projectId && <p className="report-chat__hint">Loading…</p>}
            {empty && (
              <div className="report-chat__intro">
                <p>
                  {name
                    ? `Ask about this ${name} report (how a score is worked out, what to fix first) or any SEO and AI-search question.`
                    : 'Ask about this project, or any SEO and AI-search question. This page has no report of its own I can read, so project questions use its overall data.'}
                </p>
                <p className="report-chat__hint">Figures about your site come only from its data. For anything recent I check current sources.</p>
                <div className="report-chat__starters">
                  {starterQuestions(screen).map((q) => (
                    <button key={q} type="button" className="report-chat__starter" onClick={() => send(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <ChatMessage
                key={m.id}
                role={m.role}
                content={m.content}
                pending={m.pending}
                sources={m.sources || []}
                offerExpert={Boolean(m.offerExpert)}
                connectRequested={connectRequested.has(m.id)}
                onConnectExpert={() => connectExpert(m)}
                onNavigate={() => setOpen(false)}
              />
            ))}
            {error && <p className="report-chat__error" role="alert">{error}</p>}
          </div>

          <form
            className="report-chat__form"
            onSubmit={(e) => { e.preventDefault(); send(input); }}
          >
            <textarea
              ref={inputRef}
              className="report-chat__input"
              rows={2}
              maxLength={2000}
              placeholder={name ? `Ask about the ${name} report, or any SEO question…` : 'Ask about this project, or any SEO question…'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
              }}
            />
            <button type="submit" className="report-chat__send" disabled={sending || !input.trim()}>
              {sending ? 'Answering…' : 'Ask'}
            </button>
          </form>
        </div>
      )}
      <button
        type="button"
        className="report-chat-btn"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? 'Close the report assistant' : 'Ask about this report'}
        title="Ask about this report"
        onClick={() => setOpen((o) => !o)}
      >
        <BubbleIcon />
      </button>
    </>,
    document.body,
  );
}
