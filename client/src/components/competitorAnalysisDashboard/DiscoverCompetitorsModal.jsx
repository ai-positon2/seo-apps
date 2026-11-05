import { useEffect, useState } from 'react';
import { Modal } from '../../ui/Modal';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { ct } from '../../lib/competitorTrackerApi';
import { fmtNum } from './utils';

const TYPE_BADGE_VARIANT = {
  direct: 'danger',
  indirect: 'warning',
  aggregator: 'info',
  informational: 'neutral',
};

function CandidateCard({ candidate, onRemove }) {
  return (
    <Card padding="14px 16px">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{candidate.domain}</span>
            {candidate.verified === false
              ? <Badge variant="warning">not verified</Badge>
              : candidate.competitorType && <Badge variant={TYPE_BADGE_VARIANT[candidate.competitorType] || 'neutral'}>{candidate.competitorType}</Badge>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, color: 'var(--text-2)', marginBottom: candidate.reason ? 8 : 0 }}>
            {candidate.authorityScore > 0 && <span>Authority <strong>{candidate.authorityScore}</strong></span>}
            {candidate.organicTraffic > 0 && <span>Traffic <strong>{fmtNum(candidate.organicTraffic)}</strong></span>}
            {candidate.organicKeywords > 0 && <span>Keywords <strong>{fmtNum(candidate.organicKeywords)}</strong></span>}
            {candidate.competitionLevel > 0 && <span>Competition <strong>{Math.round(candidate.competitionLevel * 100)}%</strong></span>}
          </div>
          {candidate.reason && (
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', fontStyle: 'italic' }}>&ldquo;{candidate.reason}&rdquo;</div>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onRemove}>Remove</Button>
      </div>
    </Card>
  );
}

export default function DiscoverCompetitorsModal({ open, onClose, client, maxSuggest, onConfirmed }) {
  const toast = useToast();
  const [step, setStep] = useState('intro'); // 'intro' | 'review'
  const [limit, setLimit] = useState(3);
  const [discovering, setDiscovering] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [gptSummary, setGptSummary] = useState('');
  const [manualDomain, setManualDomain] = useState('');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep('intro');
    setLimit(Math.min(3, maxSuggest || 3));
    setCandidates([]);
    setGptSummary('');
    setManualDomain('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client?.id]);

  async function handleDiscover() {
    if (!client || discovering) return;
    setDiscovering(true);
    try {
      const result = await ct.discoverCompetitors(client.id, { limit });
      setCandidates(result.candidates.map((c) => ({ ...c, _key: c.domain })));
      setGptSummary(result.gptSummary || '');
      setStep('review');
    } catch (e) {
      toast.add({ title: 'Could not discover competitors', description: e.message, variant: 'danger' });
    } finally {
      setDiscovering(false);
    }
  }

  function handleRemove(key) {
    setCandidates((prev) => prev.filter((c) => c._key !== key));
  }

  function handleAddManual() {
    const domain = manualDomain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!domain) return;
    if (candidates.length >= (maxSuggest || 4)) return;
    setCandidates((prev) => [...prev, {
      _key: `manual:${domain}`,
      domain,
      competitorType: 'direct',
      reason: 'Manually added by analyst.',
      authorityScore: 0,
      organicTraffic: 0,
      organicKeywords: 0,
      competitionLevel: 0,
    }]);
    setManualDomain('');
  }

  async function handleConfirm() {
    if (!client || !candidates.length || confirming) return;
    setConfirming(true);
    const succeeded = [];
    const failed = [];
    for (const c of candidates) {
      try {
        await ct.addCompetitor(client.id, { domain: c.domain, label: c.domain });
        succeeded.push(c.domain);
      } catch (e) {
        failed.push({ domain: c.domain, error: e.message });
      }
    }
    setConfirming(false);
    if (succeeded.length) {
      toast.add({
        title: `Added ${succeeded.length} competitor${succeeded.length === 1 ? '' : 's'}`,
        description: failed.length ? `${failed.length} failed: ${failed.map((f) => f.domain).join(', ')}` : undefined,
        variant: failed.length ? 'warning' : 'success',
      });
    } else if (failed.length) {
      toast.add({ title: 'Could not add competitors', description: failed.map((f) => f.error).join('; '), variant: 'danger' });
    }
    onConfirmed?.();
    onClose?.();
  }

  const atLimit = candidates.length >= (maxSuggest || 4);

  return (
    <Modal open={open} onClose={onClose} title="Find Competitors For Me" size="lg">
      {step === 'intro' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ fontSize: 13.5, color: 'var(--text-2)', margin: 0, lineHeight: 1.6 }}>
            SEMrush finds domains that organically compete with <strong>{client?.domain}</strong> on real search
            rankings, then AI filters that list down to genuine business competitors — same market, same customer
            segment, similar primary offerings — and writes a one-sentence reason for each.
          </p>
          <div style={{ maxWidth: 200 }}>
            <Field
              as="select"
              label="How many to suggest"
              value={String(limit)}
              onChange={(e) => setLimit(parseInt(e.target.value, 10))}
            >
              {Array.from({ length: maxSuggest || 3 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </Field>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {gptSummary && (
            <div style={{ background: 'var(--info-soft)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '12px 16px', fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
              {gptSummary}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {candidates.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-3)', textAlign: 'center', padding: '20px 0' }}>
                No candidates left — add one manually below, or cancel and try again.
              </div>
            )}
            {candidates.map((c) => (
              <CandidateCard key={c._key} candidate={c} onRemove={() => handleRemove(c._key)} />
            ))}
          </div>

          {!atLimit && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <Field
                  label="Add another domain"
                  value={manualDomain}
                  onChange={(e) => setManualDomain(e.target.value)}
                  placeholder="competitor.com"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddManual(); } }}
                />
              </div>
              <Button variant="secondary" onClick={handleAddManual}>Add</Button>
            </div>
          )}
        </div>
      )}

      {step === 'intro' ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleDiscover} loading={discovering}>
            {discovering ? 'Discovering…' : 'Discover Competitors'}
          </Button>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm} loading={confirming} disabled={!candidates.length}>
            {confirming ? 'Adding…' : `Add ${candidates.length} Competitor${candidates.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      )}
    </Modal>
  );
}
