import { useGuidedMode } from './GuidedModeContext';

// The header switch. The helper text says what the current mode does with an
// icon; it is hidden below 1440px (index.css) so it never pushes the header's
// navigation buttons off the bar.
export default function GuidedModeToggle() {
  const { guided, setGuided } = useGuidedMode();
  return (
    <div className="explain-toggle">
      <span className="explain-toggle__note">
        {guided ? 'Click an info icon for the full explanation' : 'Hover an info icon for a quick summary'}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={guided}
        onClick={() => setGuided(!guided)}
        className={`explain-toggle__switch${guided ? ' is-on' : ''}`}
      >
        <span>Guided mode</span>
        <span className="explain-toggle__track" aria-hidden="true">
          <span className="explain-toggle__knob" />
        </span>
      </button>
    </div>
  );
}
