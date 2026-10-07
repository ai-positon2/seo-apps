import { createContext, useContext, useEffect, useState } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [authState, setAuthState] = useState('loading'); // 'loading' | 'authenticated' | 'unauthenticated'
  const [role, setRole] = useState(null);
  const [email, setEmail] = useState(null);
  const [userId, setUserId] = useState(null);
  const [hasProfile, setHasProfile] = useState(true);
  // UI hint only: it decides whether the admin link is worth showing. Every
  // /api/admin route re-reads the persisted grant server-side (PRD §7.3), so
  // flipping this in a debugger reveals a 403, not a control panel.
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/verify', { credentials: 'include' });
      const data = await res.json();
      if (data.valid) {
        setRole(data.role);
        setEmail(data.email);
        setUserId(data.userId);
        setHasProfile(data.hasProfile !== false);
        setIsPlatformAdmin(data.isPlatformAdmin === true);
        setAuthState('authenticated');
      } else {
        setAuthState('unauthenticated');
      }
    } catch (e) {
      setAuthState('unauthenticated');
    }
  }

  useEffect(() => { checkAuth(); }, []);

  function markAuthenticated(userRole) {
    setRole(userRole || 'seo');
    setAuthState('authenticated');
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    setRole(null);
    setEmail(null);
    setUserId(null);
    setIsPlatformAdmin(false);
    setAuthState('unauthenticated');
  }

  return (
    <AuthContext.Provider value={{ authState, role, email, userId, hasProfile, isPlatformAdmin, markAuthenticated, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
