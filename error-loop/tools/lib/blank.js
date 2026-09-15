/**
 * Shared source blanker for the error-loop detectors.
 *
 * Replaces the bodies of comments, string literals, template literals AND
 * regex literals with spaces, preserving every byte offset and newline so line
 * numbers computed afterwards still refer to the real file.
 *
 * ── Why this exists as a shared module ──────────────────────────────────────
 * Each detector originally carried its own copy of a simpler blanker that knew
 * about comments and strings but not regex literals. That is wrong in a way
 * that fails SILENTLY and in the worst direction: a regex containing a quote,
 *
 *     .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
 *
 * is ordinary JavaScript, but a lexer that treats every `"` and `'` as a string
 * delimiter desynchronises at that point and mis-reads everything after it in
 * the file. The detector then reports FEWER findings, not more — it goes quiet
 * exactly where it should be loudest.
 *
 * This was found when an escaping helper added to
 * routes/agentReadinessAudit.js made async-route-guard's count drop from 1 to
 * 0. The handler had not changed; the lexer had gone blind.
 *
 * ── The regex-vs-division ambiguity ─────────────────────────────────────────
 * `/` can start a regex or be division, and telling them apart needs context.
 * The rule used here is the standard practical one: a `/` starts a regex when
 * the previous significant character cannot end an expression — i.e. it is one
 * of ( , = : [ ! & | ? { } ; + - * % ~ ^ < > or a newline or start-of-input, or
 * the previous token is a keyword such as return/typeof/case/in/of/do/else.
 * Otherwise it is division. This is a heuristic, but it is the same heuristic
 * every hand-written JS lexer uses, and it is strictly better than pretending
 * regex literals do not exist.
 */

const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

function prevSignificant(out, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(out[j])) j--;
  return j >= 0 ? { ch: out[j], idx: j } : { ch: '', idx: -1 };
}

function endsWithKeyword(src, idx) {
  let end = idx + 1;
  let start = end;
  while (start > 0 && /[A-Za-z_$]/.test(src[start - 1])) start--;
  const word = src.slice(start, end);
  return KEYWORDS_BEFORE_REGEX.has(word);
}

/**
 * @param {string} src
 * @returns {string} same length, same newlines, inert bodies
 */
function blank(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // Line comment
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }

    // Block comment
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }

    // Regex literal — decided by what precedes it.
    if (c === '/') {
      const { ch, idx } = prevSignificant(src, i);
      const startsRegex =
        idx === -1 ||
        '(,=:[!&|?{};+-*%~^<>\n'.includes(ch) ||
        (/[A-Za-z_$]/.test(ch) && endsWithKeyword(src, idx));
      if (startsRegex) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n) {
          const rc = src[j];
          if (rc === '\\') { j += 2; continue; }
          if (rc === '\n') break;            // unterminated — not a regex after all
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) { closed = true; break; }
          j++;
        }
        if (closed) {
          for (let k = i + 1; k < j; k++) if (out[k] !== '\n') out[k] = ' ';
          // flags
          let f = j + 1;
          while (f < n && /[a-z]/.test(src[f])) f++;
          i = f;
          continue;
        }
        // fall through: treat as division
      }
      i++;
      continue;
    }

    // String / template literal
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          if (src[i] !== '\n') out[i] = ' ';
          if (src[i + 1] !== '\n') out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      i++;
      continue;
    }

    i++;
  }

  return out.join('');
}

/**
 * Comments only — string and template bodies are LEFT INTACT.
 *
 * For detectors whose subject IS the string content: api-contract reads route
 * paths and BASE constants out of literals, so blanking them leaves it reading
 * empty quotes and reporting a confident zero. Still regex-aware, so a `//`
 * inside a regex literal cannot start a phantom comment.
 */
function blankComments(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '/') {
      const { ch, idx } = prevSignificant(src, i);
      const startsRegex =
        idx === -1 ||
        '(,=:[!&|?{};+-*%~^<>\n'.includes(ch) ||
        (/[A-Za-z_$]/.test(ch) && endsWithKeyword(src, idx));
      if (startsRegex) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n) {
          const rc = src[j];
          if (rc === '\\') { j += 2; continue; }
          if (rc === '\n') break;
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) { closed = true; break; }
          j++;
        }
        if (closed) { let f = j + 1; while (f < n && /[a-z]/.test(src[f])) f++; i = f; continue; }
      }
      i++;
      continue;
    }
    // Skip over string bodies without altering them, so a `//` inside a URL
    // literal is not mistaken for a comment.
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

module.exports = { blank, blankComments };
