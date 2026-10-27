import { Tag } from '../studio/primitives';

// The modules that report a percentage rather than a 0-100 score, with what the
// percentage is of. They sit under the audit profile's radar, not on it.
export const PERCENT_MODULES = {
  competitor: 'Market position',
  ai_visibility_lite: 'AI answers',
  ai_visibility: 'AI answers',
};

const MODULE_STATUS_LABEL_SHORT = {
  not_run: 'Not run',
  needs_setup: 'Needs setup',
  running: 'Running',
  queued: 'Queued',
  failed: 'Failed',
};

const shortDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** One percentage module under the radar: name, figure, what it measures, when. */
export default function PercentRow({ module }) {
  const metric = module.metric || null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 6, columnGap: 10, padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>{module.label}</span>
      <span className="num" style={{ fontSize: 15, fontWeight: 600, color: metric && Number.isFinite(metric.value) ? 'var(--text)' : 'var(--text-3)', textAlign: 'right' }}>
        {metric ? metric.display : '—'}
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
        {PERCENT_MODULES[module.key]}{module.updatedAt ? ` · ${shortDate(module.updatedAt)}` : ''}
      </span>
      <span style={{ justifySelf: 'end' }}>
        <Tag tone="muted">{metric ? metric.tag : (MODULE_STATUS_LABEL_SHORT[module.status] || 'No data yet')}</Tag>
      </span>
    </div>
  );
}
