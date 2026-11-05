import { useMinimalView } from './MinimalViewContext';

// The header switch. Off (the default) is the minimal, CMO-facing view; on is
// Advanced mode, with every section shown. Reuses Guided mode's switch styling
// (.explain-toggle* in index.css). No helper note beside it, unlike Guided
// mode's: with both notes showing, the header pushed the account chip off the
// right edge at 1600px. The label says what it does; the tooltip says more.
export default function MinimalViewToggle() {
  const { minimal, setMinimal } = useMinimalView();
  const advanced = !minimal;
  return (
    <div className="explain-toggle">
      <button
        type="button"
        role="switch"
        aria-checked={advanced}
        onClick={() => setMinimal(advanced)}
        title={advanced ? 'Back to the executive view' : 'Show every section, including the practitioner detail'}
        className={`explain-toggle__switch${advanced ? ' is-on' : ''}`}
      >
        <span>Advanced mode</span>
        <span className="explain-toggle__track" aria-hidden="true">
          <span className="explain-toggle__knob" />
        </span>
      </button>
    </div>
  );
}
