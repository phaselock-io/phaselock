// the code that decides what a hold is and when one fails, which is all the app had to write
const MODEL_SOURCE = 'https://github.com/phaselock-io/phaselock/tree/master/examples/library/model';

/** what PhaseLock is, what the demo is, and a conflict to try in it */
export default function Intro() {
  return (
    <div className="intro">
      <p>PhaseLock is a sync engine for live apps that work offline.</p>
      <p>This demo app simulates a library catalog and three clients.</p>
      <p>
        Try it: switch Bob offline and click <strong>Hold</strong> on any book. Bob sees a pending
        hold.
      </p>
      <p>
        Then have Alice click <strong>Hold</strong> on the same book. The Front Desk shows it
        immediately.
      </p>
      <p>Then switch Bob online. His hold is rejected with a message.</p>
      <p>
        You write your UI and{' '}
        <a href={MODEL_SOURCE} target="_blank" rel="noopener">
          business logic
        </a>
        . PhaseLock automates offline mode, optimistic updates, and live sync.
      </p>
    </div>
  );
}
