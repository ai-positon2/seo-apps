const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { generateArticleBrief } = require('../services/articleBrief');

// In-memory session store (token → params, expires in 5 min)
const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// POST /init — store keyword + optional KB params, return token
router.post('/init', (req, res) => {
  const { keyword, client, feedbackKbIds } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'keyword is required' });

  const token = generateToken();
  sessions.set(token, { keyword: keyword.trim(), client: client || null, feedbackKbIds: feedbackKbIds || null });
  setTimeout(() => sessions.delete(token), 300000); // 5-min TTL
  res.json({ token });
});

// GET /stream/:token — SSE stream
router.get('/stream/:token', async (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired. Please try again.' });
  sessions.delete(req.params.token);

  const { keyword, client, feedbackKbIds } = session;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let isClosed = false;
  res.on('close', () => { isClosed = true; });

  const emit = (event, data) => {
    if (isClosed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) { isClosed = true; }
  };

  try {
    const result = await generateArticleBrief({ keyword, client, feedbackKbIds }, emit);
    emit('result', result);

  } catch (err) {
    console.error('[article-recommendation] Error:', err.message);
    emit('fail', { message: err.message });
  }

  emit('done', {});
  res.end();
});

module.exports = router;
