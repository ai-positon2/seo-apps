import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  broadcastSignOut, classifyVerify, clearReturnPath, installFetchWatcher,
  onCrossTabSignOut, onSessionEnded, rememberReturnPath, resetSessionEnded, retryDelay,
} from '../lib/authEvents';
import { resetActiveProjectCache } from '../lib/useActiveProject';

const AuthContext = createContext(null);

// A tab coming back into view re-checks the session, but not more often than
// this: the cross-tab signal covers sign-outs in this browser, so this is only
// for a session that ended somewhere else (expiry, another device, allowlist).
const RECHECK_ON_FOCUS_MS = 60_000;

export function AuthProvider({ children }) {
  // 'loading' | 'authenticated' | 'unauthenticated' | 'unreachable'
  //   unreachable — /api/auth/verify answered 5xx or not at all. Not a sign-out:
  //   the gate shows a retrying screen and keeps the session cookie.
  const [authState, setAuthState] = useState('loading');
  // Why the sign-in screen is showing, when it was not the user's own choice:
  // 'session_expired' (a 401, or a sign-out in another tab) or null.
  const [signedOutReason, setSignedOutReason] = useState(null);
  const [role, setRole] = useState(null);
  const [email, setEmail] = useState(null);
  const [userId, setUserId] = useState(null);
  const [hasProfile, setHasProfile] = useState(true);
  // UI hint only: it decides whether the admin link is worth showing. Every
  // /api/admin route re-reads the persisted grant server-side (PRD §7.3), so
  // flipping this in a debugger reveals a 403, not a control panel.
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  const stateRef = useRef(authState);
  stateRef.current = authState;
  const retryTimer = useRef(null);
  const attempts = useRef(0);
  const lastChecked = useRef(0);
  // Set while this tab signs itself out: its own broadcast reaches its own
  // listener too (a second BroadcastChannel object in the same tab), and that
  // must not turn a chosen sign-out into a "your session ended" one.
  const signingOut = useRef(false);

  const clearIdentity = useCallback(() => {
    setRole(null);
    setEmail(null);
    setUserId(null);
    setIsPlatformAdmin(false);
    // Per-tab caches of the signed-in user's data go with them, so a next
    // person signing in on this tab never sees the previous list for a moment.
    resetActiveProjectCache();
  }, []);

  // The session ended under this tab (a 401 from requireAuth, or a sign-out in
  // another tab). Remember where the user was, so signing back in returns there.
  const endSession = useCallback((reason) => {
    if (stateRef.current !== 'authenticated' || signingOut.current) return;
    rememberReturnPath(window.location.pathname + window.location.search);
    clearIdentity();
    setSignedOutReason(reason || 'session_expired');
    setAuthState('unauthenticated');
  }, [clearIdentity]);

  /**
   * @param {{ quiet?: boolean }} [opts] quiet: a background re-check that may
   *   only ever sign out — a failed or slow answer leaves a working app alone.
   */
  const checkAuth = useCallback(async ({ quiet = false } = {}) => {
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    lastChecked.current = Date.now();
    let status = null;
    let data = null;
    try {
      const res = await fetch('/api/auth/verify', { credentials: 'include' });
      status = res.status;
      try { data = await res.json(); } catch { data = null; }
    } catch { status = null; }

    const verdict = classifyVerify(status, data);
    if (verdict === 'authenticated') {
      attempts.current = 0;
      signingOut.current = false;
      resetSessionEnded();
      setRole(data.role);
      setEmail(data.email);
      setUserId(data.userId);
      setHasProfile(data.hasProfile !== false);
      setIsPlatformAdmin(data.isPlatformAdmin === true);
      setSignedOutReason(null);
      setAuthState('authenticated');
      return;
    }
    if (verdict === 'unauthenticated') {
      if (quiet) { endSession('session_expired'); return; }
      clearIdentity();
      setAuthState('unauthenticated');
      return;
    }
    // Unreachable. A background re-check says nothing about the session.
    if (quiet) return;
    setAuthState('unreachable');
    const delay = retryDelay(attempts.current);
    attempts.current += 1;
    retryTimer.current = setTimeout(() => { checkAuth(); }, delay);
  }, [clearIdentity, endSession]);

  useEffect(() => {
    checkAuth();
    return () => { if (retryTimer.current) clearTimeout(retryTimer.current); };
  }, [checkAuth]);

  // One place reacts to an ended session, for every request in the app.
  useEffect(() => {
    const uninstall = installFetchWatcher();
    const offEnded = onSessionEnded((reason) => endSession(reason));
    const offCrossTab = onCrossTabSignOut(() => endSession('session_expired'));
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (stateRef.current !== 'authenticated') return;
      if (Date.now() - lastChecked.current < RECHECK_ON_FOCUS_MS) return;
      checkAuth({ quiet: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      uninstall();
      offEnded();
      offCrossTab();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [endSession, checkAuth]);

  function markAuthenticated(userRole) {
    setRole(userRole || 'seo');
    setAuthState('authenticated');
  }

  async function logout() {
    signingOut.current = true;
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    // The user chose to leave: no "session ended" note, nowhere to return to.
    clearReturnPath();
    broadcastSignOut();
    clearIdentity();
    setSignedOutReason(null);
    setAuthState('unauthenticated');
  }

  return (
    <AuthContext.Provider value={{
      authState, signedOutReason, role, email, userId, hasProfile, isPlatformAdmin,
      markAuthenticated, logout, checkAuth,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
