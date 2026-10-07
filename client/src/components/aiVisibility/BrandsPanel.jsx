import { useCallback, useEffect, useState } from 'react';
import {
  Card, Button, Badge, EmptyState, useToast,
} from '../../ui';
import { aiVisibilityApi } from '../../lib/aiVisibilityApi';
import { muted } from './promptHelpers';

// ── The measured set ────────────────────────────────────────────────────────
//
// METRICS.md §3.4's denominator, made reviewable. Nothing on this screen is
// cosmetic: until a brand is APPROVED here, extraction has nothing to match
// against and every report renders an em-dash.
//
// Why review at all, rather than just deriving and using it — two reasons the
// code cannot decide on its own:
//
//   Competitor "names" in this codebase are domain stems ("aspendental"), which
//   no model ever writes. Derivation turns that into "Aspen Dental", and until
//   it did, every competitor mention was missed and the client's share of voice
//   was inflated in the flattering direction. That fix is worth a human glance.
//
//   A brand whose every token is a generic industry word ("Dental Care Group")
//   would get a matcher that fires on the whole category. Derivation flags that
//   as `weak` rather than quietly shipping it, and a person decides.

const STATUS_VARIANT = { approved: 'success', proposed: 'warning', rejected: 'neutral' };

export function BrandsPanel({ project, onChange }) {
  const toast = useToast();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ loading: false, error: null, data: await aiVisibilityApi.brands(project.id) });
    } catch (e) {
      setState({ loading: false, error: e, data: null });
    }
  }, [project.id]);

  useEffect(() => { load(); }, [load]);

  async function derive() {
    setBusy('derive');
    try {
      const result = await aiVisibilityApi.deriveBrands(project.id);
      const parts = [];
      if (result.added) parts.push(`${result.added} proposed`);
      if (result.updated) parts.push(`${result.updated} updated`);
      if (result.pending?.length) parts.push(`${result.pending.length} needing review on an approved brand`);
      toast.show(parts.length ? `Derived: ${parts.join(', ')}.` : 'Nothing new to propose.', 'success');
      await load();
      onChange?.();
    } catch (e) {
      toast.show(e.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(brand, to) {
    setBusy(brand.id);
    try {
      await aiVisibilityApi.setBrandStatus(project.id, brand.id, to);
      await load();
      onChange?.();
    } catch (e) {
      toast.show(e.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  if (state.loading && !state.data) {
    return <Card><div style={muted}>Reading the measured set…</div></Card>;
  }

  if (state.error) {
    return (
      <Card style={{ borderColor: 'var(--danger)' }}>
        <div style={{ fontSize: 13, color: 'var(--text)' }}>{state.error.message}</div>
        {state.error.code === 'migration_needed' && (
          <div style={{ ...muted, marginTop: 6 }}>
            Apply <code>supabase/migrations/0018_ai_visibility_entities.sql</code>, then reload.
          </div>
        )}
      </Card>
    );
  }

  const brands = state.data?.brands || [];
  const approved = brands.filter((b) => b.status === 'approved');
  const proposed = brands.filter((b) => b.status === 'proposed');
  const rejected = brands.filter((b) => b.status === 'rejected');

  return (
    <>
      {!state.data?.hasApprovedClient && (
        <Card style={{ borderColor: 'var(--danger)', marginBottom: 16 }}>
          <div style={{ fontSize: 13.5, color: 'var(--text)' }}>
            No approved client brand, so nothing can be measured yet.
          </div>
          <div style={{ ...muted, marginTop: 6 }}>
            Every report will show an em-dash until the client brand below is approved. That is
            deliberate — an unreviewed alias set would rather report nothing than report a
            number built on a matcher nobody checked.
          </div>
        </Card>
      )}

      <Card
        title="Measured set"
        actions={(
          <Button size="sm" onClick={derive} loading={busy === 'derive'}>
            {brands.length ? 'Re-derive' : 'Derive from project'}
          </Button>
        )}
        style={{ marginBottom: 16 }}
      >
        <div style={{ ...muted, marginBottom: 14 }}>
          Share of voice is computed over this set only. A brand named in an answer but not
          configured here goes into an <code>other</code> bucket that is excluded from the
          denominator — otherwise the percentages would move every time a model name-drops an
          unrelated business.
        </div>

        {!brands.length && (
          <EmptyState
            title="Nothing configured yet"
            description="Derive the client and its competitors from the project's own domains, then approve what looks right."
            action={<Button onClick={derive} loading={busy === 'derive'}>Derive from project</Button>}
          />
        )}

        {[['Approved — measured', approved], ['Proposed — not yet measured', proposed], ['Rejected', rejected]]
          .filter(([, rows]) => rows.length)
          .map(([heading, rows]) => (
            <div key={heading} style={{ marginBottom: 18 }}>
              <div
                className="eyebrow"
                style={{
                  fontSize: 9.5,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '.18em',
                  color: 'var(--text-3)',
                  marginBottom: 8,
                }}
              >
                {heading.toUpperCase()}
              </div>

              {rows.map((brand) => (
                <div
                  key={brand.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '10px 0',
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13.5, color: 'var(--text)', fontWeight: 600 }}>
                        {brand.name}
                      </span>
                      {brand.isClient && <Badge variant="info">client</Badge>}
                      <Badge variant={STATUS_VARIANT[brand.status] || 'neutral'}>{brand.status}</Badge>
                      {brand.domain && (
                        <span className="num" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                          {brand.domain}
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                      {(brand.aliases || []).map((a) => (
                        <span
                          key={a}
                          style={{
                            fontSize: 11,
                            fontFamily: 'var(--font-mono)',
                            padding: '1px 6px',
                            borderRadius: 'var(--r-sm)',
                            background: 'var(--surface)',
                            border: '1px solid var(--border)',
                            color: 'var(--text-2)',
                          }}
                        >
                          {a}
                        </span>
                      ))}
                      {!(brand.aliases || []).length && (
                        <span style={{ ...muted, color: 'var(--danger)' }}>
                          No aliases — this brand can never be matched.
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {brand.status !== 'approved' && (
                      <Button
                        size="sm"
                        onClick={() => setStatus(brand, 'approved')}
                        loading={busy === brand.id}
                        disabled={!(brand.aliases || []).length}
                      >
                        Approve
                      </Button>
                    )}
                    {brand.status === 'proposed' && (
                      <Button size="sm" variant="ghost" onClick={() => setStatus(brand, 'rejected')} loading={busy === brand.id}>
                        Reject
                      </Button>
                    )}
                    {brand.status === 'approved' && (
                      <Button size="sm" variant="ghost" onClick={() => setStatus(brand, 'proposed')} loading={busy === brand.id}>
                        Withdraw
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
      </Card>

      <div style={muted}>
        Approving a brand does not re-read anything already measured. Run extraction after
        changing this set, or existing captures keep the mention rows they were given.
      </div>
    </>
  );
}

export default BrandsPanel;
