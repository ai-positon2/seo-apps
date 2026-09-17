#!/usr/bin/env node
// ── The crawlScope test runner ───────────────────────────────────────────────
//
// These tests run in ONE process on purpose. `node --test` spawns a child per
// file by default, and the crawlScope suite is 22 files that each pull in the
// crawler, the analyzer and the rule catalog — a few hundred milliseconds of
// module loading paid 22 times, for tests that share no mutable state.
//
// The flag that turns that off is spelled differently on the two Node versions
// this repo actually runs on:
//
//   Node 22  --experimental-test-isolation=none   (nixpacks.toml → nodejs_22)
//   Node 24  --test-isolation=none                (Dockerfile → node:24-slim)
//
// package.json used to hard-code the Node 24 spelling, so `npm test` died with
// `node: bad option: --test-isolation=none` and exit code 9 on the nixpacks
// deploy — before a single crawlScope test ran, and after 57 other suites had
// already passed, which made it read like a crawler failure rather than a flag
// one. Picking the spelling at runtime is the only thing this file does beyond
// what the npm script did.

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const PATTERN = 'modules/crawlScope/__tests__/**/*.test.js';

// Asked of the runtime, not derived from `process.version`. `--test-isolation`
// was unflagged in Node 24 and the experimental spelling landed in 22.8, so a
// version comparison would encode two release numbers that a third rename
// invalidates. `node <flag> -e ''` costs about 30ms and answers the actual
// question. (`process.allowedNodeEnvironmentFlags` does NOT answer it — it
// lists what NODE_OPTIONS accepts, and the test flags are not in that set.)
function supports(flag) {
  return spawnSync(process.execPath, [flag, '-e', ''], { stdio: 'ignore' }).status === 0;
}

const isolation = ['--test-isolation=none', '--experimental-test-isolation=none'].find(supports)
  // Neither spelling exists (Node < 22.8). Run without it: every test still
  // runs, they are just each paid for in a fresh process. Slower, not wrong.
  || null;

if (!isolation) {
  console.warn(
    `[test:crawlscope] ${process.version} has no --test-isolation flag; running one process `
    + 'per file. The suite still passes, it just takes longer.',
  );
}

const args = ['--test', ...(isolation ? [isolation] : []), PATTERN];
const child = spawn(process.execPath, args, {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
});

child.on('error', (e) => {
  console.error(`[test:crawlscope] could not start ${process.execPath}: ${e.message}`);
  process.exit(1);
});
// A signalled child has a null exit code; reporting that as 0 would turn a
// killed test run into a green build.
child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
