import { useState, useRef, useEffect, useCallback } from 'react';
import { startAudit, pollStatus, getResult } from '../lib/onPageAuditApi';

const POLL_MS = 3500;

// Drives the On-Page SEO Audit from inside the SEO & GEO Audit's own tab.
//
// Deliberately lazy: it does NOT run with the main audit. The On-Page module calls
// PageSpeed Insights for both mobile and desktop, which takes 30-60s and consumes PSI
// quota, while the SEO & GEO run finishes in ~10s. Firing it automatically would triple
// every audit's wall-clock and spend quota on users who never open the tab.
//
// State lives here rather than in the panel so switching tabs mid-run does not unmount the
// poller and lose a minute of work.
export function useOnPageTab(url) {
  const [status, setStatus] = useState('idle'); // idle | running | done | error
  const [progress, setProgress] = useState('');
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState('');
  const [keywordsUsed, setKeywordsUsed] = useState([]);
  const timer = useRef(null);
  const cancelled = useRef(false);
  const runForUrl = useRef(null);
  const autoStarted = useRef(null);

  const stop = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  // A new SEO & GEO run against a different URL invalidates any result held here.
  useEffect(() => {
    if (runForUrl.current && runForUrl.current !== url) {
      stop();
      setStatus('idle'); setProgress(''); setAudit(null); setError('');
      runForUrl.current = null;
      autoStarted.current = null;
    }
    if (!url) autoStarted.current = null;
  }, [url, stop]);

  useEffect(() => () => { cancelled.current = true; stop(); }, [stop]);

  // Keywords are optional: the server marks the ~6 keyword-placement checks `na` when none
  // are supplied and still runs everything else, so the audit is useful without them.
  const run = useCallback(async (keywords) => {
    if (!url) { setError('No URL available for this audit.'); setStatus('error'); return; }
    const kws = (keywords || []).map(k => String(k).trim()).filter(Boolean);
    cancelled.current = false;
    runForUrl.current = url;
    setKeywordsUsed(kws);
    setStatus('running'); setError(''); setAudit(null); setProgress('Starting…');

    try {
      const { jobId } = await startAudit(url, kws);
      const tick = async () => {
        if (cancelled.current) return;
        try {
          const job = await pollStatus(jobId);
          if (cancelled.current) return;
          setProgress(job.progress || '');
          if (job.status === 'complete' && job.auditId) {
            const result = await getResult(job.auditId);
            if (cancelled.current) return;
            setAudit(result);
            setStatus('done');
            // The auditor records a non-fatal errorMessage (e.g. PSI unavailable) while still
            // returning a usable report, so surface it without discarding the result.
            if (job.error) setError(job.error);
            return;
          }
          if (job.status === 'failed') {
            setError(job.error || 'The On-Page audit failed.');
            setStatus('error');
            return;
          }
          timer.current = setTimeout(tick, POLL_MS);
        } catch (e) {
          if (cancelled.current) return;
          setError(e.message || 'Lost contact with the audit job.');
          setStatus('error');
        }
      };
      timer.current = setTimeout(tick, POLL_MS);
    } catch (e) {
      setError(e.message || 'Could not start the On-Page audit.');
      setStatus('error');
    }
  }, [url]);

  const reset = useCallback(() => {
    stop();
    setStatus('idle'); setProgress(''); setAudit(null); setError('');
    setKeywordsUsed([]);
    // Cleared so a re-run of the same URL can auto-start again.
    autoStarted.current = null;
  }, [stop]);

  // Fires once per audited URL, as soon as the SEO & GEO run produces one. Guarded on a ref
  // keyed to the URL so a re-render, a tab switch, or React's double-invoked effects in dev
  // cannot launch a second PSI job for the same page.
  const autoStart = useCallback((keywords) => {
    if (!url || autoStarted.current === url) return;
    autoStarted.current = url;
    run(keywords);
  }, [url, run]);

  return { status, progress, audit, error, keywordsUsed, run, reset, autoStart };
}
