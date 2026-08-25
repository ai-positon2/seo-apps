import { Card } from './primitives';

// ── The dashboard, before it has anything to say ─────────────────────────────
//
// The homepage reads three things: the project list, the overview, and the
// cross-module insight. They used to render the moment each one landed, so the
// page assembled itself in front of you — header, then a spinner, then six
// cards, then a panel that pushed everything down as it arrived. Each arrival
// moved whatever you had started reading.
//
// So nothing renders until all three are in, and this holds the space in the
// meantime. The shapes below are the real layout's shapes at the real sizes:
// same header height, same 380px + fluid two-column split, same card grid. That
// is the whole point of it — a skeleton that does not match its page swaps one
// layout shift for two.
//
// It never animates into the real page. The swap is instant and in place.

const shimmer = 'shimmer 1.4s ease-in-out infinite';

function Bar({ w = '100%', h = 12, r = 6, style }) {
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: r,
        background: 'color-mix(in srgb, var(--text-3) 16%, transparent)',
        animation: shimmer,
        ...style,
      }}
    />
  );
}

export default function HomeSkeleton() {
  return (
    <div
      // Identical geometry to the real page, so the swap moves nothing.
      style={{
        padding: '24px 32px 64px',
        display: 'flex',
        flexDirection: 'column',
        gap: 32,
        maxWidth: 1520,
        margin: '0 auto',
      }}
      aria-busy="true"
      aria-label="Loading the dashboard"
    >
      <style>{`@keyframes shimmer { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }`}</style>

      {/* Client header */}
      <Card elevation="md" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flex: 1, minWidth: 280 }}>
            <Bar w={34} h={34} r={8} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
              <Bar w={220} h={20} />
              <Bar w={320} h={11} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
            <Bar w={150} h={42} r={8} />
            <Bar w={140} h={42} r={8} />
          </div>
        </div>
      </Card>

      {/* Audit profile + module cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Bar w={280} h={16} />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(320px, 380px) minmax(0, 1fr)',
            gap: 16,
            alignItems: 'stretch',
          }}
        >
          <Card style={{ padding: 16, gap: 12 }}>
            <Bar w={120} h={11} />
            <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
              <Bar w={204} h={204} r="50%" />
            </div>
            <Bar w="90%" h={10} />
            <Bar w="70%" h={10} />
          </Card>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(268px, 1fr))',
              gap: 16,
            }}
          >
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Card key={i} style={{ padding: 16, gap: 10, minHeight: 172 }}>
                <Bar w={110} h={11} />
                <Bar w="80%" h={16} />
                <Bar w="100%" h={10} />
                <Bar w="60%" h={10} />
                <div style={{ flex: 1 }} />
                <Bar w={96} h={28} r={8} />
              </Card>
            ))}
          </div>
        </div>
      </div>

      {/* What the modules say together */}
      <Card style={{ padding: 18, gap: 12 }}>
        <Bar w={300} h={16} />
        <Bar w="100%" h={10} />
        <Bar w="85%" h={10} />
        <Bar w="92%" h={10} />
      </Card>
    </div>
  );
}
