// ── Clear Behavioral Health — Location + Service pages ──────────────────────
// A route of its own, rendering the shared template-driven wizard for this one
// client. Everything brand-specific is data: the client id here, the brand
// facts on the client row, and the tunable budgets in
// config.lsPages.clients (see server/locationPageBuilder/lsProfiles.js). Adding
// the next brand is a second file this size, not a second wizard.

import LsWizard from '../components/lsPages/LsWizard';
import { lsPages } from '../lib/lsPagesApi';

// Matches server/locationPageBuilder/data/clearBehavioralHealth.js CLIENT_ID.
const CLIENT_ID = 'client_clear_behavioral_health';

export default function ClearBehavioralHealthPage() {
  return (
    <LsWizard
      clientId={CLIENT_ID}
      title="Clear Behavioral Health — Location + Service Pages"
      subtitle="Keyword research, a competitor-led content brief you approve, then the page written from it."
      // Safe to re-run: the service list is replaced, and addresses, phone
      // numbers and serving areas entered by hand are preserved.
      seed={lsPages.seedClearBehavioralHealth}
      seedLabel="Set up Clear Behavioral Health"
    />
  );
}
