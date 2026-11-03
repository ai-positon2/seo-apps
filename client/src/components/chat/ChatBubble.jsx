import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useActiveProject } from '../../lib/useActiveProject';
import { reportChatApi } from '../../lib/reportChatApi';
import { useChatScreen } from './ChatContext';
import ChatMessage from './ChatMessage';
import { buildScreenCopy, screenName, starterQuestions } from './chatModel';

// ── Ask Vimi ────────────────────────────────────────────────────────────────
//
// A floating assistant for the header's project. On a report screen (one that
// renders a Legend) it answers about that report and the project; anywhere
// else, from the project's data alone, and the header says which.
//
// The conversation is the server's: it loads when the panel first opens for a
// project and is kept per person, per project. An answer keeps streaming if
// the panel is closed mid-way, and is there when it opens again.
//
// The launcher sits in the bottom-right corner with the Legend pill to its
// left. Its width changes with its label ("Ask Vimi" / "Close"), so it
// publishes that width as --chat-launcher-w and the Legend positions itself
// from it.

function ChatIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 5h16v11H10l-6 4z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// "/" opens the panel only when the reader is not typing somewhere.
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// The composer grows with its text up to about five lines, then scrolls.
const INPUT_MAX_PX = 110;

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
  const launcherRef = useRef(null);

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
    if (!projectId) return undefined;
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [projectId]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  useLayoutEffect(() => {
    const el = launcherRef.current;
    const root = document.documentElement;
    if (!el) return undefined;
    const publish = () => root.style.setProperty('--chat-launcher-w', `${el.offsetWidth}px`);
    publish();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty('--chat-launcher-w'); };
  }, [projectId]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_PX)}px`;
  }, [input, open]);

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
      setMessages((list) => list
        .filter((m) => !(m.id === tempAnswer.id && !m.content && controller.signal.aborted))
        .map((m) => (m.id === tempAnswer.id ? { ...m, pending: false } : m)));
      setSending(false);
    }
  }, [sending, projectId, screen, getCtx, getWorking]);

  // Stops the answer being written. The server keeps what had arrived, marked
  // as stopped, so the conversation reads the same when it is reloaded.
  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

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
  const reading = `Reading ${name || 'project data'} · ${project.name}`;
  const contextChip = name ? `${name} + project data` : 'Project data';
  const empty = loadedFor === projectId && messages.length === 0;

  return createPortal(
    <>
      {open && (
        <div id={panelId} role="dialog" aria-label="Ask Vimi" className="report-chat">
          <div className="report-chat__head">
            <span className="report-chat__avatar"><SparkleIcon /></span>
            <div className="report-chat__heading">
              <span className="report-chat__title">Vimi</span>
              <span className="report-chat__scope"><span className="report-chat__dot" aria-hidden="true" />{reading}</span>
            </div>
            <button
              type="button"
              className="report-chat__icon-btn"
              aria-label="New conversation"
              title="New conversation"
              onClick={newConversation}
              disabled={sending || messages.length === 0}
            >
              <PlusIcon />
            </button>
            <button type="button" className="report-chat__icon-btn" aria-label="Close" title="Close" onClick={() => setOpen(false)}>
              <CloseIcon size={14} />
            </button>
          </div>

          <div className="report-chat__list" ref={listRef} aria-live="polite">
            {loadError && <p className="report-chat__error">Could not load the conversation: {loadError}</p>}
            {!loadError && loadedFor !== projectId && <p className="report-chat__hint">Loading…</p>}
            {empty && (
              <div className="report-chat__chips">
                {starterQuestions(screen).map((q) => (
                  <button key={q} type="button" className="report-chat__chip" onClick={() => send(q)}>{q}</button>
                ))}
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
            <div className="report-chat__composer">
              <textarea
                ref={inputRef}
                className="report-chat__input"
                rows={1}
                maxLength={2000}
                aria-label="Your question"
                placeholder="Ask anything about this report…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
                }}
              />
              <div className="report-chat__composer-row">
                <span className="report-chat__context"><span className="report-chat__dot" aria-hidden="true" />{contextChip}</span>
                {sending
                  ? <button type="button" className="report-chat__send" onClick={stop}>Stop</button>
                  : (
                    <button type="submit" className="report-chat__send" disabled={!input.trim()}>
                      Ask <ArrowUpIcon />
                    </button>
                  )}
              </div>
            </div>
          </form>
        </div>
      )}
      <button
        ref={launcherRef}
        type="button"
        className="report-chat-btn"
        aria-expanded={open}
        aria-controls={panelId}
        aria-keyshortcuts="/"
        aria-label={open ? 'Close Ask Vimi' : 'Ask Vimi'}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <CloseIcon /> : <ChatIcon />}
        <span>{open ? 'Close' : 'Ask Vimi'}</span>
        <span className="report-chat-btn__key" aria-hidden="true">/</span>
      </button>
    </>,
    document.body,
  );
}
