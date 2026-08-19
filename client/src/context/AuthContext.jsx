import { createContext, useContext, useEffect, useState } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [authState, setAuthState] = useState('loading'); // 'loading' | 'authenticated' | 'unauthenticated'
  const [role, setRole] = useState(null);

  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/verify', { credentials: 'include' });
      const data = await res.json();
      if (data.valid) {
        setRole(data.role);
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
    setAuthState('unauthenticated');
  }

  return (
    <AuthContext.Provider value={{ authState, role, markAuthenticated, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
