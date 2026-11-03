import { useEffect, useState } from 'react';
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
// Then the answer's actions. Copy works; "Add to report" and "Share with team"
// have no feature behind them yet and say so when clicked.

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

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const SOON = {
  report: 'Coming soon: adding an answer to the report.',
  share: 'Coming soon: sharing an answer with your team.',
};

function AnswerActions({ content }) {
  const [copied, setCopied] = useState(false);
  const [soon, setSoon] = useState(null);

  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      // Plain text: bold markers dropped, app links reduced to their labels.
      await navigator.clipboard.writeText(content.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
      setCopied(true);
    } catch { /* clipboard blocked: nothing useful to say */ }
  };

  return (
    <>
      <div className="report-chat__answer-actions">
        <button type="button" className="report-chat__action" onClick={copy}>
          <CopyIcon />{copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="report-chat__action" onClick={() => setSoon('report')}>
          <PlusIcon />Add to report
        </button>
        <button type="button" className="report-chat__action" onClick={() => setSoon('share')}>
          <ShareIcon />Share with team
        </button>
      </div>
      {soon && <p className="report-chat__soon" role="status">{SOON[soon]}</p>}
    </>
  );
}

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
          <span className="report-chat__label">Sources</span>
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
          <span className="report-chat__label report-chat__label--accent">Talk to a specialist</span>
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

      {!pending && content && <AnswerActions content={content} />}
    </div>
  );
}
