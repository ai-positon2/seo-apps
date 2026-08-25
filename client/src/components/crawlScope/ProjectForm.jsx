// Create / edit a scheduled crawl project.
//
// The form sends dayOfWeek + hour rather than a cron string: the server builds
// the expression and picks the MINUTE itself, deliberately, so projects spread
// across the hour instead of every one firing on :00. That is why there is no
// minute picker here — see resolveCron in the API's routes.

import { useEffect, useState } from 'react';
import { Modal, Button, Field } from '../../ui';
import CrawlOptionsForm from './CrawlOptionsForm';
import { DAY_NAMES, TIMEZONES, hour12Label, parseWeeklyCron, DEFAULT_OPTIONS } from './crawlHelpers';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default function ProjectForm({ open, project, onClose, onSave }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [dayOfWeek, setDayOfWeek] = useState(0);
  const [hour, setHour] = useState(22);
  const [timezone, setTimezone] = useState('America/Chicago');
  const [recipients, setRecipients] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const parsed = parseWeeklyCron(project?.cron);
    setName(project?.name || '');
    setUrl(project?.url || '');
    setDayOfWeek(parsed?.dayOfWeek ?? 0);
    setHour(parsed?.hour ?? 22);
    setTimezone(project?.timezone || 'America/Chicago');
    setRecipients((project?.recipients || []).join(', '));
    setEnabled(project?.enabled !== false);
    setOptions({ ...DEFAULT_OPTIONS, ...(project?.options || {}) });
    setError('');
  }, [open, project]);

  async function submit() {
    setSaving(true);
    setError('');
    try {
      await onSave({
        name: name.trim() || undefined,
        url: url.trim(),
        dayOfWeek,
        hour,
        timezone,
        recipients,
        enabled,
        options,
      });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={project ? 'Edit scheduled crawl' : 'New scheduled crawl'}
      size="lg"
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} loading={saving} disabled={!url.trim()}>
              {project ? 'Save changes' : 'Create and crawl now'}
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <Field
            label="Site URL"
            required
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            helper="The crawl starts here and follows internal links."
          />
          <Field
            label="Project name"
            placeholder="Optional — defaults to the host"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 8 }}>
            Schedule
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
            <Field label="Day" as="select" value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
              {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </Field>
            <Field label="Hour" as="select" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {HOURS.map((h) => <option key={h} value={h}>{hour12Label(h)}</option>)}
            </Field>
            <Field
              label="Timezone"
              as="select"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              helper="The hour above is local to this zone, across DST."
            >
              {TIMEZONES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </Field>
          </div>
        </div>

        <Field
          label="Email the report to"
          as="textarea"
          rows={2}
          placeholder="one@example.com, two@example.com"
          value={recipients}
          onChange={(e) => setRecipients(e.target.value)}
          helper="Comma, semicolon or newline separated. A bad address is rejected rather than silently dropped."
        />

        <label style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Schedule is active
        </label>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 8 }}>
            Crawl settings
          </div>
          <CrawlOptionsForm options={options} onChange={setOptions} />
        </div>
      </div>
    </Modal>
  );
}
