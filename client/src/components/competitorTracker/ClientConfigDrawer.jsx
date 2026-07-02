import { useEffect, useState } from 'react';
import { Drawer, Field, Button } from '../../ui';
import { ct } from '../../lib/competitorTrackerApi';

const COMMON_COUNTRIES = [
  'United States', 'United Kingdom', 'Canada', 'Australia', 'India',
  'Germany', 'France', 'Spain', 'Italy', 'Netherlands', 'Ireland',
  'Singapore', 'United Arab Emirates', 'South Africa', 'New Zealand',
];

/**
 * ClientConfigDrawer — add a new tracked client, or edit an existing one's
 * profile and competitor list. No code changes needed to add/remove competitors.
 */
export function ClientConfigDrawer({ open, onClose, client, onSaved, onDeleted }) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [country, setCountry] = useState('United States');
  const [savedClient, setSavedClient] = useState(null);
  const [competitors, setCompetitors] = useState([]);
  const [newCompDomain, setNewCompDomain] = useState('');
  const [newCompLabel, setNewCompLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(client?.name || '');
    setDomain(client?.domain || '');
    setCountry(client?.country || 'United States');
    setSavedClient(client || null);
    setCompetitors(client?.competitors || []);
    setNewCompDomain('');
    setNewCompLabel('');
    setError('');
  }, [open, client]);

  async function handleSaveProfile() {
    if (!name.trim()) return setError('Client name is required');
    setSaving(true);
    setError('');
    try {
      if (savedClient) {
        const updated = await ct.updateClient(savedClient.id, { name, domain, country });
        setSavedClient({ ...savedClient, ...updated });
        onSaved?.({ ...savedClient, ...updated, competitors });
      } else {
        const created = await ct.addClient({ name, domain, country });
        setSavedClient(created);
        onSaved?.(created);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAddCompetitor() {
    if (!savedClient) return setError('Save the client profile first');
    if (!newCompDomain.trim()) return setError('Competitor domain is required');
    setError('');
    try {
      const competitor = await ct.addCompetitor(savedClient.id, { domain: newCompDomain.trim(), label: newCompLabel.trim() });
      const updatedList = [...competitors, competitor];
      setCompetitors(updatedList);
      setNewCompDomain('');
      setNewCompLabel('');
      onSaved?.({ ...savedClient, competitors: updatedList });
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleRemoveCompetitor(competitorId) {
    try {
      await ct.deleteCompetitor(savedClient.id, competitorId);
      const updatedList = competitors.filter(c => c.id !== competitorId);
      setCompetitors(updatedList);
      onSaved?.({ ...savedClient, competitors: updatedList });
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleDeleteClient() {
    if (!savedClient) return onClose?.();
    if (!window.confirm(`Delete "${savedClient.name}" and all of its tracked history? This can't be undone.`)) return;
    try {
      await ct.deleteClient(savedClient.id);
      onDeleted?.(savedClient.id);
      onClose?.();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={savedClient ? `Edit ${savedClient.name}` : 'Add Client'}
      footer={
        <>
          {savedClient && <Button variant="danger" onClick={handleDeleteClient}>Delete Client</Button>}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Client Name" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Riccobene Associates" />
        <Field label="Client Domain" value={domain} onChange={e => setDomain(e.target.value)} placeholder="example.com" />
        <Field as="select" label="Country / SEMrush Database" value={country} onChange={e => setCountry(e.target.value)}>
          {COMMON_COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
        </Field>

        {error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>}

        <Button onClick={handleSaveProfile} loading={saving}>
          {savedClient ? 'Save Changes' : 'Create Client'}
        </Button>

        {savedClient && (
          <>
            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 10 }}>
                Tracked Competitors ({competitors.length}/3 recommended)
              </div>

              {competitors.length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 10px' }}>No competitors yet — add 1–3 below.</p>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                {competitors.map(comp => (
                  <div key={comp.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: 'var(--surface)', borderRadius: 'var(--r-md)' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{comp.label || comp.domain}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{comp.domain}</div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => handleRemoveCompetitor(comp.id)}>Remove</Button>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Field label="Competitor Domain" value={newCompDomain} onChange={e => setNewCompDomain(e.target.value)} placeholder="competitor.com" />
                <Field label="Label (optional)" value={newCompLabel} onChange={e => setNewCompLabel(e.target.value)} placeholder="e.g. Main Competitor" />
                <Button variant="secondary" onClick={handleAddCompetitor}>+ Add Competitor</Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}

export default ClientConfigDrawer;
