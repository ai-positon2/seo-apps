import { useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';

const HEADINGS = [1, 2, 3, 4, 5, 6];

export default function DraftEditor({ value, onChange, editable }) {
  const [linkOpen, setLinkOpen] = useState(false), [linkUrl, setLinkUrl] = useState('');
  const [, refresh] = useState(0);
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: { openOnClick: false, protocols: ['http', 'https'] } }), TableKit],
    content: value, editable,
    editorProps: { attributes: { class: 'cw-prose', 'aria-label': 'Article draft', role: 'textbox', 'aria-multiline': 'true' } },
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    onSelectionUpdate: () => refresh(n => n + 1),
    onTransaction: () => refresh(n => n + 1),
  });
  useEffect(() => { if (editor && value !== editor.getHTML()) editor.commands.setContent(value, { emitUpdate: false }); }, [editor, value]);
  useEffect(() => { editor?.setEditable(editable, false); }, [editor, editable]);
  if (!editor) return null;
  const button = (label, fn, active = false, disabled = false) => <button key={label} type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled}
    onMouseDown={e => e.preventDefault()} onClick={fn} className={active ? 'active' : ''}>{label}</button>;
  return <div className="cw-draft-editor">
    {editable && <div className="cw-formatbar" role="toolbar" aria-label="Draft formatting">
      <select aria-label="Paragraph style" value={HEADINGS.find(level => editor.isActive('heading', { level })) || 0}
        onChange={e => Number(e.target.value) ? editor.chain().focus().setHeading({ level: Number(e.target.value) }).run() : editor.chain().focus().setParagraph().run()}>
        <option value={0}>Paragraph</option>
        {HEADINGS.map(level => <option key={level} value={level}>Heading {level} (H{level})</option>)}
      </select>
      {button('Bold', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
      {button('Italic', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
      {button('Underline', () => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline'))}
      {button('Bullets', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
      {button('Numbered list', () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {button('Link', () => { setLinkUrl(editor.getAttributes('link').href || ''); setLinkOpen(v => !v); }, editor.isActive('link'))}
      {button('Table', () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
      {button('Undo', () => editor.chain().focus().undo().run(), false, !editor.can().undo())}
      {button('Redo', () => editor.chain().focus().redo().run(), false, !editor.can().redo())}
      {editor.isActive('table') && <>
        {button('Add row', () => editor.chain().focus().addRowAfter().run())}
        {button('Add column', () => editor.chain().focus().addColumnAfter().run())}
        {button('Delete row', () => editor.chain().focus().deleteRow().run())}
        {button('Delete column', () => editor.chain().focus().deleteColumn().run())}
        {button('Delete table', () => editor.chain().focus().deleteTable().run())}
      </>}
    </div>}
    {linkOpen && editable && <form className="cw-link-form" onSubmit={e => {
      e.preventDefault();
      if (linkUrl && !/^https?:\/\//i.test(linkUrl)) return;
      const chain = editor.chain().focus().extendMarkRange('link');
      linkUrl ? chain.setLink({ href: linkUrl }).run() : chain.unsetLink().run(); setLinkOpen(false);
    }}><label>Link URL <input aria-label="Link URL" type="url" placeholder="https://" value={linkUrl} onChange={e => setLinkUrl(e.target.value)} /></label>
      <button type="submit">Apply</button><button type="button" onClick={() => setLinkOpen(false)}>Cancel</button></form>}
    <EditorContent editor={editor} />
  </div>;
}
