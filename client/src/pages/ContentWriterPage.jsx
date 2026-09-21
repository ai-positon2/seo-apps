import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { saveAs } from 'file-saver';
import { Button } from '../ui';
import { projectsApi } from '../lib/projectsApi';
import { readActiveProjectId, setActiveProjectId } from '../lib/activeProject';
import { contentWriterApi as api } from '../lib/contentWriterApi';
import BriefEditor from '../components/contentWriter/BriefEditor';
import DraftEditor from '../components/contentWriter/DraftEditor';
import './ContentWriterPage.css';

const options = () => ({ wordCount: '', audience: '', tone: '', language: '', secondaryKeywords: '', instructions: '', client: '', feedbackKbIds: [] });
const blank = () => ({ keyword: '', options: options(), brief: null, draftHtml: '' });
const editable = d => ({ keyword: d.keyword, options: d.options, brief: d.brief, draftHtml: d.draftHtml });
const signature = d => JSON.stringify(editable(d));
const CLIENTS = ['', 'gentle-dental', 'great-lakes', 'riccobene', 'clear-behavioral-health', 'neuro-wellness-spa', 'new-life-house'];

export default function ContentWriterPage() {
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState([]), [projectId, setProjectId] = useState('');
  const [articles, setArticles] = useState([]), [record, setRecord] = useState(null);
  const [doc, setDoc] = useState(blank), [savedSignature, setSavedSignature] = useState('');
  const [tab, setTab] = useState('brief'), [mode, setMode] = useState('edit');
  const [busy, setBusy] = useState(''), [saving, setSaving] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [progress, setProgress] = useState(''), [warnings, setWarnings] = useState([]);
  const [conflict, setConflict] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true), [exporting, setExporting] = useState(false), [stale, setStale] = useState(false);
  const current = useRef({ doc, record, projectId }), pendingSave = useRef(null), controller = useRef(null), mounted = useRef(true);
  current.current = { doc, record, projectId, savedSignature };
  const dirty = signature(doc) !== savedSignature && (!!record || !!doc.keyword.trim());
  function install(row) {
    setConflict(false);
    current.current = { doc: row.document, record: row, projectId: row.project_id };
    setRecord(row); setDoc(row.document); setSavedSignature(signature(row.document));
    setParams({ project: row.project_id, article: row.id }, { replace: true });
    setArticles(prev => [{ id: row.id, keyword: row.document.keyword, title: row.document.brief?.title,
      has_draft: !!row.document.draftHtml, updated_at: row.updated_at }, ...prev.filter(a => a.id !== row.id)]);
  }
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    (async () => {
      try {
        const result = await projectsApi.list();
        if (!alive) return;
        const list = result.projects.filter(p => p.lifecycleStatus !== 'deleted'); setProjects(list);
        const requested = params.get('project') || readActiveProjectId();
        const id = list.find(p => p.id === requested)?.id || list[0]?.id || '';
        setProjectId(id); if (id) setActiveProjectId(id);
        if (id) {
          const data = await api.list(id); if (!alive) return; setArticles(data.articles);
          // A handoff from Keyword Research or Hub & Spoke: always a fresh,
          // unsaved article, so nothing already open is overwritten. Anything
          // that was open is flushed by this page's own unmount save.
          const handoff = params.get('keyword');
          if (handoff) {
            const incoming = params.get('client') || '';
            setDoc({ ...blank(), keyword: handoff, options: { ...options(),
              secondaryKeywords: params.get('secondary') || '',
              client: CLIENTS.includes(incoming) ? incoming : '' } });
            setSettingsOpen(true);
            // Drop the handoff params so a reload does not resurrect them.
            setParams({ project: id }, { replace: true });
          } else if (params.get('article') && id === params.get('project')) {
            const row = await api.get(id, params.get('article')); if (!alive) return; install(row); setSettingsOpen(false);
          }
        }
      } catch (e) { if (alive) setError(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => {
      alive = false; mounted.current = false; controller.current?.abort();
      // The shell navigates without reloading the browser. Flush the debounce
      // window on unmount too, so a quick sidebar click doesn't discard edits.
      const snapshot = current.current;
      if (!snapshot.record || !snapshot.doc.keyword.trim() || signature(snapshot.doc) === snapshot.savedSignature) return;
      Promise.resolve(pendingSave.current).then(saved => {
        const base = saved?.id === snapshot.record.id ? saved : snapshot.record;
        if (signature(snapshot.doc) === signature(base.document)) return;
        const body = JSON.stringify({ revision: base.revision, document: snapshot.doc });
        return fetch(`/api/content-writer/projects/${snapshot.projectId}/articles/${base.id}`, {
          method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body,
          keepalive: new TextEncoder().encode(body).length < 60000,
        });
      }).catch(() => {});
    };
  }, []);

  async function save() {
    if (pendingSave.current) { await pendingSave.current; return save(); }
    const snapshot = current.current;
    if (!snapshot.projectId || !snapshot.doc.keyword.trim()) throw new Error('Select a project and enter a primary keyword.');
    setSaving(true);
    const task = snapshot.record ? api.save(snapshot.projectId, snapshot.record.id, snapshot.record.revision, snapshot.doc)
      : api.create(snapshot.projectId, snapshot.doc);
    pendingSave.current = task;
    try {
      const row = await task;
      if (!mounted.current) return row;
      // Keystrokes entered during a save stay in the editor; only the revision advances.
      const latest = current.current.doc;
      if (signature(latest) === signature(snapshot.doc)) install(row);
      else {
        current.current.record = row;
        setRecord(row); setSavedSignature(signature(row.document));
        setDoc({ ...row.document, ...editable(latest) });
      }
      return row;
    } catch (e) {
      if (e.status === 409 && mounted.current) setConflict(true);
      throw e;
    } finally { pendingSave.current = null; if (mounted.current) setSaving(false); }
  }
  const sig = signature(doc);
  useEffect(() => {
    if (!record || !dirty || busy || loading || conflict) return;
    const timer = setTimeout(() => { save().catch(e => setError(e.message)); }, 1200);
    return () => clearTimeout(timer);
  }, [sig, !!record, busy, loading, conflict]);
  useEffect(() => {
    const before = e => { if (dirty || busy) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before);
  }, [dirty, busy]);
  useEffect(() => {
    let alive = true;
    // crypto.subtle only exists in a secure context, so staleness is best-effort.
    if (!doc.brief || !doc.draftBriefHash || !window.crypto?.subtle) { setStale(false); return; }
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(doc.brief))).then(hash => {
      if (alive) setStale([...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('') !== doc.draftBriefHash);
    }).catch(() => { if (alive) setStale(false); });
    return () => { alive = false; };
  }, [doc.brief, doc.draftBriefHash]);

  async function switchProject(id) {
    if (busy) return;
    setLoading(true); setError('');
    try {
      if (dirty) await save();
      const data = await api.list(id);
      setProjectId(id); setActiveProjectId(id); setArticles(data.articles); setRecord(null); setDoc(blank()); setSavedSignature(''); setTab('brief');
      setParams({ project: id }, { replace: true }); setSettingsOpen(true); setWarnings([]); setProgress('');
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }
  async function openArticle(id) {
    setLoading(true); setError('');
    try {
      if (dirty) await save();
      const row = await api.get(projectId, id); install(row); setSettingsOpen(false); setTab(row.document.draftHtml ? 'draft' : 'brief');
      // Notices belong to the article that produced them.
      setWarnings([]); setProgress('');
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }
  async function newArticle() {
    setError('');
    try {
      if (dirty) await save();
      setRecord(null); setDoc(blank()); setSavedSignature(''); setTab('brief'); setSettingsOpen(true); setWarnings([]); setProgress('');
      setParams({ project: projectId }, { replace: true });
    } catch (e) { setError(e.message); }
  }
  async function generate(stage) {
    setError(''); setWarnings([]); setBusy(stage); setProgress('Saving your work…');
    try {
      const row = await save();
      controller.current = new AbortController();
      const result = await api.generate(row.project_id, row.id, row.revision, stage, (type, data) => {
        if (type === 'step') setProgress(data.message);
        if (type === 'warning') setWarnings(w => [...w, data.message]);
      }, controller.current.signal);
      install(result); setTab(stage); setSettingsOpen(false); setProgress('');
    } catch (e) { if (e.name !== 'AbortError') setError(e.message); }
    finally { if (mounted.current) setBusy(''); controller.current = null; }
  }
  async function exportFile(format) {
    setError(''); setExporting(true);
    try {
      const filename = (doc.brief?.title || doc.keyword || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 90) || 'article';
      if (format === 'json') {
        saveAs(new Blob([JSON.stringify({ schemaVersion: 1, projectId, articleId: record?.id || null,
          exportedAt: new Date().toISOString(), ...doc }, null, 2)], { type: 'application/json' }), `${filename}.json`);
      } else {
        const res = await fetch(`/api/content-writer/projects/${projectId}/export`, { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: tab, document: doc }) });
        if (!res.ok) { const body = await res.json(); throw new Error(body.error || 'Export failed.'); }
        saveAs(await res.blob(), `${filename}-${tab}.docx`);
      }
    } catch (e) { setError(e.message); } finally { setExporting(false); }
  }
  const changeOptions = (key, value) => setDoc(d => ({ ...d, options: { ...d.options, [key]: value } }));
  const disabled = !!busy || loading;
  const plain = doc.draftHtml.replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ').trim();
  const wordCount = plain ? plain.split(/\s+/).length : 0;
  const links = (doc.draftHtml.match(/<a\s/gi) || []).length;
  return <div className="cw-page">
    <header className="cw-page-heading"><div><span className="cw-eyebrow">CONTENT STUDIO</span><h1>Content Writer</h1><p>Research the brief. Shape the story. Make it yours.</p></div>
      <label>Project<select aria-label="Project" value={projectId} disabled={disabled || saving} onChange={e => switchProject(e.target.value)}>
        {!projects.length && <option value="">No projects available</option>}{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label></header>
    {error && <div className="cw-notice cw-error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {conflict && <div className="cw-notice">Another session saved this article. Export JSON to keep your local edits before reloading.
      <Button size="sm" variant="secondary" onClick={async () => { try { install(await api.get(projectId, record.id)); setError(''); } catch (e) { setError(e.message); } }}>Discard local edits & reload saved article</Button></div>}
    {!loading && !projects.length && <div className="cw-empty"><h2>Select a home for your content</h2><p>Create a project to save briefs and drafts.</p><Link to="/projects">Go to projects →</Link></div>}
    {!!projects.length && <div className="cw-workspace">
      <aside className="cw-library"><div className="cw-library-title"><strong>Project articles</strong><Button size="sm" variant="ghost" disabled={disabled || saving} onClick={newArticle}>+ New</Button></div>
        {!articles.length && <p className="cw-muted">Your saved briefs and drafts will appear here.</p>}
        {articles.map(a => <button key={a.id} className={`cw-article ${record?.id === a.id ? 'selected' : ''}`} disabled={disabled || saving} onClick={() => openArticle(a.id)}>
          <span>{a.title || a.keyword}</span><small>{a.has_draft ? 'Draft' : 'Brief'} · {new Date(a.updated_at).toLocaleDateString()}</small></button>)}
      </aside>
      <main className="cw-main" aria-busy={disabled}>
        <div className="cw-setup">
          <div className="cw-keyword-row"><label className="cw-label">Primary keyword<input value={doc.keyword} disabled={disabled} placeholder="e.g. what is periodontal disease" maxLength={500}
            onChange={e => setDoc(d => ({ ...d, keyword: e.target.value }))} /></label>
            <Button disabled={disabled || !doc.keyword.trim() || !projectId} loading={busy === 'brief'} onClick={() => generate('brief')}>{doc.brief ? 'Rebuild brief' : 'Build brief'}</Button></div>
          <button className="cw-settings-toggle" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(v => !v)}>Writing preferences <span>All optional</span> {settingsOpen ? '−' : '+'}</button>
          {settingsOpen && <fieldset disabled={disabled} className="cw-settings">
            <label>Target word count<input type="number" min={100} max={10000} placeholder="Automatic" value={doc.options.wordCount} onChange={e => changeOptions('wordCount', e.target.value === '' ? '' : Number(e.target.value))} /></label>
            {['audience','tone','language'].map(key => <label key={key}>{key[0].toUpperCase() + key.slice(1)}<input value={doc.options[key]} placeholder={key === 'language' ? 'English' : 'Automatic'} onChange={e => changeOptions(key, e.target.value)} /></label>)}
            <label className="cw-wide">Secondary keywords<input value={doc.options.secondaryKeywords} placeholder="Separate keywords with commas" onChange={e => changeOptions('secondaryKeywords', e.target.value)} /></label>
            <label className="cw-wide">Custom writing instructions<textarea rows={3} value={doc.options.instructions} placeholder="What should the writer know?" onChange={e => changeOptions('instructions', e.target.value)} /></label>
            <label className="cw-wide">Client knowledge base<select value={doc.options.client} onChange={e => changeOptions('client', e.target.value)}>{CLIENTS.map(c => <option key={c} value={c}>{c ? c.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ') : 'No client knowledge base'}</option>)}</select></label>
          </fieldset>}
        </div>
        {busy && <div className="cw-progress" role="status"><span className="cw-pulse" />{progress}<small>You can continue editing when generation completes.</small></div>}
        {warnings.map((w, i) => <div className="cw-notice" key={i}>{w}</div>)}
        <div className="cw-tabs" role="tablist" aria-label="Content stage">{['brief','draft'].map(t => <button role="tab" key={t} aria-selected={tab === t} className={tab === t ? 'selected' : ''}
          onClick={() => setTab(t)}>{t === 'brief' ? 'Brief' : 'Draft'}{t === 'draft' && doc.draftHtml && <span className="cw-dot" />}</button>)}
          <div className="cw-save-status" aria-live="polite">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : record ? 'Saved to project' : 'New article'}</div>
          <Button size="sm" variant="secondary" disabled={disabled || saving || !dirty} onClick={() => save().catch(e => setError(e.message))}>Save</Button>
        </div>
        <div className="cw-tools"><div className="cw-modes">{['preview','edit'].map(m => <button key={m} aria-pressed={mode === m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>{m === 'preview' ? 'Preview' : 'Edit'}</button>)}</div>
          {tab === 'draft' && !!doc.draftHtml && <span className="cw-count">{wordCount.toLocaleString()} words · {links} links</span>}
          <div className="cw-export"><Button size="sm" variant="ghost" disabled={exporting || !(tab === 'brief' ? doc.brief : doc.draftHtml)} onClick={() => exportFile('docx')}>Export {tab} · DOCX</Button>
            <Button size="sm" variant="ghost" disabled={exporting || !doc.keyword.trim()} onClick={() => exportFile('json')}>Export JSON</Button></div>
        </div>
        {tab === 'brief' ? doc.brief ? <>
          <BriefEditor brief={doc.brief} editable={mode === 'edit' && !disabled} onChange={brief => setDoc(d => ({ ...d, brief }))} />
          <div className="cw-generate"><p>Your edited brief guides the draft, including the heading order and instructions.</p>
            <Button disabled={disabled || !doc.brief.title.trim() || !doc.brief.sections.length} onClick={() => generate('draft')}>Generate draft →</Button></div>
        </> : <div className="cw-empty"><span className="cw-empty-icon">01</span><h2>A researched starting point</h2><p>Enter a keyword to analyze the top 10 Google results and build your editable brief.</p></div>
          : doc.draftHtml ? <>
            {stale && <div className="cw-notice">The brief has changed since this draft was generated. Regenerate when you want to apply those changes.</div>}
            <DraftEditor key={record?.id || 'new'} value={doc.draftHtml} editable={mode === 'edit' && !disabled} onChange={draftHtml => setDoc(d => ({ ...d, draftHtml,
              research: d.research ? { ...d.research, status: 'Draft edited after source check' } : undefined }))} />
            {doc.research && <details className="cw-evidence"><summary>Sources & CSQAF notes · {doc.research.status}</summary>
              <p className="cw-muted">Generated draft checked against retrieved sources{Number.isNaN(Date.parse(doc.research.checkedAt)) ? '' : ` ${new Date(doc.research.checkedAt).toLocaleString()}`}. Manual edits are not automatically rechecked.</p>
              <ul>{doc.research.sources.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a></li>)}</ul>
              {doc.research.gaps.map((g, i) => <p key={i}>{g}</p>)}
              {!!doc.research.omitted?.length && <><p><strong>Removed because it could not be verified</strong></p>
                <ul className="cw-omitted">{doc.research.omitted.map((o, i) => <li key={i}><q>{o.text}</q><small>{o.reason}</small></li>)}</ul></>}</details>}
            <div className="cw-generate"><p>Regeneration replaces the current draft. Export a copy first if you want to keep it.</p><Button variant="secondary" disabled={disabled} onClick={() => generate('draft')}>Regenerate draft</Button></div>
          </> : <div className="cw-empty"><span className="cw-empty-icon">02</span><h2>Turn your brief into a story</h2><p>Review the brief first, then generate an article with researched sources and CSQAF guidance.</p>
            <Button disabled={disabled || !doc.brief?.sections.length} onClick={() => generate('draft')}>Generate draft</Button></div>}
      </main>
    </div>}
    {loading && <p role="status" className="cw-muted">Loading project content…</p>}
  </div>;
}
