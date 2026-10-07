// The shared API kit. See docs/superpowers/plans/2026-10-01-api-consistency.md
// for the standard these helpers implement.
module.exports = {
  ...require('./errors'),
  ...require('./asyncRoute'),
  ...require('./validate'),
  ...require('./page'),
  ...require('./sse'),
};
