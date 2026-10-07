// ── Server-sent events: one helper instead of five copies ────────────────────
// Sets the headers (including X-Accel-Buffering so a proxy does not hold the
// stream), keeps the connection alive with a comment every heartbeatMs, and
// stops writing once the client has gone. `send` takes an optional id, which
// the browser hands back as Last-Event-ID when it reconnects.

function openSse(res, { heartbeatMs = 15000, retryMs } = {}) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const write = (chunk) => {
    if (closed) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  const heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
  });

  if (retryMs) write(`retry: ${retryMs}\n\n`);

  return {
    send(event, data, id) {
      const idLine = id === undefined || id === null ? '' : `id: ${id}\n`;
      return write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data === undefined ? null : data)}\n\n`);
    },
    comment(text) {
      return write(`: ${text}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      if (!closed) {
        closed = true;
        try { res.end(); } catch { /* already gone */ }
      }
    },
    get closed() {
      return closed;
    },
  };
}

module.exports = { openSse };
