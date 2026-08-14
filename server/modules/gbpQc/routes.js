const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const registry = require('./clientRegistry');
const qcEngine = require('./qcEngine');
const exporter = require('./exporter');

// In-memory bulk-generation session store (token -> job params), same
// init-token + SSE-stream pattern as server/routes/keywordResearch.js.
const bulkSessions = new Map();

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

const LABEL_OVERRIDES = {
  awareness_holiday: 'Awareness / Holiday',
  family_lifestyle: 'Family / Lifestyle',
};

function postTypes(g) {
  const tf = g.post_types || g.post_themes || {};
  const keys = Object.keys(tf);
  if (!keys.length) return ['General'];
  return keys.map((k) => LABEL_OVERRIDES[k] || k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
}

function stages(g) {
  const out = [
    { name: 'Base Content Check', key: 'base', description: 'Review base template content against brand guidelines' },
    { name: 'Expanded Content QC', key: 'expanded', description: 'Review location-specific content against approved base' },
  ];
  if (g.content_generation_supported) {
    out.push({ name: 'Location Content Generator', key: 'generate', description: 'Generate ready-to-post location-specific content' });
  }
  return out;
}

function displayLoc(loc, g) {
  if ((g.location_format_exceptions || []).includes(loc)) return loc;
  const fmt = g.brand_name_with_location_format || '[Location]';
  return fmt.replace('[Location]', loc);
}

function getGuidelines(clientId) {
  try {
    return registry.loadClient(clientId);
  } catch {
    return null;
  }
}

// ── Clients ──────────────────────────────────────────────────────────────────

router.get('/clients', (req, res) => {
  const out = registry.listClients().map((c) => {
    const g = registry.loadClient(c.id);
    return {
      id: c.id,
      name: c.name,
      post_types: postTypes(g),
      stages: stages(g),
      locations: (g.locations || []).map((l) => displayLoc(l, g)),
      has_generator: !!g.content_generation_supported,
    };
  });
  res.json(out);
});

// ── QC checks (synchronous — one OpenAI call each) ────────────────────────────

router.post('/qc/base', async (req, res) => {
  const { client_id, topic, content, post_type } = req.body;
  const g = getGuidelines(client_id);
  if (!g) return res.status(404).json({ error: `Client '${client_id}' not found` });
  if (!qcEngine.hasOpenAiKey()) return res.status(500).json({ error: 'OpenAI API key not configured on server.' });
  try {
    const result = await qcEngine.checkBaseContent(g, { topic, content, postType: post_type });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/qc/expanded', async (req, res) => {
  const { client_id, base_content, expanded_content, post_type, location } = req.body;
  const g = getGuidelines(client_id);
  if (!g) return res.status(404).json({ error: `Client '${client_id}' not found` });
  if (!qcEngine.hasOpenAiKey()) return res.status(500).json({ error: 'OpenAI API key not configured on server.' });
  try {
    const result = await qcEngine.checkExpandedContent(g, { baseContent: base_content, expandedContent: expanded_content, postType: post_type, location });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate', async (req, res) => {
  const { client_id, base_content, location, post_type } = req.body;
  const g = getGuidelines(client_id);
  if (!g) return res.status(404).json({ error: `Client '${client_id}' not found` });
  if (!qcEngine.hasOpenAiKey()) return res.status(500).json({ error: 'OpenAI API key not configured on server.' });
  try {
    const result = await qcEngine.generateLocationContent(g, { baseContent: base_content, location, postType: post_type });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk generation (all locations) — init-token + SSE stream ────────────────

router.post('/generate/all/init', (req, res) => {
  const { client_id, base_content, post_type } = req.body;
  const g = getGuidelines(client_id);
  if (!g) return res.status(404).json({ error: `Client '${client_id}' not found` });
  if (!qcEngine.hasOpenAiKey()) return res.status(500).json({ error: 'OpenAI API key not configured on server.' });

  const locations = (g.locations || []).map((l) => displayLoc(l, g));
  if (!locations.length) return res.status(400).json({ error: 'No locations configured for this client' });

  const token = generateToken();
  bulkSessions.set(token, { clientId: client_id, baseContent: base_content, postType: post_type, locations });
  setTimeout(() => bulkSessions.delete(token), 120000);
  res.json({ token, total: locations.length });
});

router.get('/generate/all/stream/:token', async (req, res) => {
  const session = bulkSessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired. Please try again.' });
  bulkSessions.delete(req.params.token);

  const { clientId, baseContent, postType, locations } = session;
  const g = getGuidelines(clientId);

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
    } catch {
      isClosed = true;
    }
  };

  // Sequential, one location at a time — mirrors the original tool exactly,
  // avoiding a burst of concurrent OpenAI calls.
  for (let i = 0; i < locations.length; i++) {
    if (isClosed) break;
    const loc = locations[i];
    let result;
    try {
      result = await qcEngine.generateLocationContent(g, { baseContent, location: loc, postType });
    } catch (err) {
      result = { full_post: '', character_count: 0, within_limit: false, sections_included: [], customization_notes: [`Generation failed: ${err.message}`] };
    }
    emit('progress', { location: loc, result, index: i + 1, total: locations.length });
  }
  emit('done', {});
  if (!isClosed) res.end();
});

// ── Excel export ───────────────────────────────────────────────────────────────

router.post('/export/qc', async (req, res) => {
  const { result, client_id, stage, client_name } = req.body;
  try {
    const buffer = await exporter.toQcExcel(result, client_id, stage, client_name);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${client_id}_${stage}_report.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/export/generated', async (req, res) => {
  const { result, client_id, location, client_name } = req.body;
  try {
    const buffer = await exporter.toGeneratedExcel(result, client_id, location, client_name);
    const safeLoc = String(location || '').replace(/[\s,]+/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${client_id}_generated_${safeLoc}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/export/all', async (req, res) => {
  const { results, client_id, post_type, client_name } = req.body;
  try {
    const buffer = await exporter.toAllLocationsExcel(results, client_id, post_type, client_name);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${client_id}_all_locations.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
