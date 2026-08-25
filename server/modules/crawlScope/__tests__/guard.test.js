const test = require("node:test");
const assert = require("node:assert/strict");
const { isPublicAddress, assertPublicUrl, SsrfError } = require("../net/guard");

test("isPublicAddress accepts globally routable addresses", () => {
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("93.184.216.34"), true); // example.com
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true); // cloudflare v6
});

test("isPublicAddress blocks loopback, private, link-local and CGNAT", () => {
  assert.equal(isPublicAddress("127.0.0.1"), false);
  assert.equal(isPublicAddress("10.0.0.1"), false);
  assert.equal(isPublicAddress("172.16.5.4"), false);
  assert.equal(isPublicAddress("192.168.1.1"), false);
  assert.equal(isPublicAddress("169.254.169.254"), false); // cloud metadata
  assert.equal(isPublicAddress("100.64.0.1"), false); // CGNAT
  assert.equal(isPublicAddress("0.0.0.0"), false);
});

test("isPublicAddress blocks IPv6 loopback, ULA, link-local and mapped-private", () => {
  assert.equal(isPublicAddress("::1"), false);
  assert.equal(isPublicAddress("fe80::1"), false);
  assert.equal(isPublicAddress("fc00::1"), false); // unique local
  assert.equal(isPublicAddress("::ffff:10.0.0.1"), false); // v4-mapped private
  assert.equal(isPublicAddress("::ffff:8.8.8.8"), true); // v4-mapped public
});

test("isPublicAddress rejects garbage input", () => {
  assert.equal(isPublicAddress("not-an-ip"), false);
  assert.equal(isPublicAddress(""), false);
});

test("assertPublicUrl rejects non-http(s) schemes", async () => {
  await assert.rejects(() => assertPublicUrl("ftp://example.com"), SsrfError);
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), SsrfError);
  await assert.rejects(() => assertPublicUrl("not a url"), SsrfError);
});

test("assertPublicUrl refuses IP-literal targets in private ranges", async () => {
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1/"), SsrfError);
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/"), SsrfError);
  await assert.rejects(() => assertPublicUrl("http://10.1.2.3/"), SsrfError);
  await assert.rejects(() => assertPublicUrl("http://[::1]/"), SsrfError);
});

test("assertPublicUrl accepts public IP-literal targets", async () => {
  assert.equal(await assertPublicUrl("https://8.8.8.8/"), true);
  assert.equal(await assertPublicUrl("http://1.1.1.1/"), true);
});
