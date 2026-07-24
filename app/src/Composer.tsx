// Composer.tsx — the message input: an autosizing textarea. Enter sends,
// Shift+Enter inserts a newline (there's no send button — Enter is the only
// send). You can always type; sending is gated while the agent is busy (so
// exactly one human message is ever in flight — the gate that lets the machine
// skip an outbox entirely) or the chat has ended. The textarea stays enabled
// through a busy turn so it keeps focus and a draft can be composed while the
// reply streams; only the ended chat is read-only.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export function Composer({ busy, ended, onSend }: { busy: boolean; ended: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
