import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

export default function ProfileSetupPage() {
  const { email, checkAuth } = useAuth();
  const [fullName, setFullName] = useState('');
  const [company, setCompany] = useState('');
  const [companyLocked, setCompanyLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/profile', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        setCompanyLocked(data.companyLocked);
        if (data.companyLocked) setCompany(data.lockedCompanyName);
        if (data.profile) {
          setFullName(data.profile.full_name || '');
          if (!data.companyLocked) setCompany(data.profile.company || '');
        }
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, company }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save profile.');
      await checkAuth();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  if (loading) {
    return <div style={{ height: '100vh', background: 'var(--bg)' }} />;
  }

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <form onSubmit={handleSubmit} style={{
        width: 360,
        padding: '32px 28px',
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
          Complete your profile
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 24 }}>
          Signed in as {email}
        </div>

        {error && (
          <div style={{
            fontSize: 12, color: '#f87171', background: 'rgba(248,113,113,0.10)',
            border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '8px 10px', marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
          Full name
        </label>
        <input
          value={fullName}
          onChange={e => setFullName(e.target.value)}
          required
          placeholder="Jane Doe"
          style={inputStyle}
        />

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', margin: '16px 0 6px' }}>
          Company
        </label>
        <input
          value={company}
          onChange={e => setCompany(e.target.value)}
          disabled={companyLocked}
          required
          placeholder="Acme Inc."
          style={{ ...inputStyle, ...(companyLocked ? { opacity: 0.65, cursor: 'not-allowed' } : {}) }}
        />
        {companyLocked && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
            Locked to Position2 for @position2.com accounts.
          </div>
        )}

        <button type="submit" disabled={saving} style={{
          width: '100%',
          marginTop: 24,
          padding: '10px 14px',
          borderRadius: 8,
          border: 'none',
          background: 'var(--primary)',
          color: 'white',
          fontSize: 13,
          fontWeight: 600,
          cursor: saving ? 'default' : 'pointer',
          opacity: saving ? 0.7 : 1,
        }}>
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text)',
  fontSize: 13,
  boxSizing: 'border-box',
  outline: 'none',
};
