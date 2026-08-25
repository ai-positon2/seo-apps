// Audit workbook generation and storage.
//
// The workbook used to be rebuilt from scratch on every single download, inside the web
// process that also serves /healthz. For a large crawl that is a multi-second synchronous
// ExcelJS loop plus a large allocation spike on the request path — enough to risk the
// platform health check. So it is now built exactly once, by the worker, and persisted;
// downloads redirect to a short-lived signed URL instead of regenerating anything.

const { buildAuditWorkbook } = require("../report-writer");
const { createGate } = require("../shared/gate");
const { serviceClient } = require("../db/supabase");
const catalog = require("../issue-catalog.json");

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const BUCKET = process.env.REPORT_STORAGE_BUCKET || "reports";

// Serialize workbook builds even when several crawls finish together: the build is
// synchronous and memory-heavy, so overlapping builds multiply the peak rather than
// spreading it. Crawls themselves stay concurrent.
const withBuildGate = createGate(Number(process.env.REPORT_BUILD_CONCURRENCY) || 1);

function hostOf(url) {
  return String(url || "")
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .replace(/[^a-z0-9.-]+/gi, "-");
}

function reportFilename(url) {
  return `CrawlScope-${hostOf(url) || "website"}-SEO-Audit.xlsx`;
}

function reportObjectPath(run) {
  return `${run.owner}/${run.id}.xlsx`;
}

async function buildReportBuffer({ findings, siteUrl, crawlDate }) {
  return withBuildGate(async () => {
    const buffer = await buildAuditWorkbook({
      findings,
      catalog,
      siteUrl,
      crawlDate: crawlDate || new Date().toISOString(),
    });
    return Buffer.from(buffer);
  });
}

// Upload and return the object path, or null if storage is unavailable. A storage
// failure must never fail the run: the report is still emailed from the in-memory
// buffer, and the download route falls back to rebuilding.
async function storeReport(db, run, buffer) {
  const path = reportObjectPath(run);
  try {
    const { error } = await db.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: XLSX_MIME, upsert: true });
    if (error) throw new Error(error.message || String(error));
    return path;
  } catch (error) {
    console.error(`report upload failed for run ${run.id}:`, error.message);
    return null;
  }
}

async function signedReportUrl(db, path, expiresInSeconds = 300) {
  if (!path) return null;
  try {
    const { data, error } = await db.storage
      .from(BUCKET)
      .createSignedUrl(path, expiresInSeconds);
    if (error) throw new Error(error.message || String(error));
    return data?.signedUrl || null;
  } catch (error) {
    console.error(`signed URL failed for ${path}:`, error.message);
    return null;
  }
}

// Convenience wrapper for the download route. The bucket is private, so signing always
// requires the service role — a user-scoped anon client cannot read it. Keeping that
// knowledge here means callers don't have to pick the right client, and the client is
// resolved lazily so a process with no Supabase env can still serve routes that don't
// touch storage.
async function signedUrlForRun(run, expiresInSeconds = 300) {
  if (!run?.report_path) return null;
  return signedReportUrl(serviceClient(), run.report_path, expiresInSeconds);
}

module.exports = {
  BUCKET,
  XLSX_MIME,
  buildReportBuffer,
  storeReport,
  signedReportUrl,
  signedUrlForRun,
  reportFilename,
  reportObjectPath,
};
