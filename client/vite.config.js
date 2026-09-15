import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const MARKER = 'node_modules/'

// Which vendor bucket a module belongs to, or undefined to leave Rollup's
// default behaviour alone — and with the routes in App.jsx now lazy, that
// default is what splits src/ along the route boundaries.
//
// Matched by package name rather than by regex over the path: Vite normalises
// module ids to forward slashes on every platform, and comparing the segment
// after 'node_modules/' avoids matching a package whose name merely contains
// another's (a bare startsWith('d3') would also claim 'd3x-whatever').
//
// The rule that matters: never put a lazily-reached library in the same bucket
// as one the entry imports eagerly. A bucket is emitted as one chunk, so a
// single eagerly-reachable module in it drags the whole bucket into the entry.
// The build still succeeds and the app still works — the saving just silently
// disappears. Check by opening dist/index.html: the only script/modulepreload
// entries should be the entry plus vendor-react and vendor-router.
function manualChunks(id) {
  const at = id.lastIndexOf(MARKER)
  if (at === -1) return undefined
  const pkg = id.slice(at + MARKER.length)

  const is = (...names) => names.some((n) => pkg === n || pkg.startsWith(n + '/'))
  const startsWith = (...prefixes) => prefixes.some((p) => pkg.startsWith(p))

  if (is('react', 'react-dom', 'scheduler')) return 'vendor-react'
  if (is('react-router', 'react-router-dom') || startsWith('@remix-run/')) return 'vendor-router'

  // Each of these is reached from one or two lazy routes only. Bucketing them
  // keeps them out of a chunk Rollup might otherwise share more widely, and
  // makes each one's weight legible in the build report.
  if (is('xlsx')) return 'vendor-xlsx'                                  // SEO & GEO Excel export
  if (is('docx', 'jszip', 'pako', 'xml-js')) return 'vendor-docx'       // Article Recommendation Word export
  if (is('remark', 'rehype', 'refractor', 'unified', 'parse5', 'bail', 'trough', 'devlop',
         'zwitch', 'ccount', 'longest-streak', 'markdown-table', 'is-plain-obj',
         'property-information', 'space-separated-tokens', 'comma-separated-tokens',
         'character-entities', 'decode-named-character-reference')
      || startsWith('@uiw/', 'remark-', 'rehype-', 'micromark', 'mdast-', 'hast-', 'unist-', 'vfile')) {
    return 'vendor-md'                                                  // markdown editor (KB pages)
  }
  if (is('react-simple-maps', 'topojson-client', 'us-atlas', 'delaunator',
         'robust-predicates', 'internmap')
      || startsWith('d3-', 'topojson-')) {
    return 'vendor-maps'                                                // Market Potential US map
  }

  return undefined
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        timeout: 120000
      }
    }
  },
  build: {
    rollupOptions: { output: { manualChunks } },
    // A tripwire, not a silencer. The entry chunk was 3.1 MB; if it creeps back
    // over this, something has been pulled eagerly into it again. Raising this
    // to quiet the warning defeats the only automatic check on that.
    chunkSizeWarningLimit: 600
  }
})
