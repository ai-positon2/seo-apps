import { Component } from 'react';

/* ── Surviving a deploy with the app already open ────────────────────────────
 *
 * Code-split routes are fetched on navigation, by hashed filename. A deploy
 * replaces those filenames, so a tab that loaded the old index.html asks for a
 * chunk that no longer exists — and this server answers that request badly.
 * express.static misses (server.js:220) and the SPA catch-all below it
 * (server.js:234) returns index.html with HTTP 200 and Content-Type text/html.
 * The browser was expecting a module, so it raises a MIME/parse error rather
 * than a 404, React.lazy's promise rejects, and with no boundary above it the
 * whole tree unmounts to a blank page. A reload fixes it; the person looking at
 * the blank page has no way to know that.
 *
 * That failure mode does not exist while the app ships as one chunk whose hash
 * always matches the index.html that referenced it. Code splitting introduces
 * it, so this boundary ships with it rather than after it.
 *
 * ── Why it rethrows almost everything ──────────────────────────────────────
 * Only a chunk that failed to load is handled here. Any other render error is
 * rethrown from render(), which propagates exactly as it does today with no
 * boundary present. That is deliberate: catching genuine app errors would turn
 * a crash into a silent blank area and change behaviour well beyond the deploy
 * case this exists for.
 *
 * ── Why a timestamp and not a boolean ──────────────────────────────────────
 * A "have I reloaded?" flag prevents a reload loop, but it also means the
 * SECOND deploy a tab survives never auto-recovers. A timestamp suppresses only
 * reloads that arrive within RELOAD_WINDOW_MS of the last one — which is the
 * actual signal for "reloading did not help, stop" — while leaving a genuine
 * staleness an hour later free to recover on its own.
 */

const RELOAD_KEY = 'chunk-reload-at';
const RELOAD_WINDOW_MS = 10_000;

// Chrome, Firefox and Safari each word this differently, and the MIME case
// above surfaces as a parse error naming the '<' that opens index.html.
const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|expected a JavaScript-or-Wasm module script|Unexpected token '<'|dynamically imported module/i;

function isChunkLoadError(error) {
  if (!error) return false;
  return CHUNK_ERROR.test(String(error.message || '')) || CHUNK_ERROR.test(String(error.name || ''));
}

// sessionStorage throws in a private window and when site data is blocked.
// Failing to read it must not be what stops the page from recovering, so a
// failed read reports "no recent reload" and a failed write is ignored.
function reloadedRecently() {
  try {
    const at = Number(window.sessionStorage.getItem(RELOAD_KEY) || 0);
    return Number.isFinite(at) && at > 0 && Date.now() - at < RELOAD_WINDOW_MS;
  } catch {
    return false;
  }
}

function markReloaded() {
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* storage unavailable — the reload still happens, it just is not recorded */
  }
}

export default class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    if (!isChunkLoadError(error)) return;
    if (reloadedRecently()) {
      // Reloading already failed once. Something other than a stale chunk is
      // wrong — offline, a blocked request, a genuinely missing asset — and
      // reloading again would spin. Hold on the fallback instead.
      console.error('[ChunkErrorBoundary] chunk still unavailable after a reload:', error);
      return;
    }
    markReloaded();
    window.location.reload();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // Not ours. Rethrow so behaviour matches a tree with no boundary at all.
    if (!isChunkLoadError(error)) throw error;

    // A chunk error: componentDidCatch has either triggered a reload that is
    // about to replace this document, or decided not to. Either way, hold the
    // same near-empty shape the Suspense fallback uses rather than flashing
    // an error card on the way out.
    const Fallback = this.props.fallback;
    if (Fallback) return <Fallback />;
    return <div style={{ minHeight: '60vh' }} aria-busy="true" />;
  }
}
