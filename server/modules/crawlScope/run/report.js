// Audit workbook generation and storage.
//
// The workbook used to be rebuilt from scratch on every single download, inside the web
// process that also serves /healthz. For a large crawl that is a multi-second synchronous
// ExcelJS loop plus a large allocation spike on the request path — enough to risk the
// platform health check. So it is now built exactly once, by the worker, and persisted;
// downloads are served from that copy instead of regenerating anything.
//
// ── Where the workbook lives ────────────────────────────────────────────────
// This used to be a private Supabase Storage bucket, with downloads redirected
// to a short-lived signed URL. There is no object store behind the database any
// more, so a workbook is written to disk under the same APP_DATA_ROOT
// convention every other file-backed module here uses (services/dataRoot.js) —
// which means the same warning applies: on a container platform, set
// APP_DATA_ROOT (or REPORT_STORAGE_ROOT) to a MOUNTED VOLUME, or the directory
// is inside the image and every deploy silently empties it. Losing a stored
// workbook is not fatal — the download route rebuilds — but it gives back the
// slow path this file exists to avoid.
//
// `report_path` keeps its exact previous shape, "<owner>/<runId>.xlsx", so rows
// written before this change still resolve.

const fs = require("node:fs/promises");
const path = require("node:path");
const jwt = require("jsonwebtoken");

const { buildAuditWorkbook } = require("../report-writer");
const { createGate } = require("../shared/gate");
const { resolveDataRoot } = require("../../../services/dataRoot");
const catalog = require("../issue-catalog.json");

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Kept exported under its old name: the worker and the routes both refer to it,
// and it still names the place reports are kept.
const BUCKET = process.env.REPORT_STORAGE_BUCKET || "reports";

function storageRoot() {
  return resolveDataRoot(
    "crawlscope-reports",
    path.join(__dirname, "..", "data", BUCKET),
    "REPORT_STORAGE_ROOT",
  );
}

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

// Resolve a stored path to a real file, refusing anything that escapes the root.
// The value comes from our own `report_path` column rather than from a request,
// but it is about to be turned into a filesystem path, and a resolver that
// trusts its input is how that stops being true later.
function resolveStoredPath(stored) {
  const root = path.resolve(storageRoot());
  const full = path.resolve(root, String(stored || ""));
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`report path escapes the storage root: ${stored}`);
  }
  return full;
}

async function buildReportBuffer({ findings, siteUrl, crawlDate, coverage = null, ruleOrder = null }) {
  return withBuildGate(async () => {
    const buffer = await buildAuditWorkbook({
      findings,
      catalog,
      siteUrl,
      crawlDate: crawlDate || new Date().toISOString(),
      coverage,
      ruleOrder,
    });
    return Buffer.from(buffer);
  });
}

// Write and return the stored path, or null if storage is unavailable. A storage
// failure must never fail the run: the report is still emailed from the in-memory
// buffer, and the download route falls back to rebuilding.
//
// The first argument is unused now that this writes to disk; it is kept so the
// worker's call site (and any other caller) needs no change.
async function storeReport(_db, run, buffer) {
  const stored = reportObjectPath(run);
  try {
    const full = resolveStoredPath(stored);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    return stored;
  } catch (error) {
    console.error(`report write failed for run ${run.id}:`, error.message);
    return null;
  }
}

/** The stored workbook as a Buffer, or null when it is not on disk. */
async function readReport(stored) {
  if (!stored) return null;
  try {
    return await fs.readFile(resolveStoredPath(stored));
  } catch {
    // Missing is the expected case after a deploy onto an unmounted root, and
    // the caller's answer to it is to rebuild.
    return null;
  }
}

// ── Emailed download links ──────────────────────────────────────────────────
// The scheduled-report email carries a link that has to work from a mail client,
// with no session — which is what the Storage signed URL used to provide. The
// same property is reproduced with a short-lived signed token: it names ONE
// report path, expires, and is scoped by `purpose` so it can never be presented
// as a session cookie or accepted by any other route.
const REPORT_TOKEN_PURPOSE = "crawlscope.report";

function signReportToken(stored, expiresInSeconds) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return jwt.sign(
    { purpose: REPORT_TOKEN_PURPOSE, path: stored },
    secret,
    { expiresIn: Math.max(1, Math.floor(expiresInSeconds)) },
  );
}

/** Verifies a token and returns the report path it names, or null. */
function verifyReportToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret || !token) return null;
  try {
    const claims = jwt.verify(token, secret);
    if (claims?.purpose !== REPORT_TOKEN_PURPOSE || !claims.path) return null;
    return String(claims.path);
  } catch {
    return null;
  }
}

// An absolute, time-limited URL for a stored report, or null when one cannot be
// built. PUBLIC_BASE_URL is required because this goes in an email — a relative
// path is not clickable there. Without it the email simply carries no link,
// which is what it already did when storage was unavailable.
async function signedReportUrl(_db, stored, expiresInSeconds = 300) {
  if (!stored) return null;
  const base = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  const token = signReportToken(stored, expiresInSeconds);
  if (!token) return null;
  return `${base}/api/crawl-scope-report/${encodeURIComponent(token)}`;
}

// Convenience wrapper for the download route.
async function signedUrlForRun(run, expiresInSeconds = 300) {
  if (!run?.report_path) return null;
  return signedReportUrl(null, run.report_path, expiresInSeconds);
}

module.exports = {
  BUCKET,
  XLSX_MIME,
  storageRoot,
  buildReportBuffer,
  storeReport,
  readReport,
  signedReportUrl,
  signedUrlForRun,
  signReportToken,
  verifyReportToken,
  reportFilename,
  reportObjectPath,
  resolveStoredPath,
};
