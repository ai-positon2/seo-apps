// ── The assistant's calculator ──────────────────────────────────────────────
//
// The chat model is good at finding the right figures and bad at arithmetic:
// replaying a real conversation, it added 9.38 + 4.34 to 65.46, got 79.18, and
// rounded that to 80. So every sum goes through this instead, as a tool call.
//
// A small recursive-descent parser over numbers, + − × ÷, parentheses and a few
// named functions. It never evaluates code: anything outside that grammar is
// an error the model sees and can correct.

const FUNCTIONS = {
  round: (x, digits = 0) => {
    const f = 10 ** digits;
    // Half away from zero, as people round, after removing binary noise.
    return Math.sign(x) * Math.round(Math.abs(Number((x * f).toPrecision(12)))) / f;
  },
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  min: (...xs) => Math.min(...xs),
  max: (...xs) => Math.max(...xs),
  abs: (x) => Math.abs(x),
  sum: (...xs) => xs.reduce((s, x) => s + x, 0),
  avg: (...xs) => xs.reduce((s, x) => s + x, 0) / xs.length,
};

const MAX_LENGTH = 2000;

function tokenize(src) {
  const tokens = [];
  // No thousands separators: "sum(100,200)" must be two arguments, not 100200.
  const re = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+)|([a-z]+)|(\*\*|[-+*/×÷^(),%]))/giy;
  let m;
  let at = 0;
  while (at < src.length) {
    re.lastIndex = at;
    m = re.exec(src);
    if (!m) {
      if (/^\s+$/.test(src.slice(at))) break;
      throw new Error(`unexpected "${src.slice(at, at + 10)}"`);
    }
    at = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2].toLowerCase() });
    else tokens.push({ t: 'op', v: { '×': '*', '÷': '/', '^': '**' }[m[3]] || m[3] });
  }
  return tokens;
}

function evaluate(expression) {
  if (typeof expression !== 'string' || !expression.trim()) throw new Error('empty expression');
  if (expression.length > MAX_LENGTH) throw new Error('expression too long');
  const tokens = tokenize(expression);
  let i = 0;
  const peek = () => tokens[i];
  const take = (v) => {
    const tok = tokens[i];
    if (!tok || (v && tok.v !== v)) throw new Error(`expected "${v || 'a value'}"`);
    i += 1;
    return tok;
  };

  // expr := term (('+'|'-') term)*
  function expr() {
    let v = term();
    while (peek() && (peek().v === '+' || peek().v === '-')) {
      const op = take().v;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  // term := power (('*'|'/'|'%') power)*
  function term() {
    let v = power();
    while (peek() && ['*', '/', '%'].includes(peek().v)) {
      const op = take().v;
      const r = power();
      if (op === '/' && r === 0) throw new Error('division by zero');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  // power := unary ('**' power)?
  function power() {
    const v = unary();
    if (peek() && peek().v === '**') { take(); return v ** power(); }
    return v;
  }
  // unary := '-' unary | atom
  function unary() {
    if (peek() && peek().v === '-') { take(); return -unary(); }
    if (peek() && peek().v === '+') { take(); return unary(); }
    return atom();
  }
  // atom := number | '(' expr ')' | name '(' args ')'
  function atom() {
    const tok = peek();
    if (!tok) throw new Error('unexpected end');
    if (tok.t === 'num') { take(); return tok.v; }
    if (tok.v === '(') { take('('); const v = expr(); take(')'); return v; }
    if (tok.t === 'id') {
      const fn = FUNCTIONS[tok.v];
      if (!fn) throw new Error(`unknown function "${tok.v}"`);
      take();
      take('(');
      const args = [];
      if (peek() && peek().v !== ')') {
        args.push(expr());
        while (peek() && peek().v === ',') { take(); args.push(expr()); }
      }
      take(')');
      return fn(...args);
    }
    throw new Error(`unexpected "${tok.v}"`);
  }

  const value = expr();
  if (i !== tokens.length) throw new Error(`unexpected "${tokens[i].v}"`);
  if (!Number.isFinite(value)) throw new Error('result is not a finite number');
  // Strip binary noise (0.1 + 0.2) without hiding real precision.
  return Number(value.toPrecision(12));
}

/** The tool as chat-completions sees it. */
const CALCULATOR_TOOL = {
  type: 'function',
  function: {
    name: 'calculate',
    description: 'Evaluate arithmetic exactly. Use it for every calculation, including rounding. '
      + 'Supports plain numbers (write 1290, not 1,290), + - * / ( ), and round(x, digits), floor, ceil, min, max, abs, sum, avg. '
      + 'Pass several independent expressions at once in "expressions".',
    parameters: {
      type: 'object',
      properties: {
        expressions: {
          type: 'array',
          items: { type: 'string' },
          description: 'e.g. ["100 - (4.92 + 22.11 + 7.52)", "round(65.46 + 9.38 + 4.34)"]',
        },
      },
      required: ['expressions'],
      additionalProperties: false,
    },
  },
};

/** Runs one tool call's arguments; never throws — errors go back to the model. */
function runCalculator(argsJson) {
  let args;
  try { args = JSON.parse(argsJson || '{}'); } catch { return JSON.stringify({ error: 'arguments are not valid JSON' }); }
  const list = Array.isArray(args.expressions) ? args.expressions.slice(0, 30) : [args.expression].filter(Boolean);
  if (!list.length) return JSON.stringify({ error: 'no expressions given' });
  return JSON.stringify(list.map((e) => {
    try { return { expression: e, result: evaluate(String(e)) }; } catch (err) { return { expression: e, error: err.message }; }
  }));
}

module.exports = { evaluate, runCalculator, CALCULATOR_TOOL };
