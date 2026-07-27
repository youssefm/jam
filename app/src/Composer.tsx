// Composer.tsx — the message input: an autosizing textarea. Enter sends,
// Shift+Enter inserts a newline (there's no send button — Enter is the only
// send). You can always type; sending is gated while the agent is busy (so
// exactly one human message is ever in flight — the gate that lets the machine
// skip an outbox entirely) or the chat has ended. The textarea stays enabled
// through a busy turn so it keeps focus and a draft can be composed while the
// reply streams; only the ended chat is read-only.
//
// It also hosts the "scroll to latest" button, shown while the transcript is
// scrolled away from the bottom. That button belongs to the transcript in spirit,
// but it lives here for two reasons: this is the only element anchored to the top
// of the composer card, so as a flow sibling above it the button stays exactly one
// gap clear however tall the textarea grows; and when the button disappears out
// from under a keyboard user, the textarea right here is where focus should land
// (or, when an ended chat has disabled it, `onFocusEscape`).
//
// Because the card floats over the transcript, it also measures its own footprint
// into `--jam-composer-clearance` (see below).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export function Composer({
  busy,
  ended,
  onSend,
  showScrollToBottom,
  onScrollToBottom,
  onFocusEscape,
}: {
  busy: boolean;
  ended: boolean;
  onSend: (text: string) => void;
  showScrollToBottom: boolean;
  onScrollToBottom: () => void;
  // Where focus goes when the scroll button vanishes under it and the textarea
  // can't take it (an ended chat's is disabled). Must be referentially stable —
  // it's a dependency of the effect whose *cleanup* moves focus, so a new identity
  // each render would fire that cleanup on every render.
  onFocusEscape: () => void;
}) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Whether the scroll-to-latest button currently holds focus. It unmounts the
  // moment the view reaches the bottom — by its own click, or because the user
  // scrolled back down while it was focused — and a focused element removed from
  // the DOM drops focus on <body> without firing blur, which would send the next
  // Tab back to the top of the page. Tracking it here lets the cleanup below hand
  // focus to the textarea instead, the same courtesy `submit` pays after a send.
  const scrollButtonFocused = useRef(false);
  useEffect(() => {
    if (!showScrollToBottom) return;
    // Captured up front for the cleanup: the textarea renders unconditionally, so
    // this node outlives every appearance of the button.
    const textarea = textareaRef.current;
    return () => {
      if (!scrollButtonFocused.current) return;
      scrollButtonFocused.current = false;
      // An ended chat disables the textarea, and a disabled control can't take
      // focus — hand it to the transcript instead, which is the only thing left to
      // do with an ended chat anyway.
      if (textarea && !textarea.disabled) textarea.focus({ preventScroll: true });
      else onFocusEscape();
    };
  }, [showScrollToBottom, onFocusEscape]);

  // Focus on open so the user can start typing immediately.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Publish how much of the window the composer covers — the card's top edge down
  // to the floor — so the transcript can pad its tail by exactly that much and no
  // more (see `.jam-transcript-inner` in chrome.css). The card is what the reader
  // must clear; the scroll-to-latest slot above it isn't counted, since it's only
  // occupied when the view is away from the bottom. Re-measured whenever the card
  // resizes, which is what the autosizing textarea does under a long draft — the
  // extra height comes out of the transcript's padding, and its pin-to-bottom
  // ResizeObserver (which watches the border box for exactly this) takes up the
  // slack. Written as an inline style on the shell, which outranks the default
  // declared there in CSS, so the cleanup below falls back to it rather than to
  // nothing.
  //
  // The observed element is the scrim box, not the card inside it — they resize
  // together (the scrim is bottom-anchored and auto-height), but the scrim sits one
  // level shallower than `.jam-transcript-inner`, which is what this write resizes.
  // A resize dirtied mid-delivery is only re-gathered in the same pass if it's
  // *deeper* than the broadcast depth; observing the card instead puts the two at
  // equal depth, and the transcript's notification gets deferred a frame with
  // `ResizeObserver loop completed with undelivered notifications` on `window`.
  // Observing the parent keeps the whole exchange inside one delivery pass.
  useLayoutEffect(() => {
    const composer = composerRef.current;
    const card = cardRef.current;
    const shell = composer?.closest<HTMLElement>('.jam-shell');
    if (!shell || !composer || !card) return;
    const measure = () => {
      const clearance = composer.getBoundingClientRect().bottom - card.getBoundingClientRect().top;
      shell.style.setProperty('--jam-composer-clearance', `${clearance}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    return () => {
      observer.disconnect();
      shell.style.removeProperty('--jam-composer-clearance');
    };
  }, []);

  // Grow the textarea to fit its content (floored at two rows by CSS min-height,
  // capped by max-height), so a long draft is visible without an inner scroll
  // until it gets genuinely tall.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || busy || ended) return;
    onSend(trimmed);
    setText('');
    // Keep focus after a click-to-send (Enter never moves it), so the user can
    // keep typing without reaching for the textarea again.
    textareaRef.current?.focus();
  }, [text, busy, ended, onSend]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <div className="jam-composer" ref={composerRef}>
      {/* The slot is always reserved so the button's arrival doesn't shift the
          composer's own layout. It can't disturb the transcript either way — see
          `.jam-scroll-latest-slot` in chrome.css. */}
      <div className="jam-scroll-latest-slot">
        {showScrollToBottom && (
          <button
            type="button"
            className="jam-scroll-latest"
            aria-label="Scroll to latest message"
            onClick={onScrollToBottom}
            onFocus={() => (scrollButtonFocused.current = true)}
            onBlur={() => (scrollButtonFocused.current = false)}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path
                d="M12 5v13m0 0 6-6m-6 6-6-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="jam-composer-inner" ref={cardRef}>
        <textarea
          ref={textareaRef}
          className="jam-input"
          placeholder={ended ? 'Chat ended' : 'Message…'}
          rows={2}
          value={text}
          disabled={ended}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
