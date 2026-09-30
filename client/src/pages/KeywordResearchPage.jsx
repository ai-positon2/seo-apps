import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import ModuleRuns from '../components/ModuleRuns';
import { PageFrame } from '../ui/PageFrame';
import { useKeywordResearch } from '../lib/useKeywordResearch';
import KrInputBar from '../components/keywordResearch/KrInputBar';
import KrTimeline from '../components/keywordResearch/KrTimeline';
import KrPicks, { KrWarning } from '../components/keywordResearch/KrPicks';
import KrSourcePool from '../components/keywordResearch/KrSourcePool';
import KrToolbar from '../components/keywordResearch/KrToolbar';

// The standalone Keyword Research tool. The run itself (stream, editing rules,
// pool, copy, handoff) is shared with Content Architect's compact panel — see
// lib/useKeywordResearch.js and components/keywordResearch/.
export default function KeywordResearchPage() {
  const navigate = useNavigate();
  const prefill = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    return {
      keyword: q.get('keyword') || '',
      client: q.get('client') || '',
      intent: q.get('intent') === 'informational' ? 'informational' : 'commercial',
    };
  }, []);
  const kr = useKeywordResearch({ initialKeyword: prefill.keyword, initialIntent: prefill.intent, client: prefill.client });
  const [editMode, setEditMode] = useState(false);
  const [showAllKeywords, setShowAllKeywords] = useState(false);

  function reset() {
    kr.reset();
    setEditMode(false);
    setShowAllKeywords(false);
  }

  function start() {
    setEditMode(false);
    setShowAllKeywords(false);
    kr.start();
  }

  const { state } = kr;

  return (
    <PageFrame
      title="Keyword Research"
      purpose="Enter a topic and pick the kind of page. It finds who ranks for that topic, pulls their keywords from Semrush, and recommends 2 primary and 10 secondary keywords."
      width="narrow"
    >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      <KrInputBar kr={{ ...kr, start, reset }} />

      {state.error && (
        <div style={{ padding: 16, background: 'var(--danger-soft, #FEF2F2)', border: '1px solid var(--danger)', borderRadius: 'var(--r-lg)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 2 }}>✕</span>
          <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--danger)', margin: 0 }}>{state.error}</p>
        </div>
      )}

      <KrTimeline kr={kr} />

      {state.result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <KrToolbar
            kr={kr}
            client={prefill.client}
            navigate={navigate}
            editMode={editMode}
            onToggleEdit={() => {
              if (!editMode) setShowAllKeywords(true);
              setEditMode(!editMode);
            }}
          />
          <KrWarning warning={state.result.warning} />
          <KrPicks kr={kr} editMode={editMode} />
          <KrSourcePool kr={kr} editMode={editMode} open={showAllKeywords} onToggle={() => setShowAllKeywords((v) => !v)} />
        </div>
      )}

      <ModuleRuns toolId="keyword-research" />
    </div>
    </PageFrame>
  );
}
