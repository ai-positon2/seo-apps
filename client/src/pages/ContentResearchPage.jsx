import { useState } from 'react';
import KeywordInput from '../components/KeywordInput';
import ProgressSteps from '../components/ProgressSteps';
import SerpUrls from '../components/SerpUrls';
import ResultsTable from '../components/ResultsTable';
import ExportButtons from '../components/ExportButtons';
import KBContextSelector from '../components/KBContextSelector';
import ModuleRuns from '../components/ModuleRuns';

const CONFIDENCE_STYLES = {
  HIGH:   { bg: 'var(--success-soft)', text: 'var(--success)', label: 'KB: HIGH' },
  MEDIUM: { bg: 'var(--warning-soft)', text: 'var(--warning)', label: 'KB: MEDIUM' },
  LOW:    { bg: 'var(--danger-soft)',  text: 'var(--danger)',  label: 'KB: LOW' },
};

export default function ContentResearchPage() {
  const [keyword, setKeyword] = useState('');
  const [client, setClient] = useState('');
  const [feedbackKbIds, setFeedbackKbIds] = useState([]);
  const [step, setStep] = useState('idle');
  const [serpResults, setSerpResults] = useState(null);
  const [scrapeResults, setScrapeResults] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [kbConfidence, setKbConfidence] = useState(null);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState([]);
  const [searchCount, setSearchCount] = useState(0);

  const isLoading = ['searching', 'scraping', 'analyzing'].includes(step);

  async function handleResearch() {
    if (!keyword.trim() || isLoading) return;

    setStep('searching');
    setSerpResults(null);
    setScrapeResults(null);
    setAnalysis(null);
    setError('');
    setWarnings([]);

    try {
      const searchRes = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: keyword.trim() })
      });
      if (!searchRes.ok) throw new Error((await searchRes.json()).error || 'Google search failed.');
      const searchData = await searchRes.json();
      setSerpResults(searchData.results);
      setSearchCount(searchData.searchCount || 0);

      setStep('scraping');
      const scrapeRes = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: searchData.results.map(r => r.url) })
      });
      if (!scrapeRes.ok) throw new Error((await scrapeRes.json()).error || 'Scraping failed.');
      const scrapeData = await scrapeRes.json();
      setScrapeResults(scrapeData.results);

      const allWarnings = [...(scrapeData.warnings || [])];
      const failed = scrapeData.results.filter(r => !r.success);
      if (failed.length > 0 && !allWarnings.some(w => w.includes('scraped'))) {
        allWarnings.push(`${failed.length} page(s) could not be scraped and were skipped.`);
      }

      setStep('analyzing');
      const analyzeRes = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: keyword.trim(), scrapedPages: scrapeData.results, client: client || undefined, feedbackKbIds: feedbackKbIds.length ? feedbackKbIds : undefined })
      });
      if (!analyzeRes.ok) throw new Error((await analyzeRes.json()).error || 'Analysis failed.');
      const analyzeData = await analyzeRes.json();
      setAnalysis(analyzeData.analysis);
      setKbConfidence(analyzeData.kbConfidence || null);
      setWarnings(allWarnings);
      setStep('done');
    } catch (err) {
      setError(err.message);
      setStep('error');
    }
  }

  return (
    <main style={{ maxWidth: 1280, margin: '0 auto', padding: '28px 32px' }}>
      <KBContextSelector
        module="content-research"
        onChange={({ client: c, feedbackKbIds: fb }) => { setClient(c); setFeedbackKbIds(fb || []); }}
        disabled={isLoading}
      />

      <div style={{ marginTop: 16 }}>
        <KeywordInput keyword={keyword} setKeyword={setKeyword} onSearch={handleResearch} disabled={isLoading} />
      </div>

      {step !== 'idle' && (
        <div style={{ marginTop: 24 }}>
          <ProgressSteps step={step} />
        </div>
      )}

      {warnings.length > 0 && (
        <div style={{
          marginTop: 16,
          padding: '12px 16px',
          background: 'var(--warning-soft)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
        }}>
          <span style={{ color: 'var(--warning)', marginTop: 2, flexShrink: 0 }}>&#9888;</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {warnings.map((w, i) => (
              <p key={i} style={{ margin: 0, fontSize: 14, color: 'var(--warning)' }}>{w}</p>
            ))}
          </div>
        </div>
      )}

      {step === 'error' && error && (
        <div style={{
          marginTop: 16,
          padding: '12px 16px',
          background: 'var(--danger-soft)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
        }}>
          <span style={{ color: 'var(--danger)', marginTop: 2, fontSize: 12, flexShrink: 0 }}>&#10005;</span>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'var(--danger)' }}>{error}</p>
        </div>
      )}

      {serpResults && (
        <div style={{ marginTop: 24 }}>
          <SerpUrls results={serpResults} scrapeResults={scrapeResults} isLoading={step === 'scraping'} />
        </div>
      )}

      {analysis && (
        <div style={{ marginTop: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <ExportButtons keyword={keyword} analysis={analysis} />
            {kbConfidence && CONFIDENCE_STYLES[kbConfidence] && (
              <span style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                fontWeight: 600,
                padding: '3px 10px',
                borderRadius: 'var(--r-lg)',
                backgroundColor: CONFIDENCE_STYLES[kbConfidence].bg,
                color: CONFIDENCE_STYLES[kbConfidence].text,
              }}>
                {CONFIDENCE_STYLES[kbConfidence].label}
              </span>
            )}
          </div>
          <ResultsTable keyword={keyword} analysis={analysis} />
        </div>
      )}
      <ModuleRuns toolId="content-research" />
    </main>
  );
}
