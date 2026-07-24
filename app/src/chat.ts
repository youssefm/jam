// chat.ts — the chat session state machine. It owns the transcript, the ended
// state, and the SSE stream.
//
// The model is deliberately small because the composer is disabled while the
// agent is busy, so at most one human message is ever in flight — there is no
// outbox, no queue, no auto-flush. A send optimistically echoes a `you` bubble
// (a negative provisional id), POSTs it, then swaps in the server-stamped entry.
// Agent replies arrive over SSE. On every SSE (re)connect the machine refetches
// /state and reconciles by id — the snapshot is authoritative, closing the
// window where a reply lands between boot and the stream connecting.
//
// `agentBusy` is not stored: the agent owes a reply exactly when the last turn is
// a human one, so it's derived from the transcript. That keeps the gate honest
// through a send, a reply, a reconnect, and — crucially — a reload mid-compose
// (the snapshot's trailing `you` turn restores the disabled composer), with no
// flag to wedge.

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchState, sendMessage, endChat, type ChatEntry, type Turn } from './state';
import { signalAgentState } from './agentHub';

const MAX_STREAM_ERRORS = 3;

export interface ChatSession {
  turns: Turn[];
  agentBusy: boolean;
  ended: string | null; // a banner message once ended, else null
  send: (text: string) => Promise<void>;
  end: () => Promise<void>;
}

export function useChat(initial: ChatEntry[]): ChatSession {
  const [turns, setTurns] = useState<Turn[]>(initial);
  const [ended, setEnded] = useState<string | null>(null);

  // Provisional ids for optimistic echoes (and client-only error notices) count
  // down from -1, so they never collide with the server's positive monotonic ids
  // and always read as "not yet confirmed."
  const provisionalSeq = useRef(0);
  const eventsRef = useRef<EventSource | null>(null);
  // The SSE error handler and the stream teardown read "are we already ended?"
  // — hold it in a ref so they see the latest value without re-subscribing.
  const endedRef = useRef(false);

  // The agent owes a reply exactly when the last turn is human (a real `you`
  // turn, or a still-unconfirmed optimistic echo). A trailing agent reply or a
  // failed-send `error` notice clears it.
  const agentBusy = turns[turns.length - 1]?.role === 'you';

  const showEnded = useCallback((message: string) => {
    endedRef.current = true;
    setEnded(message);
    eventsRef.current?.close();
  }, []);

  // Reflect the ended state on <body> for the CSS that dims the chrome.
  useEffect(() => {
    document.body.classList.toggle('jam-ended', ended != null);
  }, [ended]);

  // Insert an agent reply, replacing an entry that already carries its id (a
  // reconcile may have raced the stream) rather than duplicating it.
  const receiveReply = useCallback((entry: ChatEntry) => {
    setTurns((prev) =>
      prev.some((t) => t.id === entry.id) ? prev.map((t) => (t.id === entry.id ? entry : t)) : [...prev, entry],
    );
    // Tell the AgentHub host the reply is ready to read (no-op elsewhere).
    signalAgentState('review');
  }, []);

  // Reconcile against the authoritative snapshot: server turns in id order, then
  // any still-unconfirmed optimistic echo / error notice (negative id) kept at
  // the tail. `agentBusy` re-derives from the result, so no gate bookkeeping here.
  const reconcile = useCallback((chat: ChatEntry[]) => {
    setTurns((prev) => [...chat, ...prev.filter((t) => t.id < 0)]);
  }, []);

  useEffect(() => {
    let errors = 0;
    const events = new EventSource('/events');
    eventsRef.current = events;

    // Snapshot is authoritative on every (re)connect — reconnects have no replay,
    // so refetch and reconcile rather than trust the stream alone.
    const refetchAndReconcile = async () => {
      try {
        const state = await fetchState();
        reconcile(state.chat);
      } catch {
        /* a failed refetch just waits for the next connect */
      }
    };

    events.addEventListener('open', () => {
      errors = 0;
      void refetchAndReconcile();
    });
    events.addEventListener('agent-reply', (event) => {
      try {
        receiveReply(JSON.parse((event as MessageEvent<string>).data) as ChatEntry);
      } catch {
        /* ignore a malformed frame */
      }
    });
    // The server closes its SSE responses on teardown. Don't reconnect forever
    // against a dead port: after a few failures, treat the session as ended.
    events.addEventListener('error', () => {
      if (endedRef.current) return events.close();
      if (++errors >= MAX_STREAM_ERRORS) showEnded('Disconnected — the chat server is gone.');
    });

    return () => events.close();
  }, [reconcile, receiveReply, showEnded]);

  const send = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const tempId = --provisionalSeq.current;
    const optimistic: Turn = { id: tempId, role: 'you', text: trimmed, format: 'text', at: Date.now() };
    // The optimistic `you` turn immediately makes `agentBusy` true (derived), so
    // the composer disables and the typing indicator shows.
    setTurns((prev) => [...prev, optimistic]);
    // Tell the AgentHub host the agent is now composing (no-op elsewhere).
    signalAgentState('working');
    try {
      const entry = await sendMessage(trimmed);
      // Swap the optimistic echo for the server-stamped entry (real id). If a
      // reconcile raced us — it refetched /state after the POST reached the
      // server but before this resolved, so the snapshot already carried the real
      // turn — the entry is already in the list; just drop the echo rather than
      // create a second copy (which would also collide React keys on the id).
      setTurns((prev) =>
        prev.some((t) => t.id === entry.id)
          ? prev.filter((t) => t.id !== tempId)
          : prev.map((t) => (t.id === tempId ? entry : t)),
      );
    } catch (err) {
      // The POST failed — drop the echo and leave an error notice. That trailing
      // `error` turn clears `agentBusy` (derived), re-enabling the composer.
      const message = err instanceof Error ? err.message : String(err);
      setTurns((prev) => [
        ...prev.filter((t) => t.id !== tempId),
        { id: --provisionalSeq.current, role: 'error', text: `Couldn't send (${message}). Try again.` },
      ]);
    }
  }, []);

  const end = useCallback(async (): Promise<void> => {
    // End server-side first so the session is reliably down before we try to
    // close the tab.
    try {
      await endChat();
    } catch {
      /* the banner still shows below */
    }
    // The tab is opened for the user by its host (AgentHub, or the OS browser via
    // `jam open`), so window.close() closes it; for a hand-opened tab it's a
    // no-op and the banner stands in.
    window.close();
    showEnded('Chat ended — you can close this tab.');
  }, [showEnded]);

  return { turns, agentBusy, ended, send, end };
}
