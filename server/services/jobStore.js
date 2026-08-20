const EventEmitter = require('events');

const jobs = new Map();

// Auto-cleanup jobs older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

function create(id, data) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  jobs.set(id, { ...data, emitter, events: [], createdAt: Date.now() });
}

function get(id) {
  return jobs.get(id) || null;
}

function update(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  const next = { ...job, ...patch };
  jobs.set(id, next);
  settleRun(next, patch);
}

// ── Run tracking ─────────────────────────────────────────────────────────────
// The competitor report pipeline answers its HTTP request ("status: running")
// long before the analysis finishes, so the route attaches its tracked run to
// the job (`run`, see server/config/runTracking.js) and the row is closed here
// — when the job actually reaches a terminal status.
function settleRun(job, patch) {
  if (!job.run || job.runSettled) return;
  if (patch.status !== 'done' && patch.status !== 'error') return;

  job.runSettled = true;
  const label = [job.brandName, job.clientDomain].filter(Boolean).join(' · ') || null;

  if (patch.status === 'error') {
    job.run.fail(job.errorMessage || 'Analysis failed.', { label });
    return;
  }
  job.run.finish({
    label,
    output: {
      brandName: job.brandName || null,
      clientDomain: job.clientDomain || null,
      country: job.country || null,
      competitors: Array.isArray(job.competitors) ? job.competitors.length : null,
      sections: job.reportData ? Object.keys(job.reportData) : null,
    },
  });
}

function emit(id, event) {
  const job = jobs.get(id);
  if (!job) return;
  job.events.push(event);
  job.emitter.emit('event', event);
}

function remove(id) {
  jobs.delete(id);
}

module.exports = { create, get, update, emit, remove };
