// What to do with the picks: hand them to Content Writer, copy them as a
// table, and (full only) toggle edit mode. Compact adds "Open in full view".

import { buildContentWriterUrl } from '../../lib/keywordResearchModel';
import { CheckIcon, CopyIcon, EditIcon } from './shared';

export default function KrToolbar({ density = 'full', ...props }) {
  return density === 'compact' ? <CompactToolbar {...props} /> : <FullToolbar {...props} />;
}

/**
 * Shown when the picks are a saved run replayed for the same seed, intent and
 * client — so it is clear why two runs agree, and how to get a new one.
 */
function CachedNote({ kr, small = false }) {
  const { cachedAt, running } = kr.state;
  if (!cachedAt || running) return null;
  const when = Number.isNaN(Date.parse(cachedAt)) ? 'earlier' : new Date(cachedAt).toLocaleString();
  return (
    <span style={{ marginRight: 'auto', fontSize: small ? 11.5 : 12.5, color: 'var(--text-3)' }}>
      Saved research from {when} — the same seed shows the same picks.{' '}
      <button
        type="button"
        onClick={kr.startFresh}
        title="Research this seed again from scratch (uses SEMrush units)"
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
          color: 'var(--primary)', fontWeight: 600, textDecoration: 'underline',
        }}
      >
        Run fresh
      </button>
    </span>
  );
}

function toolbarButton({ active = false, tone = 'neutral', disabled = false }) {
  const primary = tone === 'primary';
  return {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, padding: '8px 14px', borderRadius: 8,
    border: `1px solid ${primary ? 'var(--primary)' : active ? (tone === 'success' ? 'var(--success)' : 'var(--primary)') : 'var(--border)'}`,
    background: primary ? (disabled ? 'var(--surface)' : 'var(--primary)') : active ? (tone === 'success' ? 'var(--success-soft)' : 'var(--primary)') : 'var(--card)',
    color: primary ? (disabled ? 'var(--text-3)' : '#fff') : active ? (tone === 'success' ? 'var(--success)' : '#fff') : 'var(--text)',
    cursor: disabled ? 'not-allowed' : 'pointer', transition: 'all 0.15s',
  };
}

function FullToolbar({ kr, client, navigate, editMode, onToggleEdit }) {
  const { primary, secondary } = kr.state;
  const noPrimary = primary.length === 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
      <CachedNote kr={kr} />
      <button
        onClick={() => navigate(buildContentWriterUrl({ primary, secondary, client }))}
        disabled={noPrimary}
        title={noPrimary ? 'Choose at least one primary keyword first' : 'Recommend an article for this keyword'}
        style={toolbarButton({ tone: 'primary', disabled: noPrimary })}
      >
        Recommend Article
      </button>
      <button onClick={kr.copyTable} style={toolbarButton({ active: kr.copied, tone: 'success' })}>
        {kr.copied ? <><CheckIcon /> Copied!</> : <><CopyIcon /> Copy as Table</>}
      </button>
      <button onClick={onToggleEdit} style={toolbarButton({ active: editMode })}>
        {editMode ? <><CheckIcon /> Done Editing</> : <><EditIcon /> Edit Keywords</>}
      </button>
    </div>
  );
}

const smallButton = {
  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, padding: '5px 10px',
  borderRadius: 7, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-2)', cursor: 'pointer', whiteSpace: 'nowrap',
};

function CompactToolbar({ kr, client, navigate, origin }) {
  const { primary, secondary, keyword, intent } = kr.state;
  const lead = primary[0];
  const fullView = `/keyword-research?${new URLSearchParams({ keyword, intent, ...(client ? { client } : {}) })}`;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <CachedNote kr={kr} small />
      <button type="button" onClick={kr.copyTable} disabled={!primary.length && !secondary.length} style={{ ...smallButton, ...(kr.copied ? { color: 'var(--success)', borderColor: 'var(--success)', background: 'var(--success-soft)' } : null) }}>
        {kr.copied ? <><CheckIcon size={12} /> Copied</> : <><CopyIcon size={12} /> Copy table</>}
      </button>
      <a
        href={fullView}
        target="_blank"
        rel="noreferrer"
        title="Open this seed keyword in the standalone Keyword Research tool, in a new tab"
        style={{ ...smallButton, textDecoration: 'none' }}
      >
        Open in full view ↗
      </a>
      <button
        type="button"
        disabled={!lead}
        onClick={() => navigate(buildContentWriterUrl({ primary, secondary, client, origin }))}
        title={lead ? `Write a content brief for "${lead.keyword}" with ${primary.length - 1 + secondary.length} supporting keywords` : 'Choose a primary keyword first'}
        style={{
          marginLeft: 'auto', fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 7, border: '1px solid var(--primary)',
          background: lead ? 'var(--primary)' : 'var(--surface)', color: lead ? 'var(--text-on-primary)' : 'var(--text-3)',
          cursor: lead ? 'pointer' : 'not-allowed', opacity: lead ? 1 : 0.6,
          maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        Recommend Article{lead ? ` for "${lead.keyword}"` : ''}
      </button>
    </div>
  );
}
