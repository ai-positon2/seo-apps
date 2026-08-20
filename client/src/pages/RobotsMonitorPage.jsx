import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { rm } from '../lib/robotsMonitorApi';
import ModuleRuns from '../components/ModuleRuns';

// ── Icons ─────────────────────────────────────────────────────────────────────

function RobotIcon({ style }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={{ width: '1rem', height: '1rem', ...style }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
    </svg>
  );
}

function ChevronDown({ style }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={{ width: '1rem', height: '1rem', ...style }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ChevronUp({ style }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={{ width: '1rem', height: '1rem', ...style }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={{ width: '0.875rem', height: '0.875rem', color: 'var(--text-3)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  );
}

// ── Shared input style ─────────────────────────────────────────────────────────

function FocusInput({ type = 'text', value, onChange, onKeyDown, placeholder, autoFocus, style: extraStyle }) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: '100%',
        fontSize: '0.875rem',
        border: `1px solid ${focused ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: '6px',
        padding: '0.5rem 0.75rem',
        outline: 'none',
        boxShadow: focused ? '0 0 0 2px var(--primary-soft)' : 'none',
        background: 'var(--card)',
        color: 'var(--text)',
        boxSizing: 'border-box',
        ...extraStyle,
      }}
    />
  );
}

function FocusSelect({ value, onChange, children, style: extraStyle }) {
  const [focused, setFocused] = useState(false);
  return (
    <select
      value={value}
      onChange={onChange}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: '100%',
        fontSize: '0.875rem',
        border: `1px solid ${focused ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: '6px',
        padding: '0.5rem 0.75rem',
        outline: 'none',
        boxShadow: focused ? '0 0 0 2px var(--primary-soft)' : 'none',
        background: 'var(--card)',
        color: 'var(--text)',
        appearance: 'none',
        WebkitAppearance: 'none',
        boxSizing: 'border-box',
        ...extraStyle,
      }}
    >
      {children}
    </select>
  );
}

// ── Env badge ──────────────────────────────────────────────────────────────────

function EnvBadge({ env }) {
  const isProd = env === 'production';
  return (
    <span style={{
      fontSize: '0.75rem',
      fontWeight: 600,
      padding: '0.125rem 0.5rem',
      borderRadius: '9999px',
      background: isProd ? 'var(--success-soft, #D1FAE5)' : 'var(--warning-soft, #FEF3C7)',
      color: isProd ? 'var(--success, #065F46)' : 'var(--warning-text, #92400E)',
    }}>{env}</span>
  );
}

// ── Toggle switch ──────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      title={checked ? 'Disable' : 'Enable'}
      style={{
        position: 'relative',
        display: 'inline-flex',
        height: '1.25rem',
        width: '2.25rem',
        borderRadius: '9999px',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--primary)' : 'var(--border)',
        transition: 'background 0.2s',
        padding: 0,
        flexShrink: 0,
      }}
    >
      <span style={{
        display: 'inline-block',
        height: '1rem',
        width: '1rem',
        marginTop: '0.125rem',
        borderRadius: '9999px',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        transform: checked ? 'translateX(1.125rem)' : 'translateX(0.125rem)',
        transition: 'transform 0.2s',
      }} />
    </button>
  );
}

// ── Header ────────────────────────────────────────────────────────────────────

function Header() {
  const navigate = useNavigate();
  return (
    <header style={{
      background: 'var(--card)',
      borderBottom: '1px solid var(--border)',
      height: '3.5rem',
      display: 'flex',
      alignItems: 'center',
      padding: '0 1.5rem',
      flexShrink: 0,
    }}>
      <div style={{ maxWidth: '64rem', margin: '0 auto', width: '100%', display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
        <button
          onClick={() => navigate('/')}
          style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', background: 'none', border: 'none', cursor: 'pointer', padding: 0, opacity: 1, transition: 'opacity 0.15s' }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.8'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          <div style={{
            width: '1.75rem', height: '1.75rem',
            borderRadius: '6px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--primary)',
          }}>
            <RobotIcon style={{ color: '#fff' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <span style={{ fontWeight: 700, color: 'var(--text)', fontSize: '0.875rem', letterSpacing: '-0.01em' }}>Robots Monitor</span>
            <span style={{ color: 'var(--text-3)', fontSize: '0.875rem' }}>· Arena</span>
          </div>
        </button>
      </div>
    </header>
  );
}

// ── Toast banner ──────────────────────────────────────────────────────────────

function Toast({ message, type = 'error', onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);

  const styles = {
    error:   { background: 'var(--danger-soft, #FEF2F2)',   border: '1px solid var(--danger-border, #FECACA)',   color: 'var(--danger)' },
    success: { background: 'var(--success-soft, #D1FAE5)',  border: '1px solid var(--success-border, #6EE7B7)',  color: 'var(--success, #065F46)' },
    info:    { background: 'var(--primary-soft)',            border: '1px solid var(--primary)',                  color: 'var(--primary-text)' },
  };
  const s = styles[type] || styles.error;

  return (
    <div style={{
      position: 'fixed', top: '1rem', right: '1rem', zIndex: 50,
      ...s,
      borderRadius: 'var(--r-lg)',
      padding: '0.75rem 1rem',
      fontSize: '0.875rem',
      maxWidth: '28rem',
      boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
        <span style={{ flex: 1 }}>{message}</span>
        <button onClick={onClose} style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', opacity: 0.6, fontSize: '1rem', lineHeight: 1 }}>✕</button>
      </div>
    </div>
  );
}

// ── Nav tabs ──────────────────────────────────────────────────────────────────

function MonitorNav({ active, onChange }) {
  const tabs = [
    { id: 'clients', label: 'Clients' },
    { id: 'history', label: 'History' },
    { id: 'settings', label: 'Settings' },
  ];
  return (
    <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--card)' }}>
      <div style={{ maxWidth: '64rem', margin: '0 auto', padding: '0 1.5rem', display: 'flex', gap: 0 }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            style={{
              padding: '0.75rem 1rem',
              fontSize: '0.875rem',
              fontWeight: 500,
              border: 'none',
              borderBottom: `2px solid ${active === tab.id ? 'var(--primary)' : 'transparent'}`,
              color: active === tab.id ? 'var(--primary)' : 'var(--text-2)',
              background: 'none',
              cursor: 'pointer',
              transition: 'color 0.15s',
            }}
            onMouseEnter={e => { if (active !== tab.id) e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { if (active !== tab.id) e.currentTarget.style.color = 'var(--text-2)'; }}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Domain form ───────────────────────────────────────────────────────────────

function DomainForm({ onSave, onCancel, initial = {} }) {
  const [url, setUrl] = useState(initial.url || '');
  const [env, setEnv] = useState(initial.env || 'production');
  const [useAuth, setUseAuth] = useState(!!initial.auth);
  const [username, setUsername] = useState(initial.auth?.username || '');
  const [password, setPassword] = useState(initial.auth?.password || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function validateUrl(val) {
    try {
      const u = new URL(val);
      if (!['http:', 'https:'].includes(u.protocol)) return 'URL must start with http:// or https://';
      if (u.pathname.replace(/\/$/, '').length > 0) return 'Subfolders are not supported — use the subdomain only (e.g., staging.example.com)';
      return null;
    } catch {
      return 'Enter a valid URL';
    }
  }

  async function handleSave() {
    const urlErr = validateUrl(url);
    if (urlErr) return setError(urlErr);
    if (useAuth && (!username.trim() || !password)) return setError('Username and password are required for basic auth');
    setError('');
    setSaving(true);
    try {
      await onSave({ url, env, auth: useAuth ? { username: username.trim(), password } : null });
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '1rem',
      background: 'var(--surface)',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.75rem',
    }}>
      <div>
        <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)', marginBottom: '0.25rem' }}>Domain URL</label>
        <FocusInput type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com" />
      </div>
      <div>
        <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)', marginBottom: '0.25rem' }}>Environment</label>
        <div style={{ display: 'flex', gap: '1rem' }}>
          {['production', 'staging'].map(e => (
            <label key={e} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text)' }}>
              <input type="radio" name="env" value={e} checked={env === e} onChange={() => setEnv(e)} style={{ accentColor: 'var(--primary)' }} />
              {e.charAt(0).toUpperCase() + e.slice(1)}
            </label>
          ))}
        </div>
      </div>
      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text)' }}>
          <input type="checkbox" checked={useAuth} onChange={e => setUseAuth(e.target.checked)} style={{ accentColor: 'var(--primary)' }} />
          This domain requires basic auth
        </label>
      </div>
      {useAuth && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)', marginBottom: '0.25rem' }}>Username</label>
            <FocusInput value={username} onChange={e => setUsername(e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)', marginBottom: '0.25rem' }}>Password</label>
            <FocusInput type="password" value={password} onChange={e => setPassword(e.target.value)} />
          </div>
        </div>
      )}
      {error && <p style={{ fontSize: '0.75rem', color: 'var(--danger)', margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '0.375rem 0.75rem',
            fontSize: '0.75rem',
            fontWeight: 500,
            borderRadius: '6px',
            border: 'none',
            color: '#fff',
            background: 'var(--primary)',
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save Domain'}
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '0.375rem 0.75rem',
            fontSize: '0.75rem',
            fontWeight: 500,
            borderRadius: '6px',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            background: 'var(--card)',
            cursor: 'pointer',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
          onMouseLeave={e => e.currentTarget.style.background = 'var(--card)'}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Domain row ────────────────────────────────────────────────────────────────

function DomainRow({ domain, clientId, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toggling, setToggling] = useState(false);

  async function handleToggle() {
    setToggling(true);
    try {
      const updated = await rm.updateDomain(clientId, domain.id, { enabled: !domain.enabled });
      onUpdate(updated);
    } finally {
      setToggling(false);
    }
  }

  async function handleSave(fields) {
    const updated = await rm.updateDomain(clientId, domain.id, fields);
    onUpdate(updated);
    setEditing(false);
  }

  async function handleDelete() {
    await rm.deleteDomain(clientId, domain.id);
    onDelete(domain.id);
  }

  if (editing) {
    return <DomainForm initial={domain} onSave={handleSave} onCancel={() => setEditing(false)} />;
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      padding: '0.625rem 0.75rem',
      borderRadius: '8px',
      opacity: domain.enabled ? 1 : 0.5,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>{domain.url}</span>
          {domain.auth && <LockIcon />}
          <EnvBadge env={domain.env} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
        <Toggle checked={domain.enabled} onChange={handleToggle} disabled={toggling} />
        <button
          onClick={() => setEditing(true)}
          style={{ fontSize: '0.75rem', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-2)'}
        >Edit</button>
        {confirmDelete ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>Delete?</span>
            <button onClick={handleDelete} style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}>Yes</button>
            <button onClick={() => setConfirmDelete(false)} style={{ fontSize: '0.75rem', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer' }}>No</button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            style={{ fontSize: '0.75rem', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--danger)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-2)'}
          >Delete</button>
        )}
      </div>
    </div>
  );
}

// ── Client card ───────────────────────────────────────────────────────────────

function ClientCard({ client, onChange, onDelete }) {
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(client.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingDomain, setAddingDomain] = useState(false);
  const [domains, setDomains] = useState(client.domains || []);
  const [nameError, setNameError] = useState('');

  async function saveName() {
    if (!nameVal.trim()) return setNameError('Name is required');
    try {
      await rm.updateClient(client.id, { name: nameVal.trim() });
      onChange({ ...client, name: nameVal.trim() });
      setEditingName(false);
      setNameError('');
    } catch (e) {
      setNameError(e.message);
    }
  }

  async function handleAddDomain(fields) {
    const domain = await rm.addDomain(client.id, fields);
    setDomains(prev => [...prev, domain]);
    setAddingDomain(false);
  }

  function handleDomainUpdate(updated) {
    setDomains(prev => prev.map(d => d.id === updated.id ? updated : d));
  }

  function handleDomainDelete(domainId) {
    setDomains(prev => prev.filter(d => d.id !== domainId));
  }

  async function handleDeleteClient() {
    await rm.deleteClient(client.id);
    onDelete(client.id);
  }

  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '1.25rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.75rem',
      boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
    }}>
      {/* Client header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {editingName ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
            <FocusInput
              value={nameVal}
              onChange={e => setNameVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
              autoFocus
              style={{ flex: 1, fontWeight: 600 }}
            />
            <button onClick={saveName} style={{ fontSize: '0.75rem', color: 'var(--primary)', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>Save</button>
            <button onClick={() => { setEditingName(false); setNameVal(client.name); }} style={{ fontSize: '0.75rem', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
            {nameError && <span style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>{nameError}</span>}
          </div>
        ) : (
          <h3 style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.875rem', margin: 0 }}>{client.name}</h3>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.75rem' }}>
          {!editingName && (
            <button
              onClick={() => setEditingName(true)}
              style={{ fontSize: '0.75rem', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-2)'}
            >Rename</button>
          )}
          {confirmDelete ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>Delete client + all domains?</span>
              <button onClick={handleDeleteClient} style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}>Yes</button>
              <button onClick={() => setConfirmDelete(false)} style={{ fontSize: '0.75rem', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer' }}>No</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{ fontSize: '0.75rem', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--danger)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-2)'}
            >Delete</button>
          )}
        </div>
      </div>

      {/* Domains */}
      {domains.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
          {domains.map(d => (
            <DomainRow
              key={d.id}
              domain={d}
              clientId={client.id}
              onUpdate={handleDomainUpdate}
              onDelete={handleDomainDelete}
            />
          ))}
        </div>
      ) : (
        <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', margin: '0.25rem 0' }}>No domains yet — add one below.</p>
      )}

      {/* Add domain */}
      {addingDomain ? (
        <DomainForm onSave={handleAddDomain} onCancel={() => setAddingDomain(false)} />
      ) : (
        <button
          onClick={() => setAddingDomain(true)}
          style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', padding: 0 }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.8'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          <span style={{ fontSize: '1rem', lineHeight: 1 }}>+</span> Add Domain
        </button>
      )}
    </div>
  );
}

// ── Clients tab ───────────────────────────────────────────────────────────────

function ClientsTab({ showToast }) {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addingClient, setAddingClient] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [addError, setAddError] = useState('');

  useEffect(() => {
    rm.clients()
      .then(setClients)
      .catch(e => showToast(e.message, 'error'))
      .finally(() => setLoading(false));
  }, []);

  async function handleAddClient() {
    if (!newClientName.trim()) return setAddError('Name is required');
    try {
      const client = await rm.addClient({ name: newClientName.trim() });
      setClients(prev => [...prev, { ...client, domains: [] }]);
      setNewClientName('');
      setAddingClient(false);
      setAddError('');
    } catch (e) {
      setAddError(e.message);
    }
  }

  if (loading) return <div style={{ padding: '3rem 0', textAlign: 'center', fontSize: '0.875rem', color: 'var(--text-3)' }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {clients.length === 0 && !addingClient && (
        <div style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          padding: '2rem',
          textAlign: 'center',
        }}>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginBottom: '0.75rem' }}>No clients yet — add one to get started.</p>
          <button
            onClick={() => setAddingClient(true)}
            style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, borderRadius: 'var(--r-md, 8px)', border: 'none', color: '#fff', background: 'var(--primary)', cursor: 'pointer' }}
          >
            Add Client
          </button>
        </div>
      )}

      {clients.map(c => (
        <ClientCard
          key={c.id}
          client={c}
          onChange={updated => setClients(prev => prev.map(x => x.id === updated.id ? updated : x))}
          onDelete={id => setClients(prev => prev.filter(x => x.id !== id))}
        />
      ))}

      {addingClient ? (
        <div style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        }}>
          <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)' }}>Client Name</label>
          <FocusInput
            value={newClientName}
            onChange={e => setNewClientName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAddClient(); if (e.key === 'Escape') setAddingClient(false); }}
            autoFocus
            placeholder="e.g. Riccobene Associates"
          />
          {addError && <p style={{ fontSize: '0.75rem', color: 'var(--danger)', margin: 0 }}>{addError}</p>}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={handleAddClient}
              style={{ padding: '0.375rem 0.75rem', fontSize: '0.75rem', fontWeight: 500, borderRadius: '6px', border: 'none', color: '#fff', background: 'var(--primary)', cursor: 'pointer' }}
            >Add Client</button>
            <button
              onClick={() => { setAddingClient(false); setNewClientName(''); setAddError(''); }}
              style={{ padding: '0.375rem 0.75rem', fontSize: '0.75rem', fontWeight: 500, borderRadius: '6px', border: '1px solid var(--border)', color: 'var(--text)', background: 'var(--card)', cursor: 'pointer' }}
            >Cancel</button>
          </div>
        </div>
      ) : clients.length > 0 && (
        <button
          onClick={() => setAddingClient(true)}
          style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.8'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          + Add Client
        </button>
      )}
    </div>
  );
}

// ── Run detail panel ──────────────────────────────────────────────────────────

function SitemapBadge({ status, error }) {
  if (status === 'found') return (
    <span style={{ fontSize: '0.75rem', background: 'var(--success-soft, #D1FAE5)', color: 'var(--success, #065F46)', padding: '0.125rem 0.5rem', borderRadius: '9999px' }}>Sitemap found</span>
  );
  if (status === 'not-found') return (
    <span style={{ fontSize: '0.75rem', background: 'var(--warning-soft, #FEF3C7)', color: 'var(--warning-text, #92400E)', padding: '0.125rem 0.5rem', borderRadius: '9999px' }}>No sitemap — homepage only</span>
  );
  return (
    <span style={{ fontSize: '0.75rem', background: 'var(--danger-soft, #FEF2F2)', color: 'var(--danger)', padding: '0.125rem 0.5rem', borderRadius: '9999px' }}>Sitemap error{error ? `: ${error}` : ''}</span>
  );
}

const SIGNAL_LABELS = {
  'x-robots-header': 'X-Robots-Tag',
  'meta-tag': 'meta robots',
  'both': 'X-Robots-Tag + meta',
};

function PageResultRow({ page, env }) {
  const isIssue = page.error ? false
    : env === 'production' ? page.noindex
    : !page.noindex;

  const signalLabel = page.signal ? (SIGNAL_LABELS[page.signal] || page.signal) : 'no noindex';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: '0.5rem',
      padding: '0.375rem 0',
      fontSize: '0.75rem',
      borderBottom: '1px solid var(--surface)',
    }}>
      <span style={{ marginTop: '0.125rem', flexShrink: 0, fontWeight: 700, color: isIssue ? 'var(--danger)' : 'var(--success, #059669)' }}>
        {isIssue ? '✗' : '✓'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '18rem' }}>{page.url}</span>
          <span style={{ color: 'var(--text-3)' }}>·</span>
          <span style={{ color: 'var(--text-3)' }}>{page.pageType}</span>
          <span style={{
            padding: '0.0625rem 0.375rem',
            borderRadius: '4px',
            fontSize: '0.625rem',
            fontWeight: 500,
            background: page.noindex ? 'var(--danger-soft, #FEF2F2)' : 'var(--surface)',
            color: page.noindex ? 'var(--danger)' : 'var(--text-2)',
          }}>
            {signalLabel}
          </span>
          {page.httpStatus && page.httpStatus !== 200 && (
            <span style={{ background: 'var(--surface)', color: 'var(--text-2)', padding: '0.0625rem 0.375rem', borderRadius: '4px', fontSize: '0.625rem' }}>HTTP {page.httpStatus}</span>
          )}
        </div>
        {page.redirected && page.finalUrl !== page.url && (
          <div style={{ color: 'var(--text-3)', marginTop: '0.125rem' }}>↳ {page.finalUrl}</div>
        )}
        {page.error && <div style={{ color: 'var(--danger)', marginTop: '0.125rem' }}>{page.error}</div>}
      </div>
    </div>
  );
}

function DomainResultSection({ domain }) {
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '0.75rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.5rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{domain.url}</span>
        <EnvBadge env={domain.env} />
        <SitemapBadge status={domain.sitemapStatus} error={domain.error} />
      </div>
      {domain.issues?.length > 0 && (
        <div style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--danger)' }}>{domain.issues.length} issue{domain.issues.length !== 1 ? 's' : ''} found</div>
      )}
      {domain.pagesChecked?.length > 0 && (
        <div style={{ marginTop: '0.25rem' }}>
          {domain.pagesChecked.map((p, i) => <PageResultRow key={i} page={p} env={domain.env} />)}
        </div>
      )}
    </div>
  );
}

function RunDetailPanel({ runId }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    rm.runDetail(runId).then(setDetail).finally(() => setLoading(false));
  }, [runId]);

  if (loading) return <div style={{ padding: '1rem 0', fontSize: '0.75rem', color: 'var(--text-3)' }}>Loading run detail…</div>;
  if (!detail) return <div style={{ padding: '1rem 0', fontSize: '0.75rem', color: 'var(--danger)' }}>Failed to load run detail.</div>;

  const durationSec = Math.round((detail.durationMs || 0) / 1000);

  return (
    <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {(detail.clients || []).map(client => (
        <div key={client.clientId}>
          <h4 style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{client.clientName}</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {(client.domains || []).map(d => <DomainResultSection key={d.domainId} domain={d} />)}
          </div>
        </div>
      ))}
      <div style={{ fontSize: '0.75rem', color: 'var(--text-3)', paddingTop: '0.25rem' }}>
        Run ID: <span style={{ fontFamily: 'var(--font-mono)' }}>{detail.runId}</span> · {detail.summary?.totalPagesChecked || 0} pages · {durationSec}s
      </div>
    </div>
  );
}

// ── History tab ───────────────────────────────────────────────────────────────

function RunSummaryRow({ run }) {
  const [expanded, setExpanded] = useState(false);
  const issueCount = run.summary?.issuesFound || 0;
  const date = new Date(run.startedAt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      overflow: 'hidden',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    }}>
      <button
        onClick={() => setExpanded(x => !x)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1rem 1.25rem',
          background: 'var(--card)',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
        onMouseLeave={e => e.currentTarget.style.background = 'var(--card)'}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{date}</span>
          <span style={{
            fontSize: '0.75rem',
            padding: '0.125rem 0.5rem',
            borderRadius: '9999px',
            fontWeight: 500,
            background: run.triggeredBy === 'manual' ? 'var(--primary-soft)' : 'var(--surface)',
            color: run.triggeredBy === 'manual' ? 'var(--primary-text)' : 'var(--text-2)',
          }}>{run.triggeredBy === 'manual' ? 'Manual' : 'Scheduled'}</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-2)' }}>{run.summary?.totalDomains || 0} domains</span>
          <span style={{
            fontSize: '0.75rem',
            fontWeight: 600,
            padding: '0.125rem 0.5rem',
            borderRadius: '9999px',
            background: issueCount > 0 ? 'var(--danger-soft, #FEF2F2)' : 'var(--success-soft, #D1FAE5)',
            color: issueCount > 0 ? 'var(--danger)' : 'var(--success, #065F46)',
          }}>
            {issueCount > 0 ? `${issueCount} issue${issueCount !== 1 ? 's' : ''}` : 'Clean'}
          </span>
        </div>
        <span style={{ color: 'var(--text-3)', flexShrink: 0, marginLeft: '0.5rem' }}>
          {expanded ? <ChevronUp /> : <ChevronDown />}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: '0 1.25rem 1.25rem', background: 'var(--card)', borderTop: '1px solid var(--surface)' }}>
          <RunDetailPanel runId={run.runId} />
        </div>
      )}
    </div>
  );
}

function HistoryTab({ showToast }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [currentRunId, setCurrentRunId] = useState(null);
  const pollRef = useRef(null);

  const fetchHistory = useCallback(() => {
    rm.history(30).then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    rm.history(30).then(setHistory).catch(e => showToast(e.message, 'error')).finally(() => setLoading(false));
    rm.runStatus().then(s => { setIsRunning(s.isRunning); setCurrentRunId(s.currentRunId); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (isRunning) {
      pollRef.current = setInterval(async () => {
        try {
          const s = await rm.runStatus();
          setIsRunning(s.isRunning);
          setCurrentRunId(s.currentRunId);
          if (!s.isRunning) {
            clearInterval(pollRef.current);
            fetchHistory();
          }
        } catch { /* ignore */ }
      }, 3000);
    }
    return () => clearInterval(pollRef.current);
  }, [isRunning, fetchHistory]);

  async function handleRun() {
    if (isRunning) return;
    try {
      const res = await rm.triggerRun();
      setIsRunning(true);
      setCurrentRunId(res.runId);
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Run controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <button
          onClick={handleRun}
          disabled={isRunning}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.5rem 1rem',
            fontSize: '0.875rem',
            fontWeight: 500,
            borderRadius: 'var(--r-md, 8px)',
            border: 'none',
            color: '#fff',
            background: 'var(--primary)',
            cursor: isRunning ? 'not-allowed' : 'pointer',
            opacity: isRunning ? 0.6 : 1,
            transition: 'opacity 0.15s',
          }}
        >
          {isRunning ? (
            <>
              <svg style={{ width: '1rem', height: '1rem', animation: 'spin 1s linear infinite' }} fill="none" viewBox="0 0 24 24">
                <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Checking…
            </>
          ) : 'Run Now'}
        </button>
        {isRunning && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-2)' }}>Run in progress — polling for completion…</span>
        )}
      </div>

      {loading ? (
        <div style={{ padding: '2rem 0', textAlign: 'center', fontSize: '0.875rem', color: 'var(--text-3)' }}>Loading history…</div>
      ) : history.length === 0 ? (
        <div style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          padding: '2rem',
          textAlign: 'center',
        }}>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', margin: 0 }}>No runs yet. Click "Run Now" or wait for the scheduled run.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {history.map(run => <RunSummaryRow key={run.runId} run={run} />)}
        </div>
      )}
    </div>
  );
}

// ── Settings tab ──────────────────────────────────────────────────────────────

const COMMON_TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Tokyo', 'Australia/Sydney',
];

function SettingsTab({ showToast }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({ webhookUrl: '', channel: '', scheduleTime: '06:00', timezone: 'Asia/Kolkata', enabled: true });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [errors, setErrors] = useState({});

  useEffect(() => {
    rm.slackConfig()
      .then(c => { setConfig(c); setForm({ webhookUrl: c.webhookUrl || '', channel: c.channel || '', scheduleTime: c.scheduleTime || '06:00', timezone: c.timezone || 'Asia/Kolkata', enabled: c.enabled !== false }); })
      .catch(e => showToast(e.message, 'error'))
      .finally(() => setLoading(false));
  }, []);

  function validate() {
    const errs = {};
    if (form.webhookUrl && !form.webhookUrl.includes('*') && !form.webhookUrl.startsWith('https://hooks.slack.com/')) {
      errs.webhookUrl = 'Must start with https://hooks.slack.com/';
    }
    if (form.scheduleTime && !/^\d{1,2}:\d{2}$/.test(form.scheduleTime)) {
      errs.scheduleTime = 'Use HH:MM format';
    }
    return errs;
  }

  async function handleSave() {
    const errs = validate();
    if (Object.keys(errs).length) return setErrors(errs);
    setErrors({});
    setSaving(true);
    setSaveMsg('');
    try {
      await rm.saveSlackConfig(form);
      setSaveMsg('Settings saved.');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestMsg('');
    try {
      await rm.testSlack();
      setTestMsg('✅ Test message sent successfully.');
    } catch (e) {
      setTestMsg(`❌ ${e.message}`);
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <div style={{ padding: '3rem 0', textAlign: 'center', fontSize: '0.875rem', color: 'var(--text-3)' }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '32rem' }}>
      <div style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
        padding: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}>
        <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', margin: 0 }}>Slack Alerts</h3>

        <div>
          <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)', marginBottom: '0.25rem' }}>Webhook URL</label>
          <FocusInput
            type="text"
            value={form.webhookUrl}
            onChange={e => setForm(f => ({ ...f, webhookUrl: e.target.value }))}
            placeholder="https://hooks.slack.com/services/…"
          />
          {errors.webhookUrl && <p style={{ fontSize: '0.75rem', color: 'var(--danger)', marginTop: '0.25rem', marginBottom: 0 }}>{errors.webhookUrl}</p>}
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)', marginBottom: '0.25rem' }}>Channel (optional)</label>
          <FocusInput
            value={form.channel}
            onChange={e => setForm(f => ({ ...f, channel: e.target.value }))}
            placeholder="#seo-alerts"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)', marginBottom: '0.25rem' }}>Daily Run Time (24h)</label>
            <FocusInput
              value={form.scheduleTime}
              onChange={e => setForm(f => ({ ...f, scheduleTime: e.target.value }))}
              placeholder="06:00"
            />
            {errors.scheduleTime && <p style={{ fontSize: '0.75rem', color: 'var(--danger)', marginTop: '0.25rem', marginBottom: 0 }}>{errors.scheduleTime}</p>}
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)', marginBottom: '0.25rem' }}>Timezone</label>
            <FocusSelect
              value={form.timezone}
              onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))}
            >
              {COMMON_TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </FocusSelect>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Toggle checked={form.enabled} onChange={() => setForm(f => ({ ...f, enabled: !f.enabled }))} />
          <span style={{ fontSize: '0.875rem', color: 'var(--text)' }}>Send Slack alerts</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', paddingTop: '0.25rem' }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, borderRadius: 'var(--r-md, 8px)', border: 'none', color: '#fff', background: 'var(--primary)', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
          <button
            onClick={handleTest}
            disabled={testing}
            style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, borderRadius: 'var(--r-md, 8px)', border: '1px solid var(--border)', color: 'var(--text)', background: 'var(--card)', cursor: testing ? 'not-allowed' : 'pointer' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--card)'}
          >
            {testing ? 'Sending…' : 'Send Test Message'}
          </button>
        </div>

        {saveMsg && <p style={{ fontSize: '0.75rem', color: 'var(--success, #059669)', margin: 0 }}>{saveMsg}</p>}
        {testMsg && <p style={{ fontSize: '0.75rem', color: testMsg.startsWith('✅') ? 'var(--success, #059669)' : 'var(--danger)', margin: 0 }}>{testMsg}</p>}
      </div>

      <div style={{
        background: 'var(--warning-soft, #FFFBEB)',
        border: '1px solid var(--warning-border, #FDE68A)',
        borderRadius: 'var(--r-lg)',
        padding: '1rem',
        fontSize: '0.75rem',
        color: 'var(--warning-text, #92400E)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
      }}>
        <p style={{ fontWeight: 600, margin: 0 }}>History retention note</p>
        <p style={{ margin: 0 }}>Run history is retained for 90 days. Older files are automatically pruned after each run.</p>
      </div>

      <div style={{
        background: 'var(--danger-soft, #FEF2F2)',
        border: '1px solid var(--danger-border, #FECACA)',
        borderRadius: 'var(--r-lg)',
        padding: '1rem',
        fontSize: '0.75rem',
        color: 'var(--danger)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
      }}>
        <p style={{ fontWeight: 600, margin: 0 }}>Security notice</p>
        <p style={{ margin: 0 }}>Client credentials and the Slack webhook URL are stored in plaintext on disk. Ensure <code style={{ background: 'rgba(0,0,0,0.08)', padding: '0.1rem 0.25rem', borderRadius: '3px' }}>modules/robotsMonitor/data/</code> is excluded from version control.</p>
      </div>
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

export default function RobotsMonitorPage() {
  const [tab, setTab] = useState('clients');
  const [toast, setToast] = useState(null);

  function showToast(message, type = 'error') {
    setToast({ message, type });
  }

  return (
    <>
      <MonitorNav active={tab} onChange={setTab} />

      <main style={{ flex: 1, maxWidth: '64rem', margin: '0 auto', width: '100%', padding: '1.5rem' }}>
        {tab === 'clients' && <ClientsTab showToast={showToast} />}
        {tab === 'history' && <HistoryTab showToast={showToast} />}
        {tab === 'settings' && <SettingsTab showToast={showToast} />}
        <ModuleRuns toolId="robots-monitor" />
      </main>

      {toast && (
        <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </>
  );
}
