// ── A profile built for another domain is out of date ──────────────────────
//
// Soteri Skin moved from position2.com to soteriskin.com and AI Visibility
// kept asking about Position², scoring 0 for a business it never asked about.
//
// Run: node --test modules/aiVisibilityLite/__tests__/profileDomain.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { hostOf, profileMatchesDomain, profileDomain } = require('../profileDomain');

const profile = (...urls) => ({ sourceUrls: urls });

test('a domain change flags the profile out of date', () => {
  assert.equal(profileMatchesDomain(profile('https://www.position2.com/about'), 'soteriskin.com'), false);
  assert.equal(profileDomain(profile('https://www.position2.com/about')), 'position2.com');
});

test('the same site under www, a subdomain or another country ending is not', () => {
  assert.equal(profileMatchesDomain(profile('https://joincabinet.com/x'), 'www.joincabinet.com'), true);
  assert.equal(profileMatchesDomain(profile('https://products.eventgroove.com'), 'eventgroove.com'), true);
  assert.equal(profileMatchesDomain(profile('https://www.nike.in/'), 'www.nike.com'), true);
  assert.equal(profileMatchesDomain(profile('https://www.nike.co.uk'), 'nike.com'), true);
});

test('a profile that recorded no sources is never called stale', () => {
  assert.equal(profileMatchesDomain(profile(), 'example.com'), true);
  assert.equal(profileMatchesDomain(null, 'example.com'), true);
});

test('hosts are read from bare domains and URLs alike', () => {
  assert.equal(hostOf('WWW.Example.com'), 'example.com');
  assert.equal(hostOf('https://www.example.com/a?b'), 'example.com');
  assert.equal(hostOf('not a url at all'), null);
});

test('a rebuild for a new domain retires the old generated questions first', () => {
  const setup = fs.readFileSync(path.join(__dirname, '../setup.js'), 'utf8');
  const retire = setup.indexOf('retireAutoPrompts');
  const build = setup.indexOf('businessProfile.build');
  assert.ok(retire > 0 && retire < build, 'retired before the new profile is built');
});
