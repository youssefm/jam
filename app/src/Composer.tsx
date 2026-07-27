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
    <div className="jam-composer">
      {/* The slot is always reserved, so showing the button doesn't grow this
          bottom-anchored box and re-map the scrim gradient underneath it. */}
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
      <div className="jam-composer-inner">
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
