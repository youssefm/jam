// types.ts — backend types shared across modules: the chat wire contract the
// server ships to the React app (mirrored in app/src/state.ts) and the shapes the
// store produces. Type-only — erased at runtime, so importing it costs nothing.

// An agent turn is either rich HTML (the point of jam) or a plain-text
// one-liner; human turns are always `text`.
export type ReplyFormat = 'html' | 'text';

export type ChatRole = 'agent' | 'you';

// One turn in the transcript. `id` is a monotonic per-session turn number shared
// across human and agent turns — the client reconciles the transcript by it.
export interface ChatEntry {
  id: number;
  role: ChatRole;
  text: string;
  format: ReplyFormat;
  at: number;
}

// What a long-poll resolves with: the next human message, or `ended` when the
// human closed the session from the browser.
export type PollResult =
  | { status: 'message'; id: number; text: string; at: number }
  | { status: 'ended' };

// The boot snapshot GET /state ships. Single implicit mode — `mode: 'chat'` is a
// tagged shape so the client boundary can discriminate on it as modes are added.
export interface ChatState {
  mode: 'chat';
  chat: ChatEntry[];
}
