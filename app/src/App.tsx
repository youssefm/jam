// App.tsx — the chat shell: a sticky header (session name + End chat), the
// scrolling transcript, and the sticky composer. It wires the `useChat` machine
// to the three panes and nothing more; the transcript owns autoscroll, the
// composer owns its textarea, and the machine owns the stream and the wire.

import { useEffect } from 'react';

import { useChat } from './chat';
import { IS_MAC } from './platform';
import { signalAgentState } from './agentHub';
import { JamMark } from './JamMark';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import type { ChatState } from './state';

// The server bakes `${session} — jam` into the tab <title> on first paint, so
// the session handle is already here — read it back rather than widen /state.
function sessionName(): string {
  return document.title.replace(/ — jam$/, '');
}

export function App({ state }: { state: ChatState }) {
  const { turns, agentBusy, ended, send, end } = useChat(state.chat);

  // A freshly-loaded chat is ready for the user, so tell the AgentHub host (no-op
  // elsewhere) — this points the user to the tab even when AgentHub is
  // backgrounded. Fires once; App mounts a single time per load.
  useEffect(() => {
    signalAgentState('review');
  }, []);

  // The primary chord + E (Cmd+E on mac, Ctrl+E elsewhere) ends the chat; drop
  // the binding once ended (an ended chat is read-only).
  useEffect(() => {
    if (ended != null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((IS_MAC ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        void end();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ended, end]);

  return (
    <div className="jam-shell">
      <header className="jam-header">
        <div className="jam-header-left">
          <JamMark playing={agentBusy} />
          <div className="jam-brand">
            jam<span className="jam-session">{sessionName()}</span>
          </div>
        </div>
        <button
          className="jam-btn jam-btn-primary"
          data-action="end-chat"
          title={`End chat (${IS_MAC ? '⌘E' : 'Ctrl+E'})`}
          disabled={ended != null}
          onClick={() => void end()}
        >
          End chat
        </button>
      </header>

      <Transcript turns={turns} agentBusy={agentBusy} />

      <Composer busy={agentBusy} ended={ended != null} onSend={(text) => void send(text)} />

      {/* The transcript's keyboard focus ring, painted above the composer so it
          stays crisp instead of fading under the composer scrim (see chrome.css). */}
      <div className="jam-focus-frame" aria-hidden="true" />

      {ended != null && <div className="jam-banner">{ended}</div>}
    </div>
  );
}
