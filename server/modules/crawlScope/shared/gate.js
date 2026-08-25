// A minimal counting semaphore.
//
// Exists for one specific reason: building the .xlsx workbook is a synchronous ExcelJS
// row loop that both blocks the event loop and allocates heavily (hundreds of MB on a
// large crawl). With several crawls finishing at once on a multi-slot worker, running
// those builds concurrently multiplies the peak instead of spreading it, so the build
// is funnelled through a gate of 1 while the crawls themselves stay parallel.

function createGate(limit = 1) {
  const ceiling = Math.max(1, Number(limit) || 1);
  let active = 0;
  const waiting = [];

  return async function withGate(fn) {
    if (active >= ceiling) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  };
}

module.exports = { createGate };
