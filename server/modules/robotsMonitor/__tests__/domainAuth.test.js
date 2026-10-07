// Robots Monitor stores HTTP basic-auth credentials for staging sites. They are
// needed by the checker and by nobody else: every response that carries a
// domain must leave the password out, and an edit must never let a saved
// password follow a domain to a different host.

const test = require('node:test');
const assert = require('node:assert');
const { redactDomain, redactClient, resolveAuthUpdate } = require('../domainAuth');

const SAVED = { id: 'dom_1', url: 'https://staging.example.com', env: 'staging',
  auth: { username: 'qa', password: 's3cret' }, enabled: true };

test('redactDomain drops the password but keeps the username and a flag', () => {
  const out = redactDomain(SAVED);
  assert.deepStrictEqual(out.auth, { username: 'qa', hasPassword: true });
  assert.strictEqual(JSON.stringify(out).includes('s3cret'), false);
  assert.strictEqual(SAVED.auth.password, 's3cret', 'the stored record is not mutated');
});

test('redactDomain leaves a domain without auth alone', () => {
  assert.strictEqual(redactDomain({ ...SAVED, auth: null }).auth, null);
});

test('redactClient redacts every domain of the client', () => {
  const client = { id: 'c1', name: 'Acme', domains: [SAVED, { ...SAVED, id: 'dom_2', auth: null }] };
  const out = redactClient(client);
  assert.strictEqual(JSON.stringify(out).includes('s3cret'), false);
  assert.strictEqual(out.domains.length, 2);
  assert.strictEqual(out.name, 'Acme');
});

test('an edit with a blank password keeps the saved one', () => {
  const auth = resolveAuthUpdate({ existing: SAVED, auth: { username: 'qa2', password: '' } });
  assert.deepStrictEqual(auth, { username: 'qa2', password: 's3cret' });
});

test('an edit with a new password replaces it', () => {
  const auth = resolveAuthUpdate({ existing: SAVED, auth: { username: 'qa', password: 'n3w' } });
  assert.deepStrictEqual(auth, { username: 'qa', password: 'n3w' });
});

test('turning auth off clears it', () => {
  assert.strictEqual(resolveAuthUpdate({ existing: SAVED, auth: null }), null);
});

test('no auth in the request leaves it unchanged (undefined)', () => {
  assert.strictEqual(resolveAuthUpdate({ existing: SAVED, auth: undefined }), undefined);
});

test('moving to another host with the saved password is refused', () => {
  assert.throws(
    () => resolveAuthUpdate({ existing: SAVED, url: 'https://attacker.example.net', auth: { username: 'qa', password: '' } }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => resolveAuthUpdate({ existing: SAVED, url: 'https://attacker.example.net', auth: undefined }),
    (e) => e.status === 400,
  );
});

test('moving to another host with a newly typed password is allowed', () => {
  const auth = resolveAuthUpdate({ existing: SAVED, url: 'https://new.example.com', auth: { username: 'qa', password: 'typed' } });
  assert.deepStrictEqual(auth, { username: 'qa', password: 'typed' });
});

test('the same host on a different scheme keeps the saved password', () => {
  const auth = resolveAuthUpdate({ existing: SAVED, url: 'http://staging.example.com', auth: { username: 'qa', password: '' } });
  assert.deepStrictEqual(auth, { username: 'qa', password: 's3cret' });
});

test('a blank password with nothing saved is refused', () => {
  assert.throws(
    () => resolveAuthUpdate({ existing: { ...SAVED, auth: null }, auth: { username: 'qa', password: '' } }),
    (e) => e.status === 400,
  );
});

test('a blank username is refused', () => {
  assert.throws(
    () => resolveAuthUpdate({ existing: SAVED, auth: { username: ' ', password: 'x' } }),
    (e) => e.status === 400,
  );
});
