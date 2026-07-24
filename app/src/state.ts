// state.ts — the typed boot snapshot the Node server ships at GET /state, the
// transcript entry shape, and the tiny fetch/POST helpers the chat machine calls.
// This is the whole client/server boundary — read it first.
//
// The wire `ChatEntry` (server-stamped, with a real monotonic `id`) is the
// authoritative turn. The client also shows two turn kinds the server never
// sends: an optimistic `you` echo (a negative provisional id, swapped for the
// real entry once /feedback returns) and a client-only `error` notice. `Turn`
// is that superset; everything renders off it uniformly.

export type ReplyFormat = 'html' | 'text';

export interface ChatEntry {
  id: number;
  role: 'agent' | 'you';
  text: string;
  format: ReplyFormat;
  at: number;
}

// A rendered transcript entry: a server turn, or the client-only `error` notice.
export type Turn = ChatEntry | { id: number; role: 'error'; text: string };

export interface ChatState {
  mode: 'chat';
  chat: ChatEntry[];
}

export async function fetchState(): Promise<ChatState> {
  const res = await fetch('/state');
  if (!res.ok) throw new Error(`GET /state -> HTTP ${res.status}`);
  return res.json() as Promise<ChatState>;
}

// POST a human message. The server stamps + mirrors it and echoes the stamped
// entry back, which the optimistic bubble reconciles to (real monotonic id).
export async function sendMessage(text: string): Promise<ChatEntry> {
  const res = await fetch('/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`POST /feedback -> HTTP ${res.status}`);
  const data = (await res.json()) as { entry: ChatEntry };
  return data.entry;
}

// End the session server-side (tears down the `open` server, wakes the parked
// poll with `ended`).
export async function endChat(): Promise<void> {
  await fetch('/end', { method: 'POST' });
}
