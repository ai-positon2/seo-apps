import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { lpb } from '../lib/lpbApi';
import { btnStyle, inputStyle, labelStyle, SectionCard } from '../ui/wizardKit';

// ── Client feedback rules for Clear Behavioral Health ───────────────────────
// Where client feedback becomes enforceable. Paste a batch of feedback, let the
// drafter turn it into draft rules, edit and test them, then activate. An
// active rule is given to the brief planner, the writer and field regen, and
// every page generated after that is checked against it.
//
// Nothing on this screen touches a generated page. Pages made before a rule
// existed are left exactly as they are.

const CBH_CLIENT_ID = 'client_clear_behavioral_health';

const SEVERITY_STYLE = {
  Critical: { bg: 'var(--danger-soft,#FEF2F2)', fg: 'var(--danger,#EF4444)' },
  Major: { bg: 'var(--warning-soft,#FFFBEB)', fg: 'var(--warning,#B45309)' },
  Minor: { bg: 'var(--surface)', fg: 'var(--text-3)' },
};
const STATUS_STYLE = {
  active: { bg: 'var(--success-soft,#F0FDF4)', fg: 'var(--success,#16A34A)' },
  draft: { bg: 'var(--info-soft,#EFF6FF)', fg: 'var(--info,#2563EB)' },
  retired: { bg: 'var(--surface)', fg: 'var(--text-3)' },
};

const BLANK_RULE = {
  key: '', title: '', quote: '', kind: 'constraint', severity: 'Major', status: 'draft',
  scope: { services: ['*'], programGroups: [], sections: [] },
  stages: ['brief', 'writer', 'regen'], instruction: '', checks: [],
};
const BLANK_CHECK = { type: 'forbid', pattern: '', unit: 'field', when: '', message: '' };

function Chip({ children, bg = 'var(--surface)', fg = 'var(--text-2)' }) {
  return (
    <span style={{
      fontSize: '0.6875rem', fontWeight: 600, padding: '1px 8px', borderRadius: '9999px',
      background: bg, color: fg, border: '1px solid var(--border)', whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function Notice({ tone = 'danger', children }) {
  const c = tone === 'danger'
    ? { bg: 'var(--danger-soft,#FEF2F2)', fg: 'var(--danger,#EF4444)' }
    : tone === 'success' ? { bg: 'var(--success-soft,#F0FDF4)', fg: 'var(--success,#16A34A)' }
      : { bg: 'var(--warning-soft,#FFFBEB)', fg: 'var(--warning,#B45309)' };
  return (
    <div style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--r-md,6px)', background: c.bg, color: c.fg, fontSize: '0.8125rem', marginBottom: '0.75rem' }}>
      {children}
    </div>
  );
}

// A wrapped row of checkboxes. `options` is [{ key, label }].
function CheckboxRow({ options, value, onChange }) {
  const set = new Set(value || []);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem 0.75rem' }}>
      {options.map(o => (
        <label key={o.key} style={{ fontSize: '0.75rem', color: 'var(--text-2)', display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
          <input type="checkbox" checked={set.has(o.key)}
            onChange={e => onChange(e.target.checked ? [...set, o.key] : [...set].filter(k => k !== o.key))} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

const sectionOptions = (vocab) => (vocab?.sections || []).map(s => ({ key: s.key, label: s.key }));

export default function CbhFeedbackRulesPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('rules');
  const [vocab, setVocab] = useState(null);
  const [rules, setRules] = useState([]);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [batchFilter, setBatchFilter] = useState('');
  const [editing, setEditing] = useState(null); // { id, rule } -- id null for a new rule

  async function load() {
    setError('');
    try {
      const [v, r, b] = await Promise.all([
        lpb.feedbackVocabulary(CBH_CLIENT_ID), lpb.feedbackRules(CBH_CLIENT_ID), lpb.feedbackBatches(CBH_CLIENT_ID),
      ]);
      setVocab(v); setRules(r); setBatches(b);
    } catch (e) {
      setError(/lpb_feedback/.test(e.message)
        ? `${e.message}. Has supabase/migrations/0011_lpb_feedback.sql been applied?`
        : e.message);
    }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const serviceName = useMemo(() => {
    const m = new Map((vocab?.services || []).map(s => [s.id, s.name]));
    return id => m.get(id) || id;
  }, [vocab]);
  const batchTitle = useMemo(() => {
    const m = new Map(batches.map(b => [b.id, b.title]));
    return id => m.get(id) || '';
  }, [batches]);

  const counts = {
    active: rules.filter(r => r.status === 'active').length,
    draft: rules.filter(r => r.status === 'draft').length,
    retired: rules.filter(r => r.status === 'retired').length,
  };
  const openItems = batches.reduce((n, b) => n + (b.action_items || []).filter(a => a.status !== 'done').length, 0);

  const shown = rules
    .filter(r => statusFilter === 'all' || r.status === statusFilter)
    .filter(r => !batchFilter || r.batch_id === batchFilter);

  async function setStatus(rule, status) {
    setError('');
    try {
      const saved = await lpb.feedbackSetStatus(rule.id, status);
      setRules(prev => prev.map(r => (r.id === saved.id ? saved : r)));
    } catch (e) { setError(e.message); }
  }

  async function deleteRule(rule) {
    if (!window.confirm(`Delete the rule “${rule.title || rule.key}” permanently? This cannot be undone.\n\n`
      + 'New pages stop using it straight away. Pages already generated are not changed.')) return;
    setError(''); setNotice('');
    try {
      await lpb.feedbackDeleteRule(rule.id);
      setRules(prev => prev.filter(r => r.id !== rule.id));
      // The batch it came from no longer lists it.
      setBatches(prev => prev.map(b => (b.id === rule.batch_id
        ? { ...b, rule_keys: (b.rule_keys || []).filter(k => k !== rule.key) } : b)));
      setNotice(`Deleted the rule “${rule.title || rule.key}”.`);
    } catch (e) { setError(e.message); }
  }

  // The rules drafted from a deleted batch are kept, and lose only their link
  // back to it.
  function onBatchDeleted(batch, keptRules) {
    const kept = new Set(keptRules.map(r => r.id));
    setBatches(prev => prev.filter(b => b.id !== batch.id));
    setRules(prev => prev.map(r => (kept.has(r.id) ? { ...r, batch_id: null } : r)));
    if (batchFilter === batch.id) setBatchFilter('');
    setNotice(`Deleted the feedback batch “${batch.title}”.${keptRules.length
      ? ` The ${keptRules.length} rule${keptRules.length === 1 ? '' : 's'} drafted from it ${keptRules.length === 1 ? 'was' : 'were'} kept and ${keptRules.length === 1 ? 'is' : 'are'} still on the Rules tab.`
      : ''}`);
  }

  function onRuleSaved(saved) {
    setRules(prev => (prev.some(r => r.id === saved.id) ? prev.map(r => (r.id === saved.id ? saved : r)) : [saved, ...prev]));
    setEditing(null);
  }

  return (
    <main style={{ maxWidth: '64rem', margin: '0 auto', padding: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>
            Clear Behavioral Health: client feedback rules
          </h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', margin: '0.25rem 0 0', maxWidth: '44rem' }}>
            Active rules are given to the brief planner, the writer and field regeneration, and every page generated
            from then on is checked against them. Pages already generated are not changed.
          </p>
        </div>
        <button style={btnStyle(false)} onClick={() => navigate('/location-page-builder/clear-behavioral')}>← Page builder</button>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={btnStyle(tab === 'rules')} onClick={() => setTab('rules')}>
          Rules ({counts.active} active{counts.draft ? `, ${counts.draft} draft` : ''})
        </button>
        <button style={btnStyle(tab === 'batches')} onClick={() => setTab('batches')}>
          Feedback batches ({batches.length}){openItems ? ` · ${openItems} open code change${openItems === 1 ? '' : 's'}` : ''}
        </button>
      </div>

      {error && <Notice>{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {loading && <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Loading…</p>}

      {!loading && tab === 'rules' && (
        <>
          {editing ? (
            <RuleEditor
              initial={editing.rule} id={editing.id} vocab={vocab}
              onCancel={() => setEditing(null)} onSaved={onRuleSaved}
            />
          ) : (
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <select style={{ ...inputStyle, width: '10rem' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="active">Active ({counts.active})</option>
                <option value="draft">Draft ({counts.draft})</option>
                <option value="retired">Retired ({counts.retired})</option>
              </select>
              <select style={{ ...inputStyle, width: '18rem' }} value={batchFilter} onChange={e => setBatchFilter(e.target.value)}>
                <option value="">From any batch</option>
                {batches.map(b => <option key={b.id} value={b.id}>{b.title} ({b.received_at})</option>)}
              </select>
              <span style={{ flex: 1 }} />
              <button style={btnStyle(true)} onClick={() => setEditing({ id: null, rule: structuredClone(BLANK_RULE) })}>+ New rule</button>
            </div>
          )}

          {!editing && !shown.length && (
            <SectionCard title="No rules here">
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)', margin: 0 }}>
                Paste the client's feedback under Feedback batches and draft rules from it, or write one with “+ New rule”.
              </p>
            </SectionCard>
          )}

          {!editing && shown.map(rule => (
            <RuleCard
              key={rule.id} rule={rule} serviceName={serviceName} batchTitle={batchTitle(rule.batch_id)}
              onEdit={() => setEditing({ id: rule.id, rule: structuredClone(rule) })}
              onStatus={status => setStatus(rule, status)}
              onDelete={() => deleteRule(rule)}
            />
          ))}
        </>
      )}

      {!loading && tab === 'batches' && (
        <Batches
          batches={batches} setBatches={setBatches} rules={rules}
          onRulesChanged={load} onBatchDeleted={onBatchDeleted}
          onShowRules={(batchId) => { setBatchFilter(batchId); setStatusFilter('all'); setTab('rules'); }}
        />
      )}
    </main>
  );
}

// ── One rule, read-only ─────────────────────────────────────────────────────
function RuleCard({ rule, serviceName, batchTitle, onEdit, onStatus, onDelete }) {
  const [open, setOpen] = useState(false);
  const services = (rule.scope?.services || []).includes('*')
    ? ['All pages'] : (rule.scope?.services || []).map(serviceName);
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '0.875rem 1rem', marginBottom: '0.625rem', opacity: rule.status === 'retired' ? 0.65 : 1 }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
            <strong style={{ fontSize: '0.875rem', color: 'var(--text)' }}>{rule.title}</strong>
            <Chip {...STATUS_STYLE[rule.status]}>{rule.status}</Chip>
            <Chip {...SEVERITY_STYLE[rule.severity]}>{rule.severity}</Chip>
            {rule.kind === 'fact' && <Chip>service fact</Chip>}
            <span style={{ fontSize: '0.6875rem', color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{rule.key} · v{rule.version || 1}</span>
          </div>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.375rem' }}>
            {services.map(s => <Chip key={s}>{s}</Chip>)}
            {(rule.scope?.programGroups || []).map(g => <Chip key={g}>program: {g}</Chip>)}
            {(rule.scope?.sections || []).map(s => <Chip key={s}>{s}</Chip>)}
            <Chip>{(rule.stages || []).join(' · ')}</Chip>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)', margin: 0 }}>{rule.instruction}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
          <button style={btnStyle(false)} onClick={() => setOpen(o => !o)}>{open ? 'Less' : 'Details'}</button>
          <button style={btnStyle(false)} onClick={onEdit}>Edit</button>
          {rule.status !== 'active' && <button style={btnStyle(true)} onClick={() => onStatus('active')}>Activate</button>}
          {rule.status === 'active' && <button style={btnStyle(false)} onClick={() => onStatus('retired')}>Retire</button>}
          {rule.status === 'retired' && <button style={btnStyle(false)} onClick={() => onStatus('draft')}>Back to draft</button>}
          <button style={{ ...btnStyle(false), color: 'var(--danger,#EF4444)' }} onClick={onDelete}>Delete</button>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: '0.625rem', fontSize: '0.75rem', color: 'var(--text-2)' }}>
          {rule.quote && (
            <blockquote style={{ margin: '0 0 0.5rem', padding: '0.375rem 0.625rem', borderLeft: '3px solid var(--border)', fontStyle: 'italic' }}>
              {rule.quote}{batchTitle && <span style={{ fontStyle: 'normal', color: 'var(--text-3)' }}> ({batchTitle})</span>}
            </blockquote>
          )}
          <strong>Checks</strong>
          {!(rule.checks || []).length && <p style={{ margin: '0.25rem 0' }}>None. The rule only instructs the writer.</p>}
          <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
            {(rule.checks || []).map((c, i) => (
              <li key={i} style={{ marginBottom: '0.25rem' }}>
                {c.type === 'review'
                  ? <>AI review: {c.question}</>
                  : <>
                    {c.type} {c.unit !== 'field' ? `(per ${c.unit})` : ''}
                    {c.when && <> when <code>{c.when}</code></>} <code>{c.pattern}</code>
                    {c.sections?.length ? <> in {c.sections.join(', ')}</> : null}
                    {c.exceptSections?.length ? <> except {c.exceptSections.join(', ')}</> : null}
                    {c.message && <> — “{c.message}”</>}
                  </>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Creating or editing a rule ──────────────────────────────────────────────
function RuleEditor({ initial, id, vocab, onCancel, onSaved }) {
  const [rule, setRule] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [svcFilter, setSvcFilter] = useState('');
  const [sample, setSample] = useState({ text: '', section: '', question: '' });
  const [testResult, setTestResult] = useState(null);

  const edit = (mutate) => setRule((prev) => { const next = structuredClone(prev); mutate(next); return next; });
  const allPages = (rule.scope?.services || []).includes('*');
  const sections = sectionOptions(vocab);
  const services = (vocab?.services || []).filter(s => !svcFilter || s.name.toLowerCase().includes(svcFilter.toLowerCase()));

  async function save() {
    setSaving(true); setError('');
    try {
      const saved = id ? await lpb.feedbackUpdateRule(id, rule) : await lpb.feedbackCreateRule(CBH_CLIENT_ID, rule);
      onSaved(saved);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  async function test() {
    setTestResult(null); setError('');
    try {
      setTestResult(await lpb.feedbackTestRule({
        rule, text: sample.text, section: sample.section || undefined, question: sample.question || undefined,
      }));
    } catch (e) { setError(e.message); }
  }

  return (
    <SectionCard
      title={id ? `Edit rule: ${initial.title}` : 'New rule'}
      note={id ? 'Saving bumps the version and keeps the previous wording in the rule’s history. Pages already generated are not changed.' : 'Saved as a draft unless you choose Active.'}
      actions={<>
        <button style={btnStyle(false)} onClick={onCancel}>Cancel</button>
        <button style={btnStyle(true)} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save rule'}</button>
      </>}
    >
      {error && <Notice>{error}</Notice>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <div>
          <label style={labelStyle}>Title</label>
          <input style={inputStyle} value={rule.title} onChange={e => edit(r => { r.title = e.target.value; })} />
        </div>
        <div>
          <label style={labelStyle}>Key <span style={{ fontWeight: 400 }}>(stable id; blank = from title)</span></label>
          <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} value={rule.key} onChange={e => edit(r => { r.key = e.target.value; })} />
        </div>
        <div>
          <label style={labelStyle}>Severity</label>
          <select style={inputStyle} value={rule.severity} onChange={e => edit(r => { r.severity = e.target.value; })}>
            {(vocab?.severities || ['Critical', 'Major', 'Minor']).map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Kind</label>
          <select style={inputStyle} value={rule.kind} onChange={e => edit(r => { r.kind = e.target.value; })}>
            <option value="constraint">constraint</option>
            <option value="fact">service fact</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>Status</label>
          <select style={inputStyle} value={rule.status} onChange={e => edit(r => { r.status = e.target.value; })}>
            {(vocab?.statuses || ['draft', 'active', 'retired']).map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <label style={labelStyle}>The client's words</label>
      <textarea rows={2} style={{ ...inputStyle, resize: 'vertical', marginBottom: '0.75rem' }} value={rule.quote}
        onChange={e => edit(r => { r.quote = e.target.value; })} />

      <label style={labelStyle}>Instruction <span style={{ fontWeight: 400 }}>(what the planner and writer are told; may use {'{city}'} {'{service}'} {'{condition}'})</span></label>
      <textarea rows={3} style={{ ...inputStyle, resize: 'vertical', marginBottom: '0.75rem' }} value={rule.instruction}
        onChange={e => edit(r => { r.instruction = e.target.value; })} />

      <label style={labelStyle}>Pages it applies to</label>
      <label style={{ fontSize: '0.75rem', color: 'var(--text-2)', display: 'flex', gap: '0.25rem', alignItems: 'center', marginBottom: '0.375rem' }}>
        <input type="checkbox" checked={allPages}
          onChange={e => edit(r => { r.scope.services = e.target.checked ? ['*'] : []; })} />
        Every service
      </label>
      {!allPages && (
        <div style={{ marginBottom: '0.75rem' }}>
          <input style={{ ...inputStyle, marginBottom: '0.375rem' }} placeholder="Filter services…" value={svcFilter} onChange={e => setSvcFilter(e.target.value)} />
          <div style={{ maxHeight: '10rem', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', padding: '0.375rem 0.5rem' }}>
            <CheckboxRow
              options={services.map(s => ({ key: s.id, label: s.name }))}
              value={rule.scope.services}
              onChange={v => edit(r => { r.scope.services = v; })}
            />
          </div>
        </div>
      )}

      <label style={labelStyle}>Only in these programs <span style={{ fontWeight: 400 }}>(none = any)</span></label>
      <div style={{ marginBottom: '0.75rem' }}>
        <CheckboxRow options={(vocab?.programGroups || []).map(g => ({ key: g.key, label: g.label }))}
          value={rule.scope.programGroups} onChange={v => edit(r => { r.scope.programGroups = v; })} />
      </div>

      <label style={labelStyle}>Only in these sections <span style={{ fontWeight: 400 }}>(none = the whole page)</span></label>
      <div style={{ marginBottom: '0.75rem' }}>
        <CheckboxRow options={sections} value={rule.scope.sections} onChange={v => edit(r => { r.scope.sections = v; })} />
      </div>

      <label style={labelStyle}>Given to</label>
      <div style={{ marginBottom: '0.75rem' }}>
        <CheckboxRow
          options={[{ key: 'brief', label: 'brief planner (FAQs, subsections)' }, { key: 'writer', label: 'page writer' }, { key: 'regen', label: 'field regenerate' }]}
          value={rule.stages} onChange={v => edit(r => { r.stages = v; })} />
      </div>

      <label style={labelStyle}>Checks <span style={{ fontWeight: 400 }}>(run on every page generated under the rule)</span></label>
      {(rule.checks || []).map((c, i) => (
        <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', padding: '0.5rem', marginBottom: '0.5rem', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.375rem', flexWrap: 'wrap' }}>
            <select style={{ ...inputStyle, width: '9rem' }} value={c.type}
              onChange={e => edit(r => { r.checks[i] = e.target.value === 'review' ? { type: 'review', question: '' } : { ...BLANK_CHECK, ...r.checks[i], type: e.target.value }; })}>
              <option value="forbid">forbid (regex)</option>
              <option value="require">require (regex)</option>
              <option value="review">AI review</option>
            </select>
            {c.type !== 'review' && (
              <select style={{ ...inputStyle, width: '9rem' }} value={c.unit || 'field'} onChange={e => edit(r => { r.checks[i].unit = e.target.value; })}>
                <option value="field">per field</option>
                <option value="sentence">per sentence</option>
                <option value="faq">per FAQ (when→question)</option>
              </select>
            )}
            <span style={{ flex: 1 }} />
            <button style={{ ...btnStyle(false), padding: '0.25rem 0.5rem', color: 'var(--danger,#EF4444)' }}
              onClick={() => edit(r => { r.checks.splice(i, 1); })}>Remove</button>
          </div>
          {c.type === 'review' ? (
            <textarea rows={2} style={{ ...inputStyle, resize: 'vertical' }} placeholder="A yes/no question where YES means the page complies"
              value={c.question || ''} onChange={e => edit(r => { r.checks[i].question = e.target.value; })} />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.375rem' }}>
              <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} placeholder="pattern (regex, case-insensitive)"
                value={c.pattern || ''} onChange={e => edit(r => { r.checks[i].pattern = e.target.value; })} />
              <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} placeholder="when (optional regex)"
                value={c.when || ''} onChange={e => edit(r => { r.checks[i].when = e.target.value; })} />
              <input style={inputStyle} placeholder="message shown when it fires"
                value={c.message || ''} onChange={e => edit(r => { r.checks[i].message = e.target.value; })} />
              <input style={inputStyle} placeholder="only sections (comma-separated)"
                value={(c.sections || []).join(', ')}
                onChange={e => edit(r => { r.checks[i].sections = e.target.value.split(',').map(x => x.trim()).filter(Boolean); })} />
              <input style={inputStyle} placeholder="except sections (comma-separated)"
                value={(c.exceptSections || []).join(', ')}
                onChange={e => edit(r => { r.checks[i].exceptSections = e.target.value.split(',').map(x => x.trim()).filter(Boolean); })} />
            </div>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: '0.375rem', marginBottom: '1rem' }}>
        <button style={btnStyle(false)} onClick={() => edit(r => { r.checks.push({ ...BLANK_CHECK }); })}>+ Regex check</button>
        <button style={btnStyle(false)} onClick={() => edit(r => { r.checks.push({ type: 'review', question: '' }); })}>+ AI review question</button>
      </div>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
        <label style={labelStyle}>Test on sample text <span style={{ fontWeight: 400 }}>(runs the regex checks only; nothing is saved)</span></label>
        <div style={{ display: 'flex', gap: '0.375rem', marginBottom: '0.375rem', flexWrap: 'wrap' }}>
          <select style={{ ...inputStyle, width: '14rem' }} value={sample.section} onChange={e => setSample(s => ({ ...s, section: e.target.value }))}>
            <option value="">Section: the rule's own</option>
            {(vocab?.sections || []).filter(s => s.key.includes('.') || ['insurance', 'uvp', 'service'].includes(s.key))
              .map(s => <option key={s.key} value={s.key}>{s.key}</option>)}
          </select>
          <input style={{ ...inputStyle, flex: 1, minWidth: '12rem' }} placeholder="FAQ question (only for per-FAQ checks)"
            value={sample.question} onChange={e => setSample(s => ({ ...s, question: e.target.value }))} />
        </div>
        <textarea rows={3} style={{ ...inputStyle, resize: 'vertical', marginBottom: '0.375rem' }} placeholder="Paste a sentence or paragraph the rule should, or should not, catch"
          value={sample.text} onChange={e => setSample(s => ({ ...s, text: e.target.value }))} />
        <button style={btnStyle(false)} disabled={!sample.text.trim()} onClick={test}>Test</button>
        {testResult && (
          <div style={{ marginTop: '0.5rem' }}>
            <Notice tone={testResult.pass ? 'success' : 'warning'}>
              {testResult.reviewOnly
                ? 'This rule has only AI review checks, which run on a whole generated page, not on sample text.'
                : `${testResult.pass ? 'Passes' : 'Caught'} (as ${testResult.section}): ${testResult.detail}`}
            </Notice>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ── Feedback batches ────────────────────────────────────────────────────────
function Batches({ batches, setBatches, rules, onRulesChanged, onShowRules, onBatchDeleted }) {
  const [form, setForm] = useState({ title: '', receivedAt: new Date().toISOString().slice(0, 10), rawText: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function create() {
    setSaving(true); setError('');
    try {
      const b = await lpb.feedbackCreateBatch({ clientId: CBH_CLIENT_ID, ...form });
      setBatches(prev => [b, ...prev]);
      setForm(f => ({ ...f, title: '', rawText: '' }));
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  const replace = b => setBatches(prev => prev.map(x => (x.id === b.id ? b : x)));

  return (
    <>
      <SectionCard title="Add client feedback" note="Paste it exactly as the client sent it. It is kept verbatim as the record each rule points back to.">
        {error && <Notice>{error}</Notice>}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem', marginBottom: '0.5rem' }}>
          <div>
            <label style={labelStyle}>Title</label>
            <input style={inputStyle} placeholder="e.g. Review of the Pasadena teen pages" value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>Received</label>
            <input type="date" style={inputStyle} value={form.receivedAt} onChange={e => setForm(f => ({ ...f, receivedAt: e.target.value }))} />
          </div>
        </div>
        <label style={labelStyle}>The client's feedback</label>
        <textarea rows={8} style={{ ...inputStyle, resize: 'vertical', marginBottom: '0.5rem' }} value={form.rawText}
          onChange={e => setForm(f => ({ ...f, rawText: e.target.value }))} />
        <button style={btnStyle(true)} disabled={saving || !form.rawText.trim()} onClick={create}>{saving ? 'Saving…' : 'Save batch'}</button>
      </SectionCard>

      {batches.map(b => (
        <BatchCard key={b.id} batch={b} rules={rules} onChange={replace} onRulesChanged={onRulesChanged} onShowRules={onShowRules}
          onDeleted={onBatchDeleted} />
      ))}
    </>
  );
}

function BatchCard({ batch, rules, onChange, onRulesChanged, onShowRules, onDeleted }) {
  const [open, setOpen] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState({});

  const items = batch.action_items || [];
  const revisions = batch.proposed_revisions || [];
  const fromBatch = rules.filter(r => r.batch_id === batch.id);
  const ruleByKey = new Map(rules.map(r => [r.key, r]));

  async function draftRules() {
    if (!window.confirm('Draft rules from this feedback with AI? This is one billed model call. Nothing goes live until you activate it.')) return;
    setDrafting(true); setError(''); setResult(null);
    try {
      const out = await lpb.feedbackDraftBatch(batch.id);
      setResult(out);
      onChange(out.batch);
      onRulesChanged();
    } catch (e) { setError(e.message); }
    setDrafting(false);
  }

  async function setItem(n, patch) {
    setError('');
    try { onChange(await lpb.feedbackUpdateActionItem(batch.id, n, patch)); } catch (e) { setError(e.message); }
  }

  async function applyRevision(n) {
    if (!window.confirm('Apply this revision to the rule? Pages already generated are not changed.')) return;
    setError('');
    try {
      const out = await lpb.feedbackApplyRevision(batch.id, n);
      onChange(out.batch);
      onRulesChanged();
    } catch (e) { setError(e.message); }
  }

  const openCount = items.filter(a => a.status !== 'done').length;

  // The confirmation says what happens to the batch's rules -- kept, at the
  // user's instruction -- and what goes with it.
  async function deleteBatch() {
    const byStatus = ['active', 'draft', 'retired']
      .map(s => [s, fromBatch.filter(r => r.status === s).length]).filter(([, n]) => n)
      .map(([s, n]) => `${n} ${s}`).join(', ');
    const pending = revisions.filter(r => !r.applied).length;
    const lines = [
      `Delete the feedback batch “${batch.title}” permanently? This cannot be undone.`,
      fromBatch.length
        ? `${fromBatch.length} rule${fromBatch.length === 1 ? ' was' : 's were'} drafted from this batch (${byStatus}). `
          + `${fromBatch.length === 1 ? 'It' : 'They'} will be KEPT and keep working, but will no longer show which batch ${fromBatch.length === 1 ? 'it' : 'they'} came from.`
        : '',
      openCount ? `Its ${openCount} open code change${openCount === 1 ? '' : 's'} will be deleted with it.` : '',
      pending ? `Its ${pending} proposed rule revision${pending === 1 ? '' : 's'} not yet applied will be deleted with it.` : '',
      'Pages already generated are not changed.',
    ].filter(Boolean);
    if (!window.confirm(lines.join('\n\n'))) return;
    setError('');
    try {
      const out = await lpb.feedbackDeleteBatch(batch.id);
      onDeleted(batch, out.keptRules || []);
    } catch (e) { setError(e.message); }
  }

  return (
    <SectionCard
      title={batch.title}
      note={`Received ${batch.received_at} · ${fromBatch.length} rule${fromBatch.length === 1 ? '' : 's'}${openCount ? ` · ${openCount} open code change${openCount === 1 ? '' : 's'}` : ''}`}
      actions={<>
        <button style={btnStyle(false)} onClick={() => setOpen(o => !o)}>{open ? 'Hide feedback' : 'Show feedback'}</button>
        {fromBatch.length > 0 && <button style={btnStyle(false)} onClick={() => onShowRules(batch.id)}>View its rules</button>}
        <button style={btnStyle(true)} disabled={drafting} onClick={draftRules}>{drafting ? 'Drafting…' : 'Draft rules with AI'}</button>
        <button style={{ ...btnStyle(false), color: 'var(--danger,#EF4444)' }} disabled={drafting} onClick={deleteBatch}>Delete</button>
      </>}
    >
      {error && <Notice>{error}</Notice>}
      {open && (
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '0.8125rem', color: 'var(--text-2)', background: 'var(--surface)', padding: '0.625rem', borderRadius: 'var(--r-md,6px)', margin: '0 0 0.75rem' }}>
          {batch.raw_text}
        </pre>
      )}

      {result && (
        <Notice tone={result.rejected.length ? 'warning' : 'success'}>
          Drafted {result.rules.length} rule{result.rules.length === 1 ? '' : 's'} (saved as draft)
          {result.revisions.length ? `, proposed ${result.revisions.length} revision${result.revisions.length === 1 ? '' : 's'}` : ''}
          {result.actionItems.length ? `, raised ${result.actionItems.length} code change${result.actionItems.length === 1 ? '' : 's'}` : ''}.
          {result.rejected.length > 0 && (
            <ul style={{ margin: '0.375rem 0 0', paddingLeft: '1.25rem' }}>
              {result.rejected.map((r, i) => <li key={i}>Not saved, “{r.title || r.key}”: {r.errors.join(' ')}</li>)}
            </ul>
          )}
        </Notice>
      )}

      {revisions.length > 0 && (
        <div style={{ marginBottom: '0.75rem' }}>
          <label style={labelStyle}>Proposed changes to rules already in force</label>
          {revisions.map((rev, n) => {
            const current = ruleByKey.get(rev.ruleKey);
            return (
              <div key={n} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', padding: '0.5rem 0.625rem', marginBottom: '0.375rem', fontSize: '0.8125rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong>{current?.title || rev.ruleKey}</strong>
                  {rev.applied
                    ? <Chip {...STATUS_STYLE.active}>applied</Chip>
                    : <button style={btnStyle(true)} onClick={() => applyRevision(n)}>Apply</button>}
                </div>
                {current && <p style={{ margin: '0.25rem 0 0', color: 'var(--text-3)' }}>Now: {current.instruction}</p>}
                <p style={{ margin: '0.25rem 0 0', color: 'var(--text-2)' }}>Proposed: {rev.rule?.instruction}</p>
              </div>
            );
          })}
        </div>
      )}

      {items.length > 0 && (
        <div>
          <label style={labelStyle}>Code changes this feedback needs <span style={{ fontWeight: 400 }}>(no rule can do these; a developer makes them)</span></label>
          {items.map((a, n) => (
            <div key={n} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginBottom: '0.375rem', fontSize: '0.8125rem' }}>
              <input type="checkbox" style={{ marginTop: '0.2rem' }} checked={a.status === 'done'}
                onChange={e => setItem(n, { status: e.target.checked ? 'done' : 'open' })} />
              <div style={{ flex: 1 }}>
                <div style={{ color: a.status === 'done' ? 'var(--text-3)' : 'var(--text)', textDecoration: a.status === 'done' ? 'line-through' : 'none' }}>{a.text}</div>
                <input style={{ ...inputStyle, marginTop: '0.25rem', fontSize: '0.75rem' }} placeholder="What was changed (saved when you leave the box)"
                  value={notes[n] ?? a.note ?? ''}
                  onChange={e => setNotes(s => ({ ...s, [n]: e.target.value }))}
                  onBlur={() => { if (notes[n] !== undefined && notes[n] !== (a.note || '')) setItem(n, { note: notes[n] }); }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
