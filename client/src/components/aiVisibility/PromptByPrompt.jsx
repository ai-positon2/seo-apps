import { Badge } from '../../ui';
import { muted, verdictLabel, verdictColor } from './promptHelpers';

/**
 * One block per PROMPT, not per capture. The old version iterated
 * data.captures directly, so a prompt measured on two surfaces (ChatGPT and
 * Google AI Overview) rendered twice, and an approved prompt this run never
 * measured (over budget) rendered nowhere. `data.byPrompt` is server-grouped
 * (scoring.groupByPrompt) for exactly this reason — see its own header.
 */
export function PromptByPrompt({ byPrompt }) {
  if (!byPrompt.length) return <div style={muted}>No prompts were measured.</div>;

  return (
    <div>
      {byPrompt.map((g) => {
        const notMeasured = g.surfaces.length === 0;
        return (
          <div key={g.promptId || g.text} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 11,
                color: verdictColor(g.mentionedOnAnySurface),
              }}>
                {verdictLabel(g.mentionedOnAnySurface)}
              </span>
              <span style={{ fontSize: 13, color: 'var(--text)' }}>{g.text}</span>
              {g.demandVolume != null && <Badge variant="info">vol {g.demandVolume.toLocaleString()}</Badge>}
              {g.orphaned && <Badge variant="neutral">orphaned</Badge>}
            </div>

            {notMeasured ? (
              <div style={{ ...muted, color: 'var(--warning)', marginTop: 3 }}>
                Not measured this run — approved after the run started, or over the run&apos;s budget.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                {g.surfaces.map((s) => {
                  const surfaceNotMeasured = s.mentioned === null;
                  return (
                    <div key={`${s.surfaceLabel}-${s.id || s.capturedAt}`} style={{ ...muted, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ minWidth: 160, color: 'var(--text-2)' }}>{s.surfaceLabel}</span>
                      {surfaceNotMeasured ? (
                        <span style={{ color: 'var(--warning)' }}>not measured — {s.failureReason || s.status}</span>
                      ) : (
                        <span>
                          <span style={{ color: s.mentioned ? 'var(--success)' : 'var(--danger)' }}>
                            {s.mentioned ? 'named' : 'absent'}
                          </span>
                          {' · own domain cited: '}{s.cited === null ? 'unknown' : s.cited ? 'yes' : 'no'}
                          {s.competitorsMentioned?.length ? ` · competitors: ${s.competitorsMentioned.join(', ')}` : ''}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default PromptByPrompt;
