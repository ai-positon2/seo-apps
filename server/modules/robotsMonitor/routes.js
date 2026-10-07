const express = require('express');
const monitorStore = require('./monitorStore');
const { runMonitorCheck, getStatus } = require('./monitorRunner');
const { reinitScheduler } = require('./monitorScheduler');
const { sendTestMessage } = require('./slackNotifier');

const router = express.Router();

// ── Validation helpers ────────────────────────────────────────────────────────

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function urlHasSubfolderPath(str) {
  try {
    const u = new URL(str);
    return u.pathname.replace(/\/$/, '').length > 0;
  } catch {
    return false;
  }
}

function isValidScheduleTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

// ── Clients ───────────────────────────────────────────────────────────────────

router.get('/clients', async (req, res) => {
  try {
    res.json(await monitorStore.getClients());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clients', async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    res.status(201).json(await monitorStore.addClient({ name: name.trim() }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/clients/:clientId', async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    res.json(await monitorStore.updateClient(req.params.clientId, { name: name.trim() }));
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

router.delete('/clients/:clientId', async (req, res) => {
  try {
    await monitorStore.deleteClient(req.params.clientId);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// ── Domains ───────────────────────────────────────────────────────────────────

router.post('/clients/:clientId/domains', async (req, res) => {
  const { url, env, auth } = req.body || {};

  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'Valid url is required' });
  if (urlHasSubfolderPath(url)) return res.status(400).json({ error: 'Subfolders are not supported — use the subdomain only (e.g., staging.example.com)' });
  if (!['production', 'staging'].includes(env)) return res.status(400).json({ error: 'env must be "production" or "staging"' });
  if (auth) {
    if (!auth.username || !auth.username.trim() || !auth.password || !auth.password.trim()) {
      return res.status(400).json({ error: 'auth.username and auth.password must be non-empty strings' });
    }
  }

  try {
    const domain = await monitorStore.addDomain(req.params.clientId, {
      url: url.replace(/\/$/, ''),
      env,
      auth: auth ? { username: auth.username.trim(), password: auth.password } : null,
    });
    res.status(201).json(domain);
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

router.patch('/clients/:clientId/domains/:domainId', async (req, res) => {
  const { url, env, auth, enabled } = req.body || {};
  const fields = {};

  if (url !== undefined) {
    if (!isValidUrl(url)) return res.status(400).json({ error: 'Valid url is required' });
    if (urlHasSubfolderPath(url)) return res.status(400).json({ error: 'Subfolders are not supported — use the subdomain only' });
    fields.url = url.replace(/\/$/, '');
  }
  if (env !== undefined) {
    if (!['production', 'staging'].includes(env)) return res.status(400).json({ error: 'env must be "production" or "staging"' });
    fields.env = env;
  }
  if (auth !== undefined) {
    if (auth && (!auth.username || !auth.password)) {
      return res.status(400).json({ error: 'auth.username and auth.password must be non-empty' });
    }
    fields.auth = auth || null;
  }
  if (enabled !== undefined) fields.enabled = Boolean(enabled);

  try {
    res.json(await monitorStore.updateDomain(req.params.clientId, req.params.domainId, fields));
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

router.delete('/clients/:clientId/domains/:domainId', async (req, res) => {
  try {
    await monitorStore.deleteDomain(req.params.clientId, req.params.domainId);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// ── Slack config ──────────────────────────────────────────────────────────────

router.get('/slack-config', async (req, res) => {
  try {
    const config = await monitorStore.getSlackConfig();
    // Mask webhook URL — show only last 10 chars
    const masked = config.webhookUrl
      ? '*'.repeat(Math.max(0, config.webhookUrl.length - 10)) + config.webhookUrl.slice(-10)
      : '';
    res.json({ ...config, webhookUrl: masked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/slack-config', async (req, res) => {
  const { webhookUrl, channel, timezone, scheduleTime, enabled } = req.body || {};

  if (webhookUrl && !webhookUrl.startsWith('https://hooks.slack.com/')) {
    return res.status(400).json({ error: 'webhookUrl must start with https://hooks.slack.com/' });
  }
  if (scheduleTime && !isValidScheduleTime(scheduleTime)) {
    return res.status(400).json({ error: 'scheduleTime must be HH:MM (24-hour)' });
  }

  try {
    const existing = await monitorStore.getSlackConfig();

    // If the incoming webhookUrl looks masked (contains *), keep the stored one
    const effectiveWebhookUrl = (webhookUrl && webhookUrl.includes('*'))
      ? existing.webhookUrl
      : (webhookUrl || existing.webhookUrl);

    const config = {
      webhookUrl: effectiveWebhookUrl || '',
      channel: channel || existing.channel || '',
      timezone: timezone || existing.timezone || 'UTC',
      scheduleTime: scheduleTime || existing.scheduleTime || '06:00',
      enabled: enabled !== undefined ? Boolean(enabled) : (existing.enabled !== false),
    };

    await monitorStore.saveSlackConfig(config);
    await reinitScheduler();

    const masked = config.webhookUrl
      ? '*'.repeat(Math.max(0, config.webhookUrl.length - 10)) + config.webhookUrl.slice(-10)
      : '';
    res.json({ ok: true, config: { ...config, webhookUrl: masked } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/slack-config/test', async (req, res) => {
  try {
    const config = await monitorStore.getSlackConfig();
    await sendTestMessage(config);
    res.json({ ok: true, message: 'Test message sent successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Run control ───────────────────────────────────────────────────────────────

router.post('/run', async (req, res) => {
  const status = getStatus();
  if (status.isRunning) {
    return res.status(409).json({ error: 'RUN_IN_PROGRESS', message: 'A run is already in progress' });
  }

  // Generate a placeholder runId immediately so client can track
  const runId = 'run_manual_' + Date.now().toString(36);
  const run = req.run; // tracked run, closed out when the check really finishes
  res.json({ ok: true, runId });

  // Run async — do not await
  runMonitorCheck({ triggeredBy: 'manual' }).then(result => {
    run?.finish({ output: { runId: result?.runId || runId, summary: result?.summary || null, durationMs: result?.durationMs ?? null } });
  }).catch(err => {
    console.error('[RobotsMonitor] Manual run failed:', err.message);
    run?.fail(err.message);
  });
});

router.get('/run/status', (req, res) => {
  res.json(getStatus());
});

// ── History ───────────────────────────────────────────────────────────────────

router.get('/history', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 30;
  try {
    res.json(await monitorStore.getRunHistory({ limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history/:runId', async (req, res) => {
  try {
    const run = await monitorStore.getRunById(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
