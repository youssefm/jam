// store.test.ts — unit tests for the session store's public API: the one-deep
// long-poll handoff (park / deliver / pending), end, agent replies, and the
// shared monotonic id sequence. The store's critical sections run through an
// internal promise mutex, so even the "immediate" poll branches (pending / ended)
// resolve on a later microtask — tests await the returned promises rather than
// asserting synchronously.

import { describe, it, expect, vi } from 'vitest';

import { createStore } from './store.ts';
import type { ChatEntry } from './types.ts';

describe('createStore', () => {
  it('delivers a message to a parked poll with a monotonic positive id', async () => {
    const store = createStore();
    const { result } = store.poll();
    const entry = await store.addUserMessage('hello');

    expect(entry.id).toBeGreaterThan(0);
    expect(entry.role).toBe('you');

    await expect(result).resolves.toEqual({
      status: 'message',
      id: entry.id,
      text: 'hello',
      at: entry.at,
    });
  });

  it('holds a message with no poll parked and hands it to the next poll', async () => {
    const store = createStore();
    const entry = await store.addUserMessage('held');

    // No poll was parked, so it sits in `pending` — the next poll takes it.
    const { result } = store.poll();
    await expect(result).resolves.toEqual({
      status: 'message',
      id: entry.id,
      text: 'held',
      at: entry.at,
    });
  });

  it('wakes a parked poll on end() and resolves later polls with ended immediately', async () => {
    const store = createStore();
    const { result } = store.poll();

    await store.end();

    await expect(result).resolves.toEqual({ status: 'ended' });
    expect(store.isEnded()).toBe(true);

    const after = store.poll();
    await expect(after.result).resolves.toEqual({ status: 'ended' });
  });

  it('appends agent replies, invokes onAgentReply, and shares the id sequence', async () => {
    const replies: ChatEntry[] = [];
    const onAgentReply = vi.fn((entry: ChatEntry) => { replies.push(entry); });
    const store = createStore({ onAgentReply });

    const user = await store.addUserMessage('question');
    const agent = store.addAgentReply('<p>answer</p>', 'html');

    expect(onAgentReply).toHaveBeenCalledTimes(1);
    expect(onAgentReply).toHaveBeenCalledWith(agent);
    expect(agent.role).toBe('agent');
    expect(agent.format).toBe('html');

    // Ids are a single monotonic sequence shared across human and agent turns.
    expect(agent.id).toBe(user.id + 1);
    expect(store.chat).toEqual([user, agent]);
  });

  // Regression for the parked-poll waiter leak: a cancelled poll must not consume
  // a later message. Before the fix, the dead waiter stayed registered and got
  // settled by addUserMessage, eating the message so the next poll parked forever.
  it('does not let a cancelled poll consume a subsequently-sent message', async () => {
    const store = createStore();

    // Park a poll, then cancel it (simulating the client disconnecting).
    const parked = store.poll();
    parked.cancel();
    await expect(parked.result).resolves.toEqual({ status: 'ended' });

    // The message must fall through to `pending`, not be eaten by the dead waiter.
    const entry = await store.addUserMessage('after cancel');
    const fresh = store.poll();
    await expect(fresh.result).resolves.toEqual({
      status: 'message',
      id: entry.id,
      text: 'after cancel',
      at: entry.at,
    });
  });

  it('leaves the store intact when an immediate pending-take is later cancelled', async () => {
    const store = createStore();
    const first = await store.addUserMessage('first'); // no poll parked -> pending

    const taken = store.poll(); // takes `pending` immediately, pre-settled (never parked)
    await expect(taken.result).resolves.toMatchObject({ status: 'message', id: first.id });

    // res.on('close') fires cancel after the response flushes even for an
    // immediate take. The waiter was pre-settled and never entered `waiters`, so
    // cancel must be a clean no-op that doesn't corrupt the list — a fresh
    // round-trip still delivers.
    taken.cancel();
    taken.cancel();

    const second = await store.addUserMessage('second');
    const next = store.poll();
    await expect(next.result).resolves.toMatchObject({ status: 'message', id: second.id });
  });

  it('makes a post-delivery cancel a harmless no-op', async () => {
    const store = createStore();
    const { result, cancel } = store.poll();
    const entry = await store.addUserMessage('delivered');

    // The waiter already delivered — a late cancel (from res.on('close') after a
    // normal response flush) must not throw. It also can't change the resolved
    // value: a Promise is permanently settled after its first resolution, so this
    // asserts the "doesn't throw / stays intact" contract, not the dequeue guard
    // (the cancelled-then-message regression above covers the waiter list).
    cancel();
    cancel();

    await expect(result).resolves.toEqual({
      status: 'message',
      id: entry.id,
      text: 'delivered',
      at: entry.at,
    });
  });
});
