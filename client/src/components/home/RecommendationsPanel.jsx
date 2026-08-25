import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  projectsApi, RECOMMENDATION_STATUS_LABEL, RECOMMENDATION_STATUS_TONE, relativeTime,
} from '../../lib/projectsApi';
import { Card, SectionHead, Muted, Tag, Btn, FadingRule } from './primitives';

// ── The recommendation board (PRD phase 6) ──────────────────────────────────
//
// Findings are observations; recommendations are advice somebody is accountable
// for. This panel is where that accountability is visible: what is waiting on a
// decision, who approved what, and why anything was declined.
//
// Which buttons render comes from the capability map the server sent. Every one
// of them is re-checked server-side against the same §7.2 matrix, so this gating
// is there to avoid offering an action that would 403 — not to enforce anything.

const PRIORITY_TONE = { urgent: 'neg', high: 'warn', medium: 'muted', low: 'muted' };

// Awaiting a decision first: this panel exists to stop advice sitting unread.
const STATUS_ORDER = ['proposed', 'approved', 'draft', 'shipped', 'rejected'];

export default function RecommendationsPanel({ projectId, reloadNonce = 0 }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busyId, setBusyId] = useState(null);
  const [rejecting, setRejecting] = useState(null);   // id awaiting a reason
  const [reason, setReason] = useState('');
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setState({ loading: false, error: null, data: await projectsApi.recommendations(projectId) });
    } catch (e) {
      setState({ loading: false, error: e, data: null });
    }
  }, [projectId]);

  // reloadNonce is bumped when a backlog item is drafted into this board from
  // the insights panel above. Without it the new draft would not appear until a
  // full page reload, and promoting would look like it did nothing.
  useEffect(() => { load(); }, [load, reloadNonce]);

  const items = state.data?.recommendations || [];
  const caps = state.data?.capabilities || {};
  const summary = state.data?.summary?.counts || {};

  const sorted = useMemo(
    () => [...items].sort(
      (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
    ),
    [items],
  );
  const visible = showAll ? sorted : sorted.slice(0, 6);

  async function move(id, to, extra) {
    setBusyId(id);
    try {
      await projectsApi.setRecommendationStatus(projectId, id, to, extra);
      setRejecting(null);
      setReason('');
      await load();
    } catch (e) {
      setState((s) => ({ ...s, error: e }));
    } finally {
      setBusyId(null);
    }
  }

  if (state.loading) return null;

  return (
    <Card style={{ padding: 16 }}>
      <SectionHead
        title="Recommendations"
        right={items.length
          ? STATUS_ORDER.filter((s) => summary[s]).map((s) => `${summary[s]} ${s}`).join(' · ')
          : null}
      />

      {state.error && (
        <Muted size={12.5} style={{ color: 'var(--viz-neg)', display: 'block', marginBottom: 10 }}>
          {state.error.message}
        </Muted>
      )}

      {!items.length ? (
        <Muted size={12.5} style={{ display: 'block' }}>
          Nothing raised yet. Findings become recommendations when somebody decides they are worth
          advising on — open a module card and turn its findings into drafts.
        </Muted>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visible.map((item) => {
            const busy = busyId === item.id;
            return (
              <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                  <Tag tone={RECOMMENDATION_STATUS_TONE[item.status] || 'muted'}>
                    {RECOMMENDATION_STATUS_LABEL[item.status] || item.status}
                  </Tag>
                  {item.priority !== 'medium' && (
                    <Tag tone={PRIORITY_TONE[item.priority] || 'muted'}>{item.priority}</Tag>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{item.title}</span>
                    {item.body && <Muted size={11.5}>{item.body}</Muted>}
                    <Muted>
                      {item.moduleKey ? item.moduleKey.replace(/_/g, ' ') : 'raised by hand'}
                      {item.shippedAt
                        ? ` · shipped ${relativeTime(item.shippedAt)}`
                        : item.approvedAt
                          ? ` · approved ${relativeTime(item.approvedAt)}`
                          : item.rejectedAt
                            ? ` · declined ${relativeTime(item.rejectedAt)}`
                            : item.proposedAt
                              ? ` · proposed ${relativeTime(item.proposedAt)}`
                              : ''}
                    </Muted>
                    {item.rejectionReason && (
                      <Muted size={11.5} style={{ color: 'var(--viz-warn)' }}>
                        Declined: {item.rejectionReason}
                      </Muted>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {item.status === 'draft' && caps.edit === true && (
                      <Btn
                        disabled={busy}
                        style={{ height: 28, fontSize: 11.5, padding: '0 10px' }}
                        onClick={() => move(item.id, 'proposed')}
                      >
                        Propose
                      </Btn>
                    )}
                    {item.status === 'proposed' && caps.approve === true && (
                      <>
                        <Btn
                          variant="primary"
                          disabled={busy}
                          style={{ height: 28, fontSize: 11.5, padding: '0 10px' }}
                          onClick={() => move(item.id, 'approved')}
                        >
                          Approve
                        </Btn>
                        <Btn
                          variant="danger"
                          disabled={busy}
                          style={{ height: 28, fontSize: 11.5, padding: '0 10px' }}
                          onClick={() => { setRejecting(item.id); setReason(''); }}
                        >
                          Decline
                        </Btn>
                      </>
                    )}
                    {item.status === 'approved' && caps.recordShipped === true && (
                      <Btn
                        disabled={busy}
                        style={{ height: 28, fontSize: 11.5, padding: '0 10px' }}
                        onClick={() => move(item.id, 'shipped')}
                      >
                        Mark shipped
                      </Btn>
                    )}
                    {item.status === 'rejected' && caps.edit === true && (
                      <Btn
                        disabled={busy}
                        style={{ height: 28, fontSize: 11.5, padding: '0 10px' }}
                        onClick={() => move(item.id, 'proposed')}
                      >
                        Reopen
                      </Btn>
                    )}
                  </div>
                </div>

                {/* A decline needs a reason — it is the record of why advice was
                    not taken, which is what a retro actually asks about. */}
                {rejecting === item.id && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', paddingLeft: 8 }}>
                    <input
                      autoFocus
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Why is this being declined?"
                      style={{
                        flex: 1, minWidth: 200, minHeight: 30, padding: '5px 9px', fontSize: 12.5,
                        fontFamily: 'var(--font-sans)', color: 'var(--text)', background: 'var(--surface)',
                        border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', outline: 'none',
                      }}
                    />
                    <Btn
                      variant="danger"
                      disabled={!reason.trim() || busy}
                      style={{ height: 30, fontSize: 11.5, padding: '0 10px' }}
                      onClick={() => move(item.id, 'rejected', { reason: reason.trim() })}
                    >
                      Decline
                    </Btn>
                    <Btn
                      style={{ height: 30, fontSize: 11.5, padding: '0 10px' }}
                      onClick={() => { setRejecting(null); setReason(''); }}
                    >
                      Cancel
                    </Btn>
                  </div>
                )}
              </div>
            );
          })}

          {sorted.length > visible.length && (
            <>
              <FadingRule />
              <Btn
                variant="ghost"
                style={{ alignSelf: 'flex-start', height: 28, fontSize: 12, padding: '0 10px' }}
                onClick={() => setShowAll(true)}
              >
                Show all {sorted.length}
              </Btn>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
