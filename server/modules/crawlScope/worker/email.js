// Scheduled-report email via Resend: an HTML summary (issue counts by severity,
// run-over-run deltas, top issues) with the full .xlsx audit attached, plus a plain
// failure notice when a scheduled crawl could not complete.

const { Resend } = require("resend");
const { buildReportBuffer, reportFilename } = require("../run/report");

// Providers cap total message size (Resend's documented limit is 40 MB), and base64
// inflates the payload by a third. Rather than letting an oversize attachment fail the
// send outright with no fallback, anything above this is delivered as a download link.
const MAX_ATTACH_BYTES =
  (Number(process.env.REPORT_MAX_ATTACH_MB) || 15) * 1024 * 1024;

const SEVERITY_ORDER = ["error", "warning", "notice", "info"];
const SEVERITY_LABEL = { error: "Errors", warning: "Warnings", notice: "Notices", info: "Info" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

function delta(current, previous) {
  if (previous === undefined || previous === null) return "";
  const diff = current - previous;
  if (diff === 0) return " (no change)";
  return diff > 0 ? ` (▲ +${diff})` : ` (▼ ${diff})`;
}

// The run's report page in the web app (client/src/App.jsx). The emails used to
// link to "/?run=<id>", a query parameter from an earlier, router-less client
// that nothing reads any more, so the link opened the home page.
function runReportLink(baseUrl, runId) {
  if (!baseUrl) return "";
  return `${String(baseUrl).replace(/\/+$/, "")}/crawl-scope/runs/${encodeURIComponent(runId)}`;
}

function topIssues(findings, limit = 8) {
  const map = new Map();
  for (const f of findings) {
    const cur =
      map.get(f.ruleId) ||
      { title: f.title, severity: f.severity, recommendation: f.recommendation, count: 0 };
    cur.count += 1;
    map.set(f.ruleId, cur);
  }
  const rank = { error: 0, warning: 1, notice: 2, info: 3 };
  return [...map.values()]
    .sort((a, b) => (rank[a.severity] - rank[b.severity]) || b.count - a.count)
    .slice(0, limit);
}

function buildHtml({ run, counts, previousCounts, findings, baseUrl, downloadUrl, attached = true }) {
  const rows = SEVERITY_ORDER.map((sev) => {
    const c = counts[sev] || 0;
    return `<tr><td style="padding:4px 12px;">${SEVERITY_LABEL[sev]}</td>
      <td style="padding:4px 12px;text-align:right;font-weight:600;">${c}${esc(
        delta(c, previousCounts?.[sev]),
      )}</td></tr>`;
  }).join("");

  const issues = topIssues(findings)
    .map(
      (i) => `<li style="margin-bottom:10px;">
          <strong>${esc(i.title)}</strong> — ${esc(i.severity)} · ${i.count} page(s)
          ${
            i.recommendation
              ? `<br><span style="color:#5a6a7a;font-size:13px;">${esc(i.recommendation)}</span>`
              : ""
          }
        </li>`,
    )
    .join("");

  const link = runReportLink(baseUrl, run.id);

  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2733;max-width:640px;">
    <h2 style="margin:0 0 4px;">CrawlScope audit — ${esc(run.url)}</h2>
    <p style="color:#5a6a7a;margin:0 0 16px;">Completed ${esc(run.finished_at || "")}</p>
    <table style="border-collapse:collapse;border:1px solid #e2e8f0;margin-bottom:16px;">
      <thead><tr><th style="text-align:left;padding:4px 12px;background:#f5f7fb;">Severity</th>
      <th style="text-align:right;padding:4px 12px;background:#f5f7fb;">Count</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h3 style="margin:0 0 8px;">Top issues</h3>
    <ul style="margin:0 0 16px;padding-left:20px;">${issues || "<li>No issues detected.</li>"}</ul>
    ${link ? `<p><a href="${esc(link)}">Open full report</a></p>` : ""}
    ${
      attached
        ? `<p style="color:#8a97a6;font-size:12px;">The complete audit is attached as an Excel workbook.</p>`
        : `<p style="color:#8a97a6;font-size:12px;">The audit workbook was too large to attach.${
            downloadUrl
              ? ` <a href="${esc(downloadUrl)}">Download the Excel workbook</a> (link expires shortly).`
              : " Open the full report to download it."
          }</p>`
    }
  </div>`;
}

function buildFailureHtml({ run, projectName, message, baseUrl }) {
  const link = runReportLink(baseUrl, run.id);
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2733;max-width:640px;">
    <h2 style="margin:0 0 4px;">CrawlScope crawl failed — ${esc(projectName || run.url)}</h2>
    <p style="color:#5a6a7a;margin:0 0 16px;">The scheduled audit for ${esc(run.url)} could not be completed.</p>
    <table style="border-collapse:collapse;border:1px solid #e2e8f0;margin-bottom:16px;">
      <tbody>
        <tr><td style="padding:4px 12px;background:#f5f7fb;">Reason</td>
            <td style="padding:4px 12px;">${esc(message)}</td></tr>
        <tr><td style="padding:4px 12px;background:#f5f7fb;">Attempts</td>
            <td style="padding:4px 12px;">${esc(run.attempts ?? 0)}</td></tr>
      </tbody>
    </table>
    <p style="color:#5a6a7a;">The next scheduled crawl will run as normal. No action is required unless this repeats.</p>
    ${link ? `<p><a href="${esc(link)}">Open the run in CrawlScope</a></p>` : ""}
  </div>`;
}

// One send per recipient rather than one send with every address in `to:`. Recipients
// of different projects are different clients, and a shared `to:` line discloses each
// client's address to the others. Counts here are tiny, so sequential is fine.
async function sendToEach(resend, recipients, message) {
  const sent = [];
  const failed = [];
  for (const recipient of recipients) {
    try {
      // Resend resolves with { data, error } and does NOT throw on an API error, so a
      // resolved promise is not evidence of delivery. Without this check an invalid API
      // key or an unverified EMAIL_FROM domain — the two most common misconfigurations —
      // would report every audit as delivered while nobody received anything.
      const { error } = (await resend.emails.send({ ...message, to: [recipient] })) || {};
      if (error) throw new Error(error.message || JSON.stringify(error));
      sent.push(recipient);
    } catch (error) {
      console.error(`email to ${recipient} failed:`, error.message);
      failed.push({ recipient, message: error.message });
    }
  }
  return { sent, failed };
}

// `workbook` lets the caller pass a buffer it already built (the worker builds it once
// for both the attachment and the stored copy). Falls back to building here so the
// function stays usable on its own.
async function sendReportEmail({
  run,
  counts,
  previousCounts,
  findings,
  recipients,
  workbook = null,
  downloadUrl = null,
  transport = null,
}) {
  if (!recipients?.length) return { skipped: "no recipients" };
  if (!process.env.RESEND_API_KEY) return { skipped: "RESEND_API_KEY not set" };

  // `transport` is a seam for tests; production always gets a real Resend client.
  const resend = transport || new Resend(process.env.RESEND_API_KEY);
  const from = process.env.EMAIL_FROM || "CrawlScope <onboarding@resend.dev>";
  const baseUrl = process.env.PUBLIC_BASE_URL || "";

  const xlsx =
    workbook ||
    (await buildReportBuffer({
      findings,
      siteUrl: run.url,
      crawlDate: run.finished_at,
      coverage: run.summary?.coverage || null,
    }));

  const host = String(run.url).replace(/^https?:\/\//i, "").split("/")[0];
  const attach = xlsx.length <= MAX_ATTACH_BYTES;
  if (!attach) {
    console.warn(
      `run ${run.id}: workbook ${xlsx.length} bytes exceeds REPORT_MAX_ATTACH_MB; sending a link instead`,
    );
  }

  return sendToEach(resend, recipients, {
    from,
    subject: `CrawlScope audit: ${host} — ${counts.error || 0} errors, ${counts.warning || 0} warnings`,
    html: buildHtml({
      run,
      counts,
      previousCounts,
      findings,
      baseUrl,
      downloadUrl,
      attached: attach,
    }),
    attachments: attach
      ? [{ filename: reportFilename(run.url), content: xlsx.toString("base64") }]
      : undefined,
  });
}

// Sent when a scheduled crawl could not complete. No attachment and no workbook build —
// there is nothing to report on, and the point is to notify quickly.
async function sendFailureEmail({ run, projectName, message, recipients, transport = null }) {
  if (!recipients?.length) return { skipped: "no recipients" };
  if (!process.env.RESEND_API_KEY) return { skipped: "RESEND_API_KEY not set" };

  const resend = transport || new Resend(process.env.RESEND_API_KEY);
  const from = process.env.EMAIL_FROM || "CrawlScope <onboarding@resend.dev>";
  const baseUrl = process.env.PUBLIC_BASE_URL || "";
  const host = String(run.url).replace(/^https?:\/\//i, "").split("/")[0];

  return sendToEach(resend, recipients, {
    from,
    subject: `CrawlScope audit failed: ${host}`,
    html: buildFailureHtml({ run, projectName, message, baseUrl }),
  });
}

module.exports = {
  sendReportEmail,
  sendFailureEmail,
  buildHtml,
  buildFailureHtml,
  topIssues,
};
