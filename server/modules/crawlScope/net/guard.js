// SSRF protection for the hosted crawler.
//
// A local desktop crawler can safely fetch localhost and private hosts. A hosted
// crawler must not: a user-supplied URL could otherwise reach cloud metadata
// (169.254.169.254), internal services, or the Railway network. This module
// blocks any target that resolves to a non-public address, and it validates at
// DNS-connect time so a DNS-rebinding response (public A record for the check,
// private one for the connect) is still refused.
//
// It is injected only into the server/worker fetch. The desktop app and the unit
// tests keep using an unguarded fetch so localhost audits continue to work.

const dns = require("node:dns");
const ipaddr = require("ipaddr.js");

class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = "SsrfError";
  }
}

// True only for globally-routable unicast addresses. Everything else — loopback,
// link-local (incl. cloud metadata), private, CGNAT, unique-local, reserved,
// and exotic IPv6 tunnels — is treated as non-public and refused.
function isPublicAddress(ip) {
  let addr;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return false;
  }
  if (addr.kind() === "ipv6") {
    const range = addr.range();
    // IPv4-mapped v6 (::ffff:10.0.0.1) must be judged by its embedded v4 address.
    if (range === "ipv4Mapped") {
      return isPublicAddress(addr.toIPv4Address().toString());
    }
    return range === "unicast";
  }
  return addr.range() === "unicast";
}

// dns.lookup-compatible hook for undici's `connect.lookup`. Resolves ALL records
// and refuses if any is non-public, so an attacker cannot slip a private address
// past the check by returning multiple A records.
function guardedLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses)
      ? addresses
      : [{ address: addresses, family: options.family || 0 }];
    for (const entry of list) {
      if (!isPublicAddress(entry.address)) {
        return callback(
          new SsrfError(
            `Refusing to connect to non-public address ${entry.address} (${hostname})`,
          ),
        );
      }
    }
    if (options && options.all) return callback(null, list);
    const first = list[0];
    return callback(null, first.address, first.family);
  });
}

// Pre-flight check for a full URL before a request is dispatched. Rejects
// non-http(s) schemes and hosts that resolve to any non-public address.
function assertPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new SsrfError(`Invalid URL: ${url}`));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Promise.reject(new SsrfError(`Unsupported protocol: ${parsed.protocol}`));
  }
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  return new Promise((resolve, reject) => {
    guardedLookup(hostname, { all: true }, (err) => {
      if (err) {
        return reject(
          err instanceof SsrfError
            ? err
            : new SsrfError(`DNS lookup failed for ${hostname}: ${err.message}`),
        );
      }
      resolve(true);
    });
  });
}

module.exports = { SsrfError, isPublicAddress, guardedLookup, assertPublicUrl };
