import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, requestRaw, ApiRequestError } from '../apiRequest.js';

function stubFetch(status, bodyText, capture = {}) {
  globalThis.fetch = async (url, init) => {
    capture.url = url;
    capture.init = init;
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return bodyText; },
    };
  };
  return capture;
}

test('a 409 keeps status, code and the whole body', async () => {
  stubFetch(409, JSON.stringify({ error: 'Already exists.', code: 'duplicate_domain', existingProjectId: 'p1' }));
  await assert.rejects(requestJson('/api/projects', { method: 'POST', body: '{}' }), (e) => {
    assert.ok(e instanceof ApiRequestError);
    assert.equal(e.message, 'Already exists.');
    assert.equal(e.status, 409);
    assert.equal(e.code, 'duplicate_domain');
    assert.equal(e.body.existingProjectId, 'p1');
    assert.equal(e.unavailable, false);
    return true;
  });
});

test('a 503 is flagged unavailable', async () => {
  stubFetch(503, JSON.stringify({ error: 'Database not configured.', code: 'not_configured' }));
  await assert.rejects(requestJson('/api/runs'), (e) => e.unavailable === true && e.code === 'not_configured');
});

test('a non-JSON error body falls back to the status', async () => {
  stubFetch(404, '<!doctype html><html></html>');
  await assert.rejects(requestJson('/api/x'), (e) => e.message === 'Request failed (404)' && e.code === undefined);
});

test('details are carried', async () => {
  stubFetch(400, JSON.stringify({ error: 'name: Required', code: 'invalid_request', details: { issues: [{ path: 'name' }] } }));
  await assert.rejects(requestJson('/api/x'), (e) => e.details.issues[0].path === 'name');
});

test('an empty success body resolves null', async () => {
  stubFetch(204, '');
  assert.equal(await requestJson('/api/x', { method: 'DELETE' }), null);
});

test('JSON bodies get a content type and cookies are sent', async () => {
  const cap = stubFetch(200, '{"ok":true}');
  assert.deepEqual(await requestJson('/api/x', { method: 'POST', body: '{"a":1}' }), { ok: true });
  assert.equal(cap.init.credentials, 'include');
  assert.equal(cap.init.headers['Content-Type'], 'application/json');
});

test('an explicit content type is kept', async () => {
  const cap = stubFetch(200, '{}');
  await requestJson('/api/x', { method: 'POST', body: 'a,b', headers: { 'content-type': 'text/csv' } });
  assert.equal(cap.init.headers['content-type'], 'text/csv');
  assert.equal(cap.init.headers['Content-Type'], undefined);
});

test('requestRaw returns the response, and names the action on a bare failure', async () => {
  stubFetch(200, 'file');
  const res = await requestRaw('/api/export');
  assert.equal(await res.text(), 'file');
  stubFetch(500, '');
  await assert.rejects(requestRaw('/api/export', {}, 'Export failed'), (e) => e.message === 'Export failed (500)');
});
