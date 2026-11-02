import { Link } from 'react-router-dom';
import { parseBlocks, parseInline } from './chatModel';

// ── One message in the assistant panel ──────────────────────────────────────
//
// Answers are rendered from parseBlocks/parseInline tokens, never as HTML, and
// a link in the text becomes a link only when isSafeAppPath passed it. A link
// the model made up shows as its label.
//
// Under an answer, two things the server decides rather than the text:
//   • Sources — the pages a web search cited (server-cleaned, http(s) only).
//     The only external links the panel ever renders.
//   • The Position2 specialist notice, on answers that gave advice.

function Inline({ text, onNavigate }) {
  return parseInline(text).map((tok, i) => {
    if (tok.type === 'bold') return <strong key={i}>{tok.text}</strong>;
    if (tok.type === 'link') {
      return tok.safe
        ? <Link key={i} to={tok.path} onClick={onNavigate}>{tok.text}</Link>
        : <span key={i}>{tok.text}</span>;
    }
    return <span key={i}>{tok.text}</span>;
  });
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

export default function ChatMessage({
  role, content, pending = false, onNavigate,
  sources = [], offerExpert = false, connectRequested = false, onConnectExpert = null,
}) {
  if (role === 'user') {
    return <div className="report-chat__msg report-chat__msg--user">{content}</div>;
  }
  return (
    <div className="report-chat__msg report-chat__msg--assistant" aria-busy={pending || undefined}>
      {!content && pending && <span className="report-chat__typing" aria-label="Writing an answer"><span /><span /><span /></span>}
      {parseBlocks(content).map((block, i) => {
        if (block.type === 'p') return <p key={i}><Inline text={block.text} onNavigate={onNavigate} /></p>;
        const List = block.type === 'ol' ? 'ol' : 'ul';
        return (
          <List key={i}>
            {block.items.map((item, j) => <li key={j}><Inline text={item} onNavigate={onNavigate} /></li>)}
          </List>
        );
      })}

      {!pending && sources.length > 0 && (
        <div className="report-chat__sources">
          <span className="report-chat__sources-label">Sources</span>
          <ol>
            {sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || hostOf(s.url)}</a>
                <span className="report-chat__source-host"> · {hostOf(s.url)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {!pending && offerExpert && (
        <div className="report-chat__expert">
          <p>This is general guidance. A Position2 SEO specialist can review this for your business.</p>
          {connectRequested
            ? <p className="report-chat__expert-note" role="status">Coming soon: we’ll connect you with a specialist from here.</p>
            : (
              <button type="button" className="report-chat__expert-btn" onClick={onConnectExpert || undefined}>
                Connect with a Position2 specialist
              </button>
            )}
        </div>
      )}
    </div>
  );
}
