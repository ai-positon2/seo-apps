import { useNavigate } from 'react-router-dom';
import { Card, SectionHead, Tag, Muted } from './primitives';
import { relativeTime, MODULE_STATUS_LABEL, MODULE_STATUS_TONE } from '../../lib/projectsApi';
import { toolLabel } from '../../lib/runsApi';

// ── Activity + alerts ───────────────────────────────────────────────────────
// The two panels below the audit profile. Both are driven entirely by stored
// rows — crawl runs, tracked tool runs, and the findings of the most recent
// terminal crawl — so an empty panel means nothing has run, not that something
// failed to load.

// Row rules fade at both ends, matching the design's dividers. Painted as a
// row-level background so the fade spans the row rather than restarting per cell.
const rowRule = (opacity) => ({
  background: `linear-gradient(to right, transparent, color-mix(in srgb, var(--text) ${opacity}%, transparent) 48px, color-mix(in srgb, var(--text) ${opacity}%, transparent) calc(100% - 48px), transparent) no-repeat bottom / 100% 1px`,
});

const th = {
  textAlign: 'left',
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  padding: '6px 8px',
  fontWeight: 600,
};

const td = { padding: '8px', fontSize: 13, verticalAlign: 'middle' };

export function ActivityPanel({ activity, projectName }) {
  const navigate = useNavigate();

  return (
    <Card style={{ padding: 16 }}>
      <SectionHead
        title={`Activity${projectName ? ` — ${projectName}` : ''}`}
        right={activity.length ? `Last ${activity.length} runs` : null}
      />

      {!activity.length ? (
        <Muted size={13} style={{ padding: '18px 4px', display: 'block' }}>
          Nothing has run in this workspace yet. Start a crawl or open any tool from the sidebar —
          tracked runs land here.
        </Muted>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={rowRule(16)}>
                <th style={th}>Module</th>
                <th style={th}>Status</th>
                <th style={th}>When</th>
                <th style={th} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {activity.map((row) => {
                const tone = MODULE_STATUS_TONE[row.status] || 'muted';
                return (
                  <tr key={`${row.kind}-${row.id}`} style={rowRule(8)}>
                    <td style={td}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span>{row.kind === 'crawl' ? 'Site crawl' : toolLabel(row.module)}</span>
                        {row.label && row.kind !== 'crawl' && (
                          <Muted style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>
                            {row.label}
                          </Muted>
                        )}
                        {row.kind === 'crawl' && <Muted>{row.label}</Muted>}
                      </div>
                    </td>
                    <td style={td}>
                      <Tag tone={tone}>{MODULE_STATUS_LABEL[row.status] || row.status}</Tag>
                    </td>
                    <td style={{ ...td, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                      {relativeTime(row.at)}
                    </td>
                    <td style={td}>
                      <button
                        type="button"
                        onClick={() => navigate(row.href)}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          color: 'var(--primary-text)', fontSize: 13, fontFamily: 'var(--font-sans)',
                        }}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
