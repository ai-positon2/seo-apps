import { Navigate, useNavigate } from 'react-router-dom';
import { PageFrame, Button, Card, EmptyState, Spinner } from '../ui';
import { useActiveProject } from '../lib/useActiveProject';
import { matchClientSlug } from '../lib/clientMatch';

// ── Location + Service Pages: the front door ────────────────────────────────
//
// The menu item used to open "Gentle Dental Pages" whatever client the header
// named, with three hard-coded client tabs (docs/design-audit/01-audit.md,
// LOC-1). It now follows the header: a client that has a page-builder setup
// lands on its own builder; any other client is told so plainly, with the
// set-up clients listed so nothing becomes unreachable.
//
// The three builders are still separate flows underneath. Replacing them with
// one wizard is part of docs/design-audit/02-plan-one-client.md.

const BUILDERS = [
  { slug: 'gentle-dental', name: 'Gentle Dental', path: '/location-page-builder/gentle-dental-pages' },
  { slug: 'clear-behavioral-health', name: 'Clear Behavioral Health', path: '/location-page-builder/clear-behavioral-health' },
  { slug: 'neuro-wellness-spa', name: 'Neuro Wellness Spa', path: '/location-page-builder/neuro' },
];

export default function LocationPagesHomePage() {
  const navigate = useNavigate();
  const { project, loaded } = useActiveProject();

  if (!loaded) return <Spinner label="Checking this client’s location pages…" />;

  const slug = matchClientSlug(project, BUILDERS.map((b) => b.slug));
  const builder = BUILDERS.find((b) => b.slug === slug);
  if (builder) return <Navigate to={builder.path} replace />;

  return (
    <PageFrame
      title="Location + Service Pages"
      purpose="Builds ready-to-publish pages for one service in one location, from keyword research to approved copy."
      width="narrow"
    >
      <EmptyState
        title={project ? `Location pages aren’t set up for ${project.name} yet` : 'Pick a client in the header'}
        description={project
          ? 'The page builder is set up client by client. These clients have it today:'
          : 'Location pages are built per client.'}
      />
      <Card style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {BUILDERS.map((b) => (
            <div key={b.slug} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ fontSize: 'var(--fs-base)', color: 'var(--text)' }}>{b.name}</span>
              <Button size="sm" variant="secondary" onClick={() => navigate(b.path)}>Open</Button>
            </div>
          ))}
        </div>
      </Card>
    </PageFrame>
  );
}
