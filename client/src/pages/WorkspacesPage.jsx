import { useEffect, useState } from 'react';
import { SectionHeader } from '../ui/SectionHeader';

async function req(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  function loadList() {
    return req('/api/workspaces').then(d => setWorkspaces(d.workspaces || []));
  }

  useEffect(() => { loadList().finally(() => setLoading(false)); }, []);

  function openWorkspace(id) {
    setError('');
    req(`/api/workspaces/${id}`).then(d => setSelected(d.workspace)).catch(e => setError(e.message));
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setError('');
    try {
      await req('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: newName.trim() }) });
      setNewName('');
      await loadList();
    } catch (e) { setError(e.message); }
  }

  async function handleAddMember(e) {
    e.preventDefault();
    const email = e.target.email.value.trim();
    if (!email) return;
    setError('');
    try {
      await req(`/api/workspaces/${selected.id}/members`, { method: 'POST', body: JSON.stringify({ email }) });
      e.target.reset();
      openWorkspace(selected.id);
    } catch (e) { setError(e.message); }
  }

  async function handleRemoveMember(userId) {
    setError('');
    try {
      await req(`/api/workspaces/${selected.id}/members/${userId}`, { method: 'DELETE' });
      openWorkspace(selected.id);
    } catch (e) { setError(e.message); }
  }

  if (loading) return null;

  return (
    <div style={{ padding: '28px 32px 48px' }}>
      <SectionHeader title="Workspaces" subtitle="Share access to your work with teammates." />

      {error && (
        <div style={{
          fontSize: 12, color: '#f87171', background: 'rgba(248,113,113,0.10)',
          border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '8px 10px', marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 24 }}>
        <div style={{ width: 280, flexShrink: 0 }}>
          <form onSubmit={handleCreate} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="New workspace name"
              style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}
            />
            <button type="submit" style={{ padding: '8px 12px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              Create
            </button>
          </form>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {workspaces.map(ws => (
              <button
                key={ws.id}
                onClick={() => openWorkspace(ws.id)}
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: `1px solid ${selected?.id === ws.id ? 'var(--primary)' : 'var(--border)'}`,
                  background: 'var(--card)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{ws.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{ws.myRole}</div>
              </button>
            ))}
            {!workspaces.length && (
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No workspaces yet — create one above.</div>
            )}
          </div>
        </div>

        {selected && (
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>
              {selected.name}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {selected.members.map(m => (
                <div key={m.userId} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--card)',
                }}>
                  <div style={{ fontSize: 13, color: 'var(--text)' }}>
                    {m.email} <span style={{ color: 'var(--text-3)', fontSize: 11 }}>· {m.role}</span>
                  </div>
                  {selected.myRole === 'owner' && (
                    <button
                      onClick={() => handleRemoveMember(m.userId)}
                      style={{ fontSize: 11, color: '#f87171', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>

            {selected.myRole === 'owner' && (
              <form onSubmit={handleAddMember} style={{ display: 'flex', gap: 8 }}>
                <input
                  name="email"
                  type="email"
                  placeholder="teammate@company.com"
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}
                />
                <button type="submit" style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  Add member
                </button>
              </form>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
              A teammate must have signed in to the app at least once before you can add them.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
