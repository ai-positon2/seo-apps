// Standalone entry point for the module run worker.
//
// `MODULE_WORKER=external` in the web service, then run this as its own
// process. Headless Chrome is 150-300MB per page and blocks on network for
// 25-110 seconds at a time; sharing a dyno with request handling means a
// browser leak takes the API down with it.
//
// Claiming is a compare-and-swap, so more than one replica of this is safe.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { isSupabaseConfigured } = require('./services/supabase');
const moduleWorker = require('./services/moduleWorker');
const executors = require('./services/moduleExecutors');

if (!isSupabaseConfigured()) {
  console.error('[moduleWorker] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. Nothing to claim.');
  process.exit(1);
}

const handle = moduleWorker.startLoops({ executors });
console.log(`[moduleWorker] started as ${handle.workerId}`);

// Keep the process alive: the loops themselves are unref'd so they never hold
// it open on their own.
const keepAlive = setInterval(() => {}, 1 << 30);

function shutdown(signal) {
  console.log(`[moduleWorker] ${signal} — stopping.`);
  handle.stop();
  clearInterval(keepAlive);
  // A claimed run is left as-is: the reaper requeues it once its heartbeat
  // goes quiet, which is safer than this process trying to unwind mid-capture.
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
