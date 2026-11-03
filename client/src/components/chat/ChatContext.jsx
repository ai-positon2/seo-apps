import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

// ── Which report is on screen, for the assistant ────────────────────────────
//
// Every report screen already renders <Legend screen ctx>, with exactly the
// figures its info icons explain. Legend registers that here, so the assistant
// knows the report a reader is looking at without each page wiring it up — and
// when a page has no legend, the assistant knows it can see project data only.
//
// The figures sit in a ref: they change on every render of a report, and the
// panel needs them only at the moment a question is sent.
//
// A report can also hand over its WORKING: the per-item inputs its scores are
// computed from (every rule a crawl failed and the points it cost, every check
// and its weight). That is what lets the assistant rebuild a figure like
// "warnings −22" from its parts. It is a function, called only when a question
// is sent, so a report pays nothing for it while nobody is asking.

const ChatScreenContext = createContext(null);

// Registrations are kept as a stack, newest last: a page can register its
// screen for every tab while a panel inside it registers the same screen too,
// and when the panel unmounts the page's registration takes over again. With a
// single slot, the Tech Audit screen was cleared whenever its Overview tab
// closed (opening an issue switches tab), and the assistant answered from
// project data only, without the report's working.
export function ChatScreenProvider({ children }) {
  const [screen, setScreen] = useState(null);
  const entries = useRef(new Map()); // token -> { screen, ctx, getWorking }
  const top = () => [...entries.current.values()].pop() || null;

  const register = useCallback((token, next, ctx, getWorking) => {
    entries.current.delete(token);
    entries.current.set(token, { screen: next, ctx, getWorking: getWorking || null });
    setScreen(next);
  }, []);

  const unregister = useCallback((token) => {
    entries.current.delete(token);
    setScreen(top()?.screen || null);
  }, []);

  /** The figures and working update without re-registering the screen. */
  const update = useCallback((token, ctx, getWorking) => {
    const entry = entries.current.get(token);
    if (entry) { entry.ctx = ctx; entry.getWorking = getWorking || null; }
  }, []);

  const value = useMemo(() => ({
    screen,
    getCtx: () => top()?.ctx || null,
    getWorking: () => {
      const fn = top()?.getWorking;
      try { return fn ? fn() : null; } catch { return null; }
    },
    register,
    unregister,
    update,
  }), [screen, register, unregister, update]);

  return <ChatScreenContext.Provider value={value}>{children}</ChatScreenContext.Provider>;
}

/** This screen, with these figures (and this working), is on screen now. Used by Legend and by report pages. */
export function useRegisterChatScreen(screen, ctx, getWorking) {
  const chat = useContext(ChatScreenContext);
  const token = useRef(null);
  if (!token.current) token.current = {};
  useEffect(() => {
    if (!chat || !screen) return undefined;
    const t = token.current;
    chat.register(t, screen, ctx, getWorking);
    return () => chat.unregister(t);
  }, [chat?.register, chat?.unregister, screen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!chat || !screen) return;
    chat.update(token.current, ctx, getWorking);
  });
}

export function useChatScreen() {
  return useContext(ChatScreenContext) || { screen: null, getCtx: () => null, getWorking: () => null };
}
