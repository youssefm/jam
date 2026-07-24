// store.ts — the session's in-memory state: the chat log, the ended flag, and
// the long-poll handoff. Deliberately thin — jam is a personal single-user
// tool; nothing touches disk, so when the `open` process dies the session dies
// with it.
//
// The handoff is one message deep. The browser composer is disabled while a turn
// is outstanding, so at most one human message is ever in flight — no FIFO
// queue, just a single `pending` slot for the race where a message arrives
// before any `poll` has parked. Mutations (deliver / poll-take / end) run inside
// a tiny mutex so a browser POST can't interleave with a poll take; each critical
// section is synchronous, so the mutex never parks the chain — a long-poll that
// has to wait does so on a registered waiter OUTSIDE the lock.
//
// `poll()` hands back a `cancel()` so the route can drop a parked waiter when its
// client disconnects. Without it a dead waiter would linger and swallow the next
// human message (settled to a closed socket), losing it and hanging the chat.

import type { ChatEntry, PollResult, ReplyFormat } from './types.ts';

// A parked long-poll: its pending resolver plus a one-shot guard.
interface Waiter {
  resolve: (payload: PollResult) => void;
  settled: boolean;
}

// A human message waiting for a poll to take it (no poll was parked when it
// arrived). Only one is ever held — the composer gate caps in-flight at one.
type PendingMessage = { id: number; text: string; at: number } | null;

export function createStore(
  { onAgentReply }: { onAgentReply?: (entry: ChatEntry) => void } = {},
) {
  const chat: ChatEntry[] = [];
  const waiters: Waiter[] = []; // parked long-polls (realistically at most one)
  let pending: PendingMessage = null;
  let nextId = 1;
  let ended = false;

  // Serialize the synchronous critical sections below. `tail` is always a
  // resolved-soon promise because every guarded fn returns synchronously. This is
  // a promise-combinator lock — chaining onto the shared `tail` is the natural
  // expression, so the await-preferring rule is silenced here.
  let tail: Promise<unknown> = Promise.resolve();
  function withLock<T>(fn: () => T): Promise<T> {
    // eslint-disable-next-line promise/prefer-await-to-then -- chaining fn onto the lock tail
    const result = tail.then(fn);
    // eslint-disable-next-line promise/prefer-await-to-then -- reset the tail, swallowing prior errors
    tail = result.then(() => {}, () => {});
    return result;
  }

  // Resolve a parked poll exactly once, dequeuing it.
  function settle(waiter: Waiter, payload: PollResult) {
    if (waiter.settled) return;
    waiter.settled = true;
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    waiter.resolve(payload);
  }

  return {
    // Browser -> server: record a human message, mirror it into the chat log, and
    // deliver it to a parked poll if one is waiting (else hold it in `pending`).
    // Returns the stamped ChatEntry so the route can echo it back for the
    // browser's optimistic-echo reconcile.
    addUserMessage(text: string): Promise<ChatEntry> {
      return withLock(() => {
        const entry: ChatEntry = { id: nextId++, role: 'you', text, format: 'text', at: Date.now() };
        chat.push(entry);
        const message = { status: 'message' as const, id: entry.id, text: entry.text, at: entry.at };
        if (waiters.length > 0) settle(waiters[0]!, message);
        // No parked poll: hold the message in the single pending slot. Overwriting
        // it is safe because the browser composer disables while a turn is
        // outstanding, capping in-flight human messages at one — so a second
        // unclaimed message can't arrive. (A misbehaving second tab could defeat
        // that; out of scope for a single-user tool.)
        else pending = { id: entry.id, text: entry.text, at: entry.at };
        return entry;
      });
    },

    // Long-poll: take the pending message immediately, or `ended`, or park until
    // a message arrives / the session ends. Returns the awaitable `result` plus a
    // `cancel()` the route calls when its client disconnects — see below.
    poll(): { result: Promise<PollResult>; cancel: () => void } {
      let resolve!: (payload: PollResult) => void;
      const result = new Promise<PollResult>((r) => { resolve = r; });
      // Shared across the deferred lock body and `cancel`. In the immediate
      // pending/ended branches it stays parked-but-pre-settled so a later cancel
      // is a clean no-op; otherwise it becomes the registered waiter.
      const waiter: Waiter = { resolve, settled: false };
      void withLock(() => {
        if (pending) {
          const message = pending;
          pending = null;
          waiter.settled = true;
          resolve({ status: 'message', ...message });
          return;
        }
        if (ended) {
          waiter.settled = true;
          resolve({ status: 'ended' });
          return;
        }
        waiters.push(waiter);
      });
      // Drop this waiter if still parked, and resolve `result` so the awaiting
      // route doesn't leak a pending promise. Runs through the lock for the same
      // consistency as the mutations. Idempotent: `settle`'s `settled` guard
      // covers a waiter that already delivered or an immediate branch that
      // pre-settled. The client socket is already closed, so the resolved value
      // is immaterial — the existing `ended` shape avoids a new type.
      const cancel = () => {
        void withLock(() => settle(waiter, { status: 'ended' }));
      };
      return { result, cancel };
    },

    // Human's "End chat": mark ended and wake every parked poll.
    end() {
      return withLock(() => {
        if (ended) return;
        ended = true;
        for (const waiter of [...waiters]) settle(waiter, { status: 'ended' });
      });
    },

    // Agent -> browser chat reply. Not part of the poll handoff, so it skips the
    // lock; it only appends to the log and broadcasts.
    addAgentReply(text: string, format: ReplyFormat): ChatEntry {
      const entry: ChatEntry = { id: nextId++, role: 'agent', text, format, at: Date.now() };
      chat.push(entry);
      onAgentReply?.(entry);
      return entry;
    },

    get chat(): ChatEntry[] {
      return chat;
    },

    isEnded(): boolean {
      return ended;
    },
  };
}
