import { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { useSeoGeoAudit } from '../hooks/useSeoGeoAudit';
import { asText } from '../components/seoGeo/primitives';
import AuditInputPanel from '../components/seoGeo/AuditInputPanel';
import SummaryView from '../components/seoGeo/report/SummaryView';
import DetailsView from '../components/seoGeo/report/DetailsView';
import { UnderlineTabs, Eyebrow } from '../components/seoGeo/report/reportKit';
import ModuleRuns from '../components/ModuleRuns';
import ProjectReportBar from '../components/project/ProjectReportBar';
import ReportResolving from '../components/project/ReportResolving';
import { useOnPageTab } from '../hooks/useOnPageTab';

// ── downloadReport (7 sheets) ─────────────────────────────────────────────────
function downloadReport(findings, ai) {
  const wb = XLSX.utils.book_new();

  const statusFill = (status) => {
    const fills = {
      pass:    { fgColor: { rgb: 'D1FAE5' } },
      fail:    { fgColor: { rgb: 'FEE2E2' } },
      warning: { fgColor: { rgb: 'FEF3C7' } },
      notice:  { fgColor: { rgb: 'DBEAFE' } },
      skipped: { fgColor: { rgb: 'F3F4F6' } },
      na:      { fgColor: { rgb: 'F3F4F6' } },
    };
    return fills[status] || fills.skipped;
  };

  // Sheet 1: Summary
  const summaryRows = [
    ['SEO & GEO Audit Report', ''],
    [''],
    ['Field', 'Value'],
    ['URL', findings.meta.url],
    ['Page Type', findings.meta.page_type || '—'],
    ['Page Intent', findings.meta.page_intent
      ? `${findings.meta.page_intent}${findings.meta.page_intent_source === 'detected' ? ' (auto)' : ''}`
      : '—'],
    ['Content Vertical', findings.meta.content_vertical || '—'],
    ['Is YMYL', findings.meta.is_ymyl ? 'Yes' : 'No'],
    ['Audit Date', new Date(findings.meta.fetch_timestamp).toLocaleString()],
    ['HTTP Status', findings.meta.http_status ?? '—'],
    ['HTML Size', `${Math.round(findings.meta.html_size_bytes / 1024)}KB`],
    ['Total Checks', findings.meta.total_checks_run],
    ['Errors', findings.meta.errors],
    ['Warnings', findings.meta.warnings],
    ['Notices', findings.meta.notices],
    ['Passed', findings.meta.passed],
    ['Keywords Audited', (findings.meta.keywords || []).join(', ') || '(none)'],
    [''],
    ['Scores', ''],
    ['Overall Score (after cap)', findings.scores.overall ?? '—'],
    ['Composite (uncapped)', findings.scores.composite ?? '—'],
    ['Band', findings.scores.band?.label ?? '—'],
    ['Cap Applied', findings.scores.cap?.applied
      ? `${findings.scores.cap.value} — ${(findings.scores.cap.groups || []).map(g => g.reason).join(' · ')}`
      : 'No'],
    ['Title & Meta', findings.scores.title_meta ?? '—'],
    ['Content & Structure', findings.scores.content_structure ?? '—'],
    ['Indexability', findings.scores.indexability ?? '—'],
    ['Schema', findings.scores.schema ?? '—'],
    ['GEO Signals', findings.scores.geo_signals ?? '—'],
    ['E-E-A-T', findings.scores.eeat ?? '—'],
    ['Technical & Performance', findings.scores.technical ?? '—'],
    ['Links & Media', findings.scores.links_media ?? '—'],
    ['Keyword Targeting', findings.scores.keyword ?? '—'],
    [''],
    ['AI Assessment', ''],
    ['GEO Readiness', ai?.summary?.geo_readiness ?? '—'],
    ['E-E-A-T Strength', ai?.summary?.eeat_strength ?? '—'],
    ['Priority Verdict', ai?.summary?.priority_verdict ?? '—'],
    [''],
    ['Quick Wins', ''],
    ...(ai?.summary?.quick_wins ?? []).map((w, i) => [`${i + 1}`, w]),
    [''],
    // Rule-based answerability (F28) — the rubric and its components switch with
    // page intent, so the rows are generated rather than hardcoded to C/S/Q/A/F.
    ['GEO Answerability', findings.geo?.answerability_score ?? findings.geo?.csqaf_score ?? '—'],
    ['Answerability Rubric', findings.geo?.answerability_rubric ?? '—'],
    ['Answerability Points', Number.isFinite(findings.geo?.answerability_earned) && Number.isFinite(findings.geo?.answerability_max)
      ? `${findings.geo.answerability_earned} of ${findings.geo.answerability_max}`
      : '—'],
    ...(findings.geo?.answerability_breakdown ?? []).map(c => [
      `${c.key} — ${c.label}`,
      `${c.points}/${c.max}${c.finding ? ` · ${c.finding}` : ''}`,
    ]),
  ];

  // Sheet 2: Keyword Analysis (only if keywords provided)
  const kwRows = [['ID', 'Check', 'Keyword', 'Status', 'Tier', 'Evidence', 'Found Value', 'Fix']];
  for (const c of findings.kwChecks || []) {
    kwRows.push([c.id, c.name, (findings.meta.keywords || []).join(', '), c.status,
      c.tier ?? '', c.evidence ?? '', c.value ?? '', c.detail ?? '']);
  }

  // Sheet 3: Issues (errors + warnings)
  const issueRowsMain = [['Category', 'ID', 'Severity', 'Issue', 'Current State', 'Impact', 'Context Note', 'Fix', 'Code Example', 'Effort', 'Priority']];
  for (const section of ai?.sections ?? []) {
    for (const issue of section.issues ?? []) {
      if (issue.severity === 'error' || issue.severity === 'warning') {
        issueRowsMain.push([
          section.category ?? '',
          issue.id ?? '',
          issue.severity ?? '',
          issue.issue ?? '',
          issue.current_state ?? '',
          issue.impact ?? '',
          issue.context_note ?? '',
          issue.fix ?? '',
          issue.code_example ?? '',
          issue.effort ?? '',
          issue.priority ?? '',
        ]);
      }
    }
  }

  // Sheet 4: Notices
  const noticeRows = [['Category', 'ID', 'Issue', 'Current State', 'Fix', 'Effort']];
  for (const section of ai?.sections ?? []) {
    for (const issue of section.issues ?? []) {
      if (issue.severity === 'notice') {
        noticeRows.push([section.category ?? '', issue.id ?? '', issue.issue ?? '', issue.current_state ?? '', issue.fix ?? '', issue.effort ?? '']);
      }
    }
  }

  // Sheet 5: All Checks
  const checkRows = [['ID', 'Category', 'Name', 'Status', 'Severity', 'Value', 'Detail']];
  for (const c of findings.checks ?? []) {
    checkRows.push([c.id, c.category, c.name, c.status, c.severity, c.value ?? '', c.detail ?? '']);
  }

  // Sheet 6: Schema Analysis
  const schemaRows = [['Schema Analysis', '']];
  schemaRows.push([''], ['Detected Schemas', '']);
  for (const s of ai?.schema_analysis?.detected ?? []) {
    schemaRows.push([asText(s.type), asText(s.status)]);
    schemaRows.push(['Fields Present', (s.fields_present || []).map(asText).join(', ')]);
    schemaRows.push(['Fields Missing', (s.fields_missing || []).map(asText).join(', ')]);
    for (const err of s.validation_errors || []) {
      schemaRows.push([`Error: ${asText(err && err.field)}`, asText(err && typeof err === 'object' ? err.error : err)]);
      if (err && err.fix) schemaRows.push(['Fix', asText(err.fix)]);
    }
    if (s.corrected_json_ld) schemaRows.push(['Corrected JSON-LD', asText(s.corrected_json_ld)]);
    schemaRows.push(['']);
  }
  schemaRows.push(['Recommended Schemas', '']);
  for (const r of ai?.schema_analysis?.recommended ?? []) {
    schemaRows.push([asText(r.type), r.relevant ? asText(r.priority) : 'NOT RELEVANT']);
    if (r.reason) schemaRows.push(['Reason', asText(r.reason)]);
    if (r.starter_template) schemaRows.push(['Starter Template', asText(r.starter_template)]);
    schemaRows.push(['']);
  }

  // Sheet 7: GEO & Content
  const pr = ai?.geo_analysis?.platform_readiness ?? {};
  const cr = ai?.content_recommendations ?? {};
  const isCommercial = findings.meta?.page_intent === 'commercial';
  const geoRows = [
    ['Platform Readiness', ''],
    ['Google AIO', pr.google_aio ?? '—'],
    ['ChatGPT', pr.chatgpt ?? '—'],
    ['Perplexity', pr.perplexity ?? '—'],
    ['Claude', pr.claude_ai ?? '—'],
    ['Gemini', pr.gemini ?? '—'],
    ['Copilot', pr.copilot ?? '—'],
    [''],
    ['Top GEO Fix', ai?.geo_analysis?.top_geo_fix ?? '—'],
    [''],
    ['Content Recommendations', ''],
    ['Rewrite Priority', cr.rewrite_priority ?? '—'],
    // Statistics / expert quotes are informational-intent only; entity completeness
    // and the direct-answer rewrite are their commercial-intent counterparts.
    ...(isCommercial ? [] : [
      ['Statistics to Add', cr.statistics_to_add ?? '—'],
      ['Expert Quote Guidance', cr.expert_quote_guidance ?? '—'],
    ]),
    ...(isCommercial ? [
      ['Entity Completeness Actions', cr.entity_completeness_actions ?? '—'],
      ['Direct Answer Rewrite', cr.direct_answer_rewrite ?? '—'],
    ] : []),
    ['FAQ Recommendations', cr.faq_recommendation ?? '—'],
    ['Word Count Verdict', cr.word_count_verdict ?? '—'],
  ];

  const wsCols = (rows) => {
    const maxLen = {};
    rows.forEach(row => row.forEach((cell, i) => {
      maxLen[i] = Math.min(80, Math.max(maxLen[i] ?? 10, String(cell ?? '').length + 2));
    }));
    return Object.values(maxLen).map(w => ({ wch: w }));
  };

  const ws1 = XLSX.utils.aoa_to_sheet(summaryRows);
  const ws2 = XLSX.utils.aoa_to_sheet(kwRows);
  const ws3 = XLSX.utils.aoa_to_sheet(issueRowsMain);
  const ws4 = XLSX.utils.aoa_to_sheet(noticeRows);
  const ws5 = XLSX.utils.aoa_to_sheet(checkRows);
  const ws6 = XLSX.utils.aoa_to_sheet(schemaRows);
  const ws7 = XLSX.utils.aoa_to_sheet(geoRows);

  [ws1, ws2, ws3, ws4, ws5, ws6, ws7].forEach((ws, idx) => {
    const rows = [summaryRows, kwRows, issueRowsMain, noticeRows, checkRows, schemaRows, geoRows][idx];
    ws['!cols'] = wsCols(rows);
  });

  // Color-code the status column in All Checks sheet (column D = index 3)
  for (let r = 1; r < checkRows.length; r++) {
    const status = checkRows[r][3];
    const cellRef = XLSX.utils.encode_cell({ r, c: 3 });
    if (ws5[cellRef]) {
      ws5[cellRef].s = {
        fill: statusFill(status),
        font: { color: { rgb: status === 'pass' ? '065F46' : status === 'fail' ? '991B1B' : status === 'warning' ? '92400E' : '1E40AF' } }
      };
    }
  }

  const sheetNames = ['Summary', 'Keyword Analysis', 'Errors & Warnings', 'Notices', 'All Checks', 'Schema Analysis', 'GEO & Content'];
  [ws1, ws2, ws3, ws4, ws5, ws6, ws7].forEach((ws, i) => XLSX.utils.book_append_sheet(wb, ws, sheetNames[i]));

  const domain = (() => { try { return new URL(findings.meta.url).hostname.replace(/^www\./, ''); } catch { return 'audit'; } })();
  const date = new Date().toISOString().slice(0, 10);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  saveAs(new Blob([buf], { type: 'application/octet-stream' }), `seo-geo-audit-${domain}-${date}.xlsx`);
}

// ── The SEO & GEO report ────────────────────────────────────────────────────
//
// Two views of one page audit: the answer, and the working-out.
//
// The report used to open on the working-out — a nine-bucket composition chart,
// a points-lost waterfall, an answerability rubric and a 250-row check table,
// four panels deep. Every number was right and none of them said what to do
// first. So the Summary view now leads with the score, the model's own priority
// verdict, whether each answer engine can currently cite the page, and the quick
// wins; the four panels the page has always had are one tab across.
//
// The page picker above both views is ProjectReportBar, unchanged: these three
// modules audit several of a client's pages per run and store a report each, so
// the report is always "this page, of these pages". A live ad-hoc audit of a
// single URL renders the same two views with the picker showing nothing to pick.

const VIEWS = [
  { id: 'summary', label: 'Summary' },
  { id: 'details', label: 'More Tech Details' },
];

export default function SeoGeoAuditPage() {
  // 'loading' until ProjectReportBar has worked out whether this client has a
  // stored report, then 'report' or 'none'. Starting at 'loading' is the point —
  // the input form used to render on mount and be replaced a moment later.
  const [reportState, setReportState] = useState('loading');
  const [view, setView] = useState('summary');

  // Inputs, the SSE run and run persistence live in the shared hook so the
  // Snapshot page provably sends the same request body and restores the same way.
  const ctl = useSeoGeoAudit('seo-geo-audit', {
    onRestored: () => setView('summary'),
    onResult: () => setView('summary'),
  });
  const { findings, ai } = ctl;

  // On-Page audit state is held here, not inside the panel that shows it: the
  // PSI run takes 30-60s and switching tabs mid-run would otherwise unmount the
  // poller and throw the work away.
  const auditedUrl = findings?.meta?.input_type === 'url' ? findings?.meta?.url : null;
  const onPage = useOnPageTab(auditedUrl);

  // The On-Page audit starts on its own as soon as a URL-based run lands, so the
  // panel is already populated (or filling) by the time anyone opens it. It stays
  // a separate job rather than part of the SSE run: PageSpeed Insights takes
  // 30-60s for mobile + desktop, and blocking the main result on it would triple
  // the wait for the scores people came for.
  useEffect(() => {
    if (auditedUrl) onPage.autoStart(findings?.meta?.keywords || []);
  }, [auditedUrl, onPage.autoStart, findings?.meta?.keywords]);

  // Clears the On-Page result explicitly rather than relying on the hook's
  // url-change effect, which would not fire when the next audit targets the same
  // URL.
  function handleNewAudit() {
    onPage.reset();
    ctl.reset();
    setView('summary');
  }

  const host = (() => {
    try { return new URL(findings?.meta?.url || '').hostname.replace(/^www\./, ''); } catch { return null; }
  })();
  const path = (() => {
    try { return new URL(findings?.meta?.url || '').pathname; } catch { return ''; }
  })();

  return (
    <main className="geo-report">
      {/* The stored project run, loaded into this page's own report. Same
          components and same data shape as a live run, so it IS that report —
          `reset` on it goes back to auditing an ad-hoc URL. */}
      <ProjectReportBar
        moduleKey="seo_geo"
        onOpenReport={(native) => ctl.hydrate(native)}
        onResolved={setReportState}
      />
      <style>{'@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>

      {/* Which screen: resolved first, drawn second. While the stored run is
          still being looked up this shows a skeleton rather than the input form —
          the form used to appear for a moment on every client that already had a
          report. */}
      {reportState === 'loading' && !findings && <ReportResolving maxWidth={672} />}

      {reportState !== 'loading' && !findings && (
        <div style={{ maxWidth: 672, margin: '0 auto' }}>
          <AuditInputPanel
            ctl={ctl}
            title="SEO & GEO Audit"
            subtitle="Run 200+ checks across all SEO and GEO parameters. Get a scored report with AI-powered recommendations."
            ctaLabel="Audit"
            ctaLabelHtml="Audit HTML"
          />
        </div>
      )}

      {findings && (
        <>
          {/* ── Which page this is ───────────────────────────────────────── */}
          <div
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
              gap: 20, flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 280 }}>
              <Eyebrow tone="accent">SEO &amp; GEO Audit</Eyebrow>
              <h1
                style={{
                  margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em',
                  color: 'var(--text)', lineHeight: 1.2, wordBreak: 'break-word',
                }}
              >
                {host ? <>{host}<span style={{ color: 'var(--text-3)' }}>{path}</span></> : 'Pasted HTML'}
              </h1>
              {/* What the audit actually looked at.
                  The meta bar that used to sit above the report carried fourteen
                  fields; the design has no slot for it and most of them are now
                  elsewhere on the page — page intent and the score in the four
                  figures under "More Tech Details", the check total in the
                  readiness hero. These four are the ones that were about to
                  vanish: what kind of page this is, what it was audited
                  against, whether the fetch even succeeded, and its size. */}
              <span style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
                {[
                  findings.meta?.page_type,
                  findings.meta?.is_ymyl ? 'YMYL' : null,
                  findings.meta?.keywords?.length
                    ? `keyword: ${findings.meta.keywords[0]}`
                    : null,
                  Number.isFinite(findings.meta?.http_status)
                    ? `HTTP ${findings.meta.http_status}`
                    : null,
                  Number.isFinite(findings.meta?.total_checks_run)
                    ? `${findings.meta.total_checks_run} checks run`
                    : null,
                ].filter(Boolean).join(' · ')}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {/* This workbook builder has existed, complete, with seven sheets,
                  and was never wired to anything. The design puts a Download
                  Excel button in the header, so here it is. */}
              <button
                type="button"
                onClick={() => downloadReport(findings, ai)}
                style={{
                  height: 38, padding: '0 16px', fontFamily: 'var(--font-sans)', fontSize: 13,
                  fontWeight: 500, color: 'var(--text)', background: 'transparent',
                  border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer',
                }}
              >
                Download Excel
              </button>
              <button
                type="button"
                onClick={handleNewAudit}
                style={{
                  height: 38, padding: '0 16px', fontFamily: 'var(--font-sans)', fontSize: 13,
                  fontWeight: 500, color: 'var(--primary-text)', background: 'transparent',
                  border: '1px solid var(--primary)', borderRadius: 8, cursor: 'pointer',
                }}
              >
                New audit
              </button>
            </div>
          </div>

          {/* Two-way, unlike the design's one-way "See the technical detail →".
              The prototype computes this strip and renders it; the button at the
              bottom of the Summary is the second route into the same place. */}
          <UnderlineTabs tabs={VIEWS} active={view} onSelect={setView} />

          {view === 'summary' && (
            <SummaryView findings={findings} ai={ai} onOpenDetails={() => setView('details')} />
          )}
          {view === 'details' && (
            <DetailsView findings={findings} ai={ai} onPage={onPage} auditedUrl={auditedUrl} />
          )}
        </>
      )}

      <ModuleRuns toolId="seo-geo-audit" />
      {/* On-Page runs surface here too. They used to be listed on the standalone
          /on-page-audit page, which was removed as a duplicate of the On-Page
          panel. The panel still starts real jobs through /api/on-page-audit and
          those are still tracked, so without this they would be recorded and
          never shown anywhere — which config/__tests__/moduleRuns.test.js exists
          to catch. */}
      <ModuleRuns toolId="on-page-audit" />
    </main>
  );
}
