// Create / edit a scheduled crawl project.
//
// Two shapes of project, and the difference is what gets sent, not a flag:
// spider mode sends `url` and the crawler follows links from it; list mode
// sends `urls` and the crawler fetches exactly those, following nothing. The
// server picks the mode from the presence of the array (parseCrawlRequest),
// and in list mode it REPLACES `url` with a display label — "List crawl (12
// URLs)" — because there is no single site to name.
//
// The form sends dayOfWeek + hour rather than a cron string: the server builds
// the expression and picks the MINUTE itself, deliberately, so projects spread
// across the hour instead of every one firing on :00. That is why there is no
// minute picker here — see resolveCron in the API's routes.

import { useEffect, useState } from 'react';
import { Modal, Button, Field } from '../../ui';
import CrawlOptionsForm from './CrawlOptionsForm';
import {
  DAY_NAMES, TIMEZONES, hour12Label, parseWeeklyCron, DEFAULT_OPTIONS, dayAndHourInTimezone,
} from './crawlHelpers';
import { cs } from '../../lib/crawlScopeApi';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DEFAULT_TIMEZONE = 'America/Chicago';

export default function ProjectForm({ open, project, initialUrl, initialAt, onClose, onSave }) {
  const [mode, setMode] = useState('spider');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [urlList, setUrlList] = useState('');
  const [dayOfWeek, setDayOfWeek] = useState(0);
  const [hour, setHour] = useState(22);
  const [timezone, setTimezone] = useState('America/Chicago');
  const [recipients, setRecipients] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // The workspace's real caps, so the settings panel offers the budget this
  // workspace can actually have rather than a hardcoded range. Fetched when the
  // modal opens; a failure leaves the static ranges in place rather than
  // blocking the form.
  const [limits, setLimits] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    cs.limits()
      .then((r) => { if (!cancelled) setLimits(r.limits || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const parsed = parseWeeklyCron(project?.cron);
    // A saved list project carries its URLs in options.urls; `url` is only the
    // label the server generated, so it must not be shown as an editable site.
    const savedList = Array.isArray(project?.options?.urls) ? project.options.urls : null;
    setMode(savedList?.length ? 'list' : 'spider');
    setName(project?.name || '');
    // initialUrl seeds a brand-new project (e.g. arriving here from "Schedule
    // this crawl to repeat" on a finished run) — project?.url always wins
    // when actually editing an existing one.
    setUrl(savedList?.length ? '' : (project?.url || initialUrl || ''));
    setUrlList(savedList?.length ? savedList.join('\n') : '');
    const timezone = project?.timezone || DEFAULT_TIMEZONE;
    if (parsed) {
      setDayOfWeek(parsed.dayOfWeek);
      setHour(parsed.hour);
    } else {
      // No saved schedule to parse — a brand-new project. Default to the day
      // and hour its first report was (or, with no run behind this yet, will
      // be) generated, instead of an arbitrary fixed slot: `initialAt` is the
      // run being converted to a schedule via "Schedule this crawl to
      // repeat"; with no run at all, the project's own first crawl fires the
      // moment it's created, so "now" already *is* that first-report time.
      const { dayOfWeek: d, hour: h } = dayAndHourInTimezone(initialAt || new Date(), timezone);
      setDayOfWeek(d);
      setHour(h);
    }
    setTimezone(timezone);
    setRecipients((project?.recipients || []).join(', '));
    setEnabled(project?.enabled !== false);
    setOptions({ ...DEFAULT_OPTIONS, ...(project?.options || {}) });
    setError('');
  }, [open, project, initialUrl, initialAt]);

  // Split on whitespace or commas, the two ways a list actually arrives —
  // pasted from a spreadsheet column, or from a comma-joined export.
  const listUrls = urlList.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);

  const ready = mode === 'spider' ? Boolean(url.trim()) : listUrls.length > 0;

  async function submit() {
    setSaving(true);
    setError('');
    try {
      await onSave({
        name: name.trim() || undefined,
        // Exactly one of these. Sending both would be ambiguous, and the server
        // resolves that ambiguity in favour of the list — better to be explicit
        // here than to rely on a precedence rule nobody reading this can see.
        ...(mode === 'list' ? { urls: listUrls } : { url: url.trim() }),
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
            <Button onClick={submit} loading={saving} disabled={!ready}>
              {project ? 'Save changes' : 'Create and crawl now'}
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 8,
          }}
          >
            What to crawl
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            {[
              // Same wording as the one-off crawl form on this page. Two names
              // for one concept is how a user ends up believing they are two
              // different features.
              ['spider', 'Crawl a site', 'Starts at one URL and follows internal links.'],
              ['list', 'Audit a URL list', 'Fetches exactly the URLs given. Follows nothing.'],
            ].map(([id, label, blurb]) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                aria-pressed={mode === id}
                style={{
                  flex: '1 1 220px',
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: 'var(--r-md)',
                  cursor: 'pointer',
                  border: `1px solid ${mode === id ? 'var(--primary)' : 'var(--border)'}`,
                  background: mode === id ? 'var(--primary-soft)' : 'transparent',
                  color: 'var(--text)',
                }}
              >
                <div style={{
                  fontSize: 13, fontWeight: 600,
                  color: mode === id ? 'var(--primary-text)' : 'var(--text)',
                }}
                >
                  {label}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{blurb}</div>
              </button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {mode === 'spider' ? (
              <Field
                label="Site URL"
                required
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                helper="The crawl starts here and follows internal links."
              />
            ) : (
              <Field
                label="URLs to crawl"
                required
                as="textarea"
                rows={6}
                placeholder={'https://example.com/pricing\nhttps://example.com/about\nhttps://other-site.com/page'}
                value={urlList}
                onChange={(e) => setUrlList(e.target.value)}
                helper={listUrls.length
                  ? `${listUrls.length} URL${listUrls.length === 1 ? '' : 's'}. `
                    + 'They may span different sites — nothing is followed, so scope does not apply.'
                  : 'One per line, or comma separated. They may span different sites.'}
              />
            )}
            <Field
              label="Project name"
              placeholder={mode === 'list' ? 'Optional — recommended for a list' : 'Optional — defaults to the host'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              helper={mode === 'list'
                ? 'A list has no single site to name it after, so it is worth setting one.'
                : undefined}
            />
          </div>
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
          <CrawlOptionsForm options={options} onChange={setOptions} mode={mode} limits={limits} />
        </div>
      </div>
    </Modal>
  );
}
