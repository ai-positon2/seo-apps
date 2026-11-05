// Spread onto any element that should drop out of the Minimal version:
//   <div {...HIDE}>…</div>
// index.css hides it while <html data-view="minimal"> is set (see
// MinimalViewContext). It stays mounted, so nothing it does stops.
export const HIDE = { 'data-minimal': 'hide' };
