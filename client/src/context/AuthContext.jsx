import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { RETRY_SCHEDULE_MS, afterFailure, retryDelayMs, verifySession } from '../lib/authCheck';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // 'loading'         first check in flight
  // 'reconnecting'    no answer yet; retrying with back-off (splash stays up)
  // 'unreachable'     no answer for a minute; App shows an error with "Try again"
  // 'authenticated' | 'unauthenticated'   the server answered
  // Only the server's own answer moves anyone to 'unauthenticated' — see
  // lib/authCheck.js for what counts as one.
  const [authState, setAuthStateValue] = useState('loading');
  const [role, setRole] = useState(null);
  const [email, setEmail] = useState(null);
  const [userId, setUserId] = useState(null);
  const [hasProfile, setHasProfile] = useState(true);
  // UI hint only: it decides whether the admin link is worth showing. Every
  // /api/admin route re-reads the persisted grant server-side (PRD §7.3), so
  // flipping this in a debugger reveals a 403, not a control panel.
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  // The retry loop reads the current state from a ref rather than closing over
  // it, so checkAuth can stay a stable callback (and the memoised value below
  // does not change identity on every attempt).
  const authStateRef = useRef('loading');
  const setAuthState = useCallback((next) => {
    authStateRef.current = next;
    setAuthStateValue(next);
  }, []);

  // `gen` identifies the current check. Anything that starts a new one, ends
  // the session, or unmounts the provider bumps it, and a response or timer
  // from an older generation is dropped — so a retry scheduled before logout
  // can never flip the user back to 'authenticated'.
  const retryRef = useRef({ gen: 0, timer: null, abort: null, failures: 0, failingSince: null });

  const stopRetrying = useCallback(() => {
    const r = retryRef.current;
    r.gen += 1;
    clearTimeout(r.timer);
    r.timer = null;
    r.abort?.abort();
    r.abort = null;
    r.failures = 0;
    r.failingSince = null;
    return r.gen;
  }, []);

  const attempt = useCallback(async (gen) => {
    const r = retryRef.current;
    const controller = new AbortController();
    r.abort = controller;
    const { outcome, retryAfterMs } = await verifySession({ signal: controller.signal });
    if (gen !== r.gen) return;
    r.abort = null;

    if (outcome.kind === 'authenticated') {
      const s = outcome.session;
      r.failures = 0;
      r.failingSince = null;
      setRole(s.role);
      setEmail(s.email);
      setUserId(s.userId);
      setHasProfile(s.hasProfile);
      setIsPlatformAdmin(s.isPlatformAdmin);
      setAuthState('authenticated');
      return;
    }
    if (outcome.kind === 'signed-out') {
      r.failures = 0;
      r.failingSince = null;
      setAuthState('unauthenticated');
      return;
    }

    // No answer (429, 5xx, not JSON, offline): not evidence of anything about
    // the session, so back off and ask again instead of signing anyone out.
    r.failures += 1;
    if (r.failingSince == null) r.failingSince = Date.now();
    const { state, retry } = afterFailure(authStateRef.current, r.failingSince);
    setAuthState(state);
    if (retry) {
      r.timer = setTimeout(() => { attempt(gen); }, retryDelayMs(r.failures, retryAfterMs));
    }
  }, [setAuthState]);

  // Resolves once the first attempt has settled (ProfileSetupPage awaits it);
  // any retries continue on timers after that.
  const checkAuth = useCallback(() => {
    const r = retryRef.current;
    // "Try again" on the unreachable screen: show the splash while it runs, but
    // keep the failure clock, so if this attempt fails too the user is told so
    // at once rather than after another minute of "Reconnecting…".
    const fromUnreachable = authStateRef.current === 'unreachable';
    const failingSince = r.failingSince;
    const gen = stopRetrying();
    if (fromUnreachable) {
      r.failingSince = failingSince;
      r.failures = RETRY_SCHEDULE_MS.length;
      setAuthState('reconnecting');
    }
    return attempt(gen);
  }, [attempt, setAuthState, stopRetrying]);

  useEffect(() => {
    checkAuth();
    return () => { stopRetrying(); };
  }, [checkAuth, stopRetrying]);

  const markAuthenticated = useCallback((userRole) => {
    stopRetrying();
    setRole(userRole || 'seo');
    setAuthState('authenticated');
  }, [setAuthState, stopRetrying]);

  const logout = useCallback(async () => {
    stopRetrying();
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    setRole(null);
    setEmail(null);
    setUserId(null);
    setIsPlatformAdmin(false);
    setAuthState('unauthenticated');
  }, [setAuthState, stopRetrying]);

  const value = useMemo(
    () => ({ authState, role, email, userId, hasProfile, isPlatformAdmin, markAuthenticated, logout, checkAuth }),
    [authState, role, email, userId, hasProfile, isPlatformAdmin, markAuthenticated, logout, checkAuth],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
