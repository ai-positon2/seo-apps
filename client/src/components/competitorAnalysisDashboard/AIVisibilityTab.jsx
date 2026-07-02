import { useEffect, useState } from 'react';
import { DataTable, Card, Field, Button } from '../../ui';
import { InsightCallout } from './InsightCallout';
import { domainLabel, fmtNum, fmtDate } from './utils';
import { ct } from '../../lib/competitorTrackerApi';

const FIELDS = [
  { key: 'aiVisibilityScore', label: 'AI Visibility Score' },
  { key: 'monthlyAudience', label: 'Monthly Audience' },
  { key: 'mentions', label: 'Mentions' },
  { key: 'citedPages', label: 'Cited Pages' },
];

function emptyRow() {
  return { aiVisibilityScore: '', monthlyAudience: '', mentions: '', citedPages: '' };
}

export function AIVisibilityTab({ clientId, domains, aiVisibility, insight, onSaved, showToast }) {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const initial = {};
    domains.forEach(d => {
      initial[d.domain] = aiVisibility?.domains?.[d.domain]
        ? { ...aiVisibility.domains[d.domain] }
        : emptyRow();
    });
    setForm(initial);
  }, [clientId, aiVisibility, domains]);

  function updateField(domain, field, value) {
    setForm(f => ({ ...f, [domain]: { ...f[domain], [field]: value } }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {};
      Object.entries(form).forEach(([domain, values]) => {
        payload[domain] = {
          aiVisibilityScore: values.aiVisibilityScore === '' ? null : Number(values.aiVisibilityScore),
          monthlyAudience: values.monthlyAudience === '' ? null : Number(values.monthlyAudience),
          mentions: values.mentions === '' ? null : Number(values.mentions),
          citedPages: values.citedPages === '' ? null : Number(values.citedPages),
        };
      });
      await ct.saveAIVisibility(clientId, payload);
      showToast?.({ title: 'AI Visibility data saved', variant: 'success' });
      onSaved?.();
    } catch (e) {
      showToast?.({ title: 'Failed to save', description: e.message, variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  const tableRows = domains.map(d => ({
    id: d.domain,
    domain: domainLabel(d) + (d.isClient ? ' (Client)' : ''),
    aiVisibilityScore: fmtNum(aiVisibility?.domains?.[d.domain]?.aiVisibilityScore),
    monthlyAudience: fmtNum(aiVisibility?.domains?.[d.domain]?.monthlyAudience),
    mentions: fmtNum(aiVisibility?.domains?.[d.domain]?.mentions),
    citedPages: fmtNum(aiVisibility?.domains?.[d.domain]?.citedPages),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <InsightCallout insight={insight} />

      <div style={{
        background: 'var(--warning-soft)',
        border: '1px solid var(--warning)',
        borderRadius: 'var(--r-lg)',
        padding: '10px 14px',
        fontSize: 12,
        color: 'var(--text-2)',
      }}>
        AI Visibility has no public SEMrush API — enter the numbers from SEMrush's AI Visibility Toolkit UI manually. Not refreshed by the scheduler.
        {aiVisibility?.updatedAt && <span> Last updated {fmtDate(aiVisibility.updatedAt)}.</span>}
      </div>

      <DataTable
        title="AI Visibility Comparison"
        columns={[
          { key: 'domain', label: 'Domain' },
          { key: 'aiVisibilityScore', label: 'AI Visibility Score', align: 'right', mono: true },
          { key: 'monthlyAudience', label: 'Monthly Audience', align: 'right', mono: true },
          { key: 'mentions', label: 'Mentions', align: 'right', mono: true },
          { key: 'citedPages', label: 'Cited Pages', align: 'right', mono: true },
        ]}
        rows={tableRows}
      />

      <Card title="Update AI Visibility Data">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {domains.map(d => (
            <div key={d.domain}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
                {domainLabel(d)} {d.isClient && <span style={{ color: 'var(--primary-text, var(--primary))' }}>(Client)</span>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
                {FIELDS.map(f => (
                  <Field
                    key={f.key}
                    label={f.label}
                    type="number"
                    value={form[d.domain]?.[f.key] ?? ''}
                    onChange={e => updateField(d.domain, f.key, e.target.value)}
                  />
                ))}
              </div>
            </div>
          ))}
          <div>
            <Button onClick={handleSave} loading={saving}>Save AI Visibility Data</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

export default AIVisibilityTab;
