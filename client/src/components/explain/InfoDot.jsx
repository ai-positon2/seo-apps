import { resolveExplainer } from './explainCopy';
import { useGuidedMode } from './GuidedModeContext';
import ExplainPopover from './ExplainPopover';
import ExplainTooltip from './ExplainTooltip';

/**
 * The "i" after a box's label. Guided mode on: a click opens the full
 * explanation. Off: hover or focus shows the title and one line.
 *
 * @param {string}  explainKey  a key in explainCopy's EXPLAINERS
 * @param {object}  [ctx]       the figures this screen already has, for the
 *                              copy's worked examples
 * @param {'default'|'onAccent'} [tone]  onAccent for icons on the teal panel
 * @param {React.ReactNode} [calcExtra]  shown under "How it's calculated" —
 *                              a live breakdown, or "This run: …"
 */
export default function InfoDot({ explainKey, ctx, tone = 'default', calcExtra = null }) {
  const { guided } = useGuidedMode();
  const explainer = resolveExplainer(explainKey, ctx);
  if (!explainer) return null;
  return guided
    ? <ExplainPopover explainer={explainer} ctx={ctx} tone={tone} calcExtra={calcExtra} />
    : <ExplainTooltip explainer={explainer} tone={tone} />;
}

