import { useRef, useState } from 'react';
import { Button } from '../../ui';

const LEVELS = ['H2', 'H3', 'H4', 'H5', 'H6'];
const depth = section => Number(section.level.slice(1));

function AutoArea(props) {
  return <textarea {...props} ref={el => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }} />;
}
export default function BriefEditor({ brief, onChange, editable }) {
  // The source index is a ref because a drop must not wait for a re-render;
  // the state alongside it only drives the drop indicator.
  const from = useRef(null);
  const [over, setOver] = useState(null);
  const sections = brief.sections;
  const changeSection = (id, patch) => onChange({ ...brief, sections: sections.map(s => s.id === id ? { ...s, ...patch } : s) });
  // Deleting or moving a heading can strand the ones nested under it, so every
  // edit funnels through here and no outline is ever left skipping a level.
  function setSections(next) {
    const out = [];
    for (const s of next) {
      const max = out.length ? Math.min(depth(out[out.length - 1]) + 1, 6) : 2;
      out.push(depth(s) > max ? { ...s, level: `H${max}` } : s);
    }
    onChange({ ...brief, sections: out });
  }
  // A heading owns the deeper headings beneath it, so reordering moves the group.
  function blockAt(index) {
    let end = index + 1;
    while (end < sections.length && depth(sections[end]) > depth(sections[index])) end++;
    return [index, end];
  }
  function move(fromIndex, to) {
    const [start, end] = blockAt(fromIndex);
    if (to >= start && to <= end) return;
    const block = sections.slice(start, end);
    const rest = [...sections.slice(0, start), ...sections.slice(end)];
    rest.splice(to > start ? to - block.length : to, 0, ...block);
    setSections(rest);
  }
  // An outline cannot skip a level, so a heading may sit at most one step below the one above it.
  const maxDepth = index => (index === 0 ? 2 : Math.min(depth(sections[index - 1]) + 1, 6));
  function setLevel(index, level) {
    const [start, end] = blockAt(index);
    const shift = Number(level.slice(1)) - depth(sections[index]);
    setSections(sections.map((s, i) => (i < start || i >= end ? s
      : { ...s, level: `H${Math.min(6, Math.max(2, depth(s) + shift))}` })));
  }
  // Dropping on the lower half of a heading puts the dragged group after it.
  function lands(e, index) {
    const box = e.currentTarget.getBoundingClientRect();
    return { index, after: e.clientY > box.top + box.height / 2 };
  }
  return <div className="cw-brief">
    <label className="cw-label" htmlFor="cw-title">H1 suggestion (title)</label>
    {editable ? <input id="cw-title" className="cw-title-input" value={brief.title} onChange={e => onChange({ ...brief, title: e.target.value })} /> : <h1>{brief.title}</h1>}
    {brief.intro && <label className="cw-label">Brief notes<AutoArea value={brief.intro} readOnly={!editable} onChange={e => onChange({ ...brief, intro: e.target.value })} /></label>}
    <div className="cw-outline-title"><span>Main outline</span>{editable && <Button variant="ghost" size="sm" onClick={() => setSections([...sections,
      { id: crypto.randomUUID(), level: 'H2', heading: '', guidance: '' }])}>+ Add heading</Button>}</div>
    {sections.map((s, i) => <section key={s.id}
      className={`cw-section cw-level-${depth(s)}${from.current === i ? ' cw-dragging' : ''}`
        + (over?.index === i ? (over.after ? ' cw-drop-after' : ' cw-drop-before') : '')}
      onDragOver={e => { if (editable && from.current !== null) { e.preventDefault(); setOver(lands(e, i)); } }}
      onDragLeave={() => setOver(o => (o?.index === i ? null : o))}
      onDrop={e => {
        e.preventDefault();
        if (editable && from.current !== null) { const to = lands(e, i); move(from.current, to.after ? i + 1 : i); }
        from.current = null; setOver(null);
      }}>
      <div className="cw-section-head">
        {editable && <button className="cw-drag" draggable title="Drag to reorder heading" aria-label={`Drag section ${i + 1}`}
          onDragStart={e => { from.current = i; setOver({ index: i, after: false }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); }}
          onDragEnd={() => { from.current = null; setOver(null); }}>⠿</button>}
        <span className="cw-section-number">{i + 1}</span>
        {editable ? <input aria-label={`Section ${i + 1} heading`} placeholder="Heading" value={s.heading} onChange={e => changeSection(s.id, { heading: e.target.value })} /> : <h2>{s.heading}</h2>}
        <div className="cw-heading-actions">
          <select className="cw-level-select" value={s.level} disabled={!editable} aria-label={`Section ${i + 1} heading level`}
            title="Heading level" onChange={e => setLevel(i, e.target.value)}>
            {LEVELS.map(level => <option key={level} value={level} disabled={Number(level.slice(1)) > maxDepth(i)}>{level}</option>)}
          </select>
          {editable && <>
            <button type="button" title="Move up" aria-label={`Move section ${i + 1} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
            <button type="button" title="Move down" aria-label={`Move section ${i + 1} down`} disabled={blockAt(i)[1] >= sections.length} onClick={() => move(i, blockAt(i)[1] + 1)}>↓</button>
            <button type="button" title="Delete heading" aria-label={`Delete section ${i + 1}`} onClick={() => setSections(sections.filter(x => x.id !== s.id))}>×</button>
          </>}
        </div>
      </div>
      <AutoArea aria-label={`Section ${i + 1} writing instructions`} className="cw-guidance" placeholder="Writing instructions, keywords and visual suggestions…" value={s.guidance} readOnly={!editable}
        onChange={e => changeSection(s.id, { guidance: e.target.value })} />
    </section>)}
    <label className="cw-label">Reference URLs<AutoArea value={brief.references} readOnly={!editable} onChange={e => onChange({ ...brief, references: e.target.value })} /></label>
  </div>;
}
