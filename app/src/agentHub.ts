// agentHub.ts — the bridge to the AgentHub host, an optional embedded-browser
// host. When jam runs inside an AgentHub browser <webview> tab, an AgentHub-owned
// preload exposes `window.agentHub` with a single `signalState` capability; the
// signal drives the tab-strip dot, the chime, and the native notification.
// `window.agentHub` is absent in a plain browser (a hand-opened `jam open` tab),
// so `signalAgentState` is a guarded no-op everywhere outside AgentHub.
//
// The signal must come from the top frame — AgentHub loads the preload top-frame
// only — which is where jam's app runs.

// The state vocabulary AgentHub understands: `working` (accent, pulsing — the
// agent is composing a reply) and `review` (emerald — the reply is ready to read,
// which chimes/notifies when the user is away).
export type AgentTabState = 'working' | 'review';

declare global {
  interface Window {
    agentHub?: { signalState(state: AgentTabState): void };
  }
}

export function signalAgentState(state: AgentTabState): void {
  window.agentHub?.signalState(state);
}
