// Express 4 does not forward a rejected handler promise to the error handler —
// an unguarded `await` that throws hangs the request instead. Wrap async
// handlers in this so a throw (sync or async) reaches next(err) and the global
// handler answers it in the standard error shape.
function asyncRoute(handler) {
  return function asyncRouteHandler(req, res, next) {
    try {
      return Promise.resolve(handler(req, res, next)).catch(next);
    } catch (err) {
      next(err);
      return Promise.resolve();
    }
  };
}

module.exports = { asyncRoute };
