import { useState } from 'react';
import { Button } from '../../../ui';
import { SourcesReport } from './SourcesReport';
import { GapsReport } from './GapsReport';

// ── Sources ─────────────────────────────────────────────────────────────────
//
// One screen where there were three: Gap analysis, Domains and URLs.
//
// They were never three reports. They were one body of citation data split by
// how deep you wanted to look, and asking a reader to pick a depth from a
// navigation rail — before seeing anything — is asking them to choose without
// information. Domains is the useful default; pages are a click away; the
// gaps sit underneath, because "who gets cited instead of you" is only
// actionable once you know who gets cited at all.
//
// Both halves render through the ORIGINAL components against a re-shaped
// envelope rather than a reimplementation. The server merged three
// re-selections into one payload, so the numbers are the same numbers; this
// hands each component the slice it already knows how to draw.

export function SourcesScreen({ envelope }) {
  const [level, setLevel] = useState('domain');
  const { data } = envelope;

  // Re-shaped, not recomputed. `rows` is the key both components read.
  const sourcesEnvelope = {
    ...envelope,
    data: { ...data, rows: (level === 'url' ? data.urls : data.domains) || [] },
  };
  const gapsEnvelope = {
    ...envelope,
    // The gaps half carries its own warnings already; passing them twice would
    // print the same sentence at the top of both halves of one screen.
    warnings: [],
    data: { ...data, rows: data.gaps || [], topFive: data.topGaps || [] },
  };

  return (
    <>
      <div style={{
        display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 8,
      }}
      >
        <Button
          size="sm"
          variant={level === 'domain' ? 'primary' : 'ghost'}
          onClick={() => setLevel('domain')}
        >
          By domain
        </Button>
        <Button
          size="sm"
          variant={level === 'url' ? 'primary' : 'ghost'}
          onClick={() => setLevel('url')}
        >
          By page
        </Button>
      </div>

      <SourcesReport envelope={sourcesEnvelope} level={level} />

      <div style={{ marginTop: 28 }}>
        <GapsReport envelope={gapsEnvelope} />
      </div>
    </>
  );
}

export default SourcesScreen;
