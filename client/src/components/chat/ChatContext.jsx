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

export function ChatScreenProvider({ children }) {
  const [screen, setScreen] = useState(null);
  const ctxRef = useRef(null);
  const workingRef = useRef(null);

  const register = useCallback((next, ctx, getWorking) => {
    ctxRef.current = ctx;
    workingRef.current = getWorking || null;
    setScreen(next);
  }, []);

  const unregister = useCallback((prev) => {
    setScreen((cur) => {
      if (cur !== prev) return cur;
      ctxRef.current = null;
      workingRef.current = null;
      return null;
    });
  }, []);

  const value = useMemo(() => ({
    screen,
    getCtx: () => ctxRef.current,
    getWorking: () => {
      try { return workingRef.current ? workingRef.current() : null; } catch { return null; }
    },
    register,
    unregister,
    ctxRef,
    workingRef,
  }), [screen, register, unregister]);

  return <ChatScreenContext.Provider value={value}>{children}</ChatScreenContext.Provider>;
}

/** Called by Legend: this screen, with these figures (and this working), is on screen now. */
export function useRegisterChatScreen(screen, ctx, getWorking) {
  const chat = useContext(ChatScreenContext);
  useEffect(() => {
    if (!chat || !screen) return undefined;
    chat.register(screen, ctx, getWorking);
    return () => chat.unregister(screen);
  }, [chat?.register, chat?.unregister, screen]); // eslint-disable-line react-hooks/exhaustive-deps

  // The figures and working update without re-registering the screen.
  useEffect(() => {
    if (!chat || !screen) return;
    chat.ctxRef.current = ctx;
    chat.workingRef.current = getWorking || null;
  });
}

export function useChatScreen() {
  return useContext(ChatScreenContext) || { screen: null, getCtx: () => null, getWorking: () => null };
}
