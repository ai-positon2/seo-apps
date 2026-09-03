const params = new URLSearchParams(window.location.search);
const ERROR_MESSAGES = {
  access_denied: 'Sign-in was cancelled.',
  unauthorized: "That Google account isn't authorized for this app.",
  login_failed: 'Something went wrong signing you in. Please try again.',
};

export default function LoginPage() {
  const error = ERROR_MESSAGES[params.get('error')];

  // Local-dev-only escape hatch — see server/routes/auth.js POST /dev-login.
  // import.meta.env.DEV is Vite's own dev-vs-build flag, so this never
  // renders in a production bundle regardless of anything server-side.
  async function devLogin() {
    const res = await fetch('/api/auth/dev-login', { method: 'POST', credentials: 'include' });
    if (res.ok) window.location.href = '/';
  }

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <div style={{
        width: 320,
        padding: '32px 28px',
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
        textAlign: 'center',
      }}>
        <div style={{
          width: 40,
          height: 40,
          margin: '0 auto 16px',
          borderRadius: 8,
          background: 'var(--primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-on-primary)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 10.607z" />
          </svg>
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
          SEO Studio
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 24 }}>
          Sign in to continue
        </div>

        {error && (
          <div style={{
            fontSize: 12,
            color: 'var(--viz-neg)',
            background: 'color-mix(in srgb, var(--viz-neg) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--viz-neg) 28%, transparent)',
            borderRadius: 8,
            padding: '8px 10px',
            marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        <a
          href="/api/auth/google"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            width: '100%',
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--text)',
            fontSize: 13,
            fontWeight: 600,
            textDecoration: 'none',
            boxSizing: 'border-box',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 48 48">
            <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
            <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
            <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0124 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
            <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.003-.002 6.19 5.238C40.045 36.169 44 30.638 44 24c0-1.341-.138-2.65-.389-3.917z"/>
          </svg>
          Sign in with Google
        </a>

        {import.meta.env.DEV && (
          <button
            onClick={devLogin}
            style={{
              width: '100%',
              marginTop: 10,
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px dashed var(--border)',
              background: 'transparent',
              color: 'var(--text-3)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              boxSizing: 'border-box',
            }}
          >
            Continue as dev user (local only)
          </button>
        )}
      </div>
    </div>
  );
}
