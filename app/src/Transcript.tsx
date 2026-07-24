// Transcript.tsx — the scrolling conversation and its autoscroll behavior. While
// the user is following the latest turn it keeps the newest content in view, but
// the moment they scroll up to re-read something it stops moving and stays put. A
// new agent reply is revealed in full when it fits the viewport; a
// taller-than-viewport reply is anchored on the user's preceding message, so the
// question stays in view and they read down through the reply rather than being
// dropped at its end. Every move after the initial load animates smoothly. Agent
// HTML settles its height a frame or two after mount (images, fonts, layout), so a
// ResizeObserver keeps the view pinned through those late changes.

import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { highlightWithin } from './highlight';
import { renderMathWithin } from './math';
import { sanitizeHtml } from './sanitize';
import type { Turn as TurnType } from './state';

// Within this many pixels of the bottom counts as "at the bottom" — a slack so a
// sub-pixel rounding or a tiny overscroll doesn't unpin the view.
const AT_BOTTOM_SLACK = 80;
// Breathing room left above a long reply's first line when we scroll it to the
// top, so it doesn't sit flush under the header.
const READ_TOP_GAP = 16;

export function Transcript({ turns, agentBusy }: { turns: TurnType[]; agentBusy: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether the view is following the latest turn. The ResizeObserver and scroll
  // handlers read it without re-subscribing, so it lives in a ref (nothing renders
  // off it, so it needs no state).
  const pinnedRef = useRef(true);
  // The first layout pass just lands at the bottom (show the latest); the smart
  // reveal logic only kicks in for turns that arrive afterward.
  const didInit = useRef(false);

  const setPin = useCallback((value: boolean) => {
    pinnedRef.current = value;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Bring `el`'s top just below the viewport top, so a long reply (anchored on the
  // user's message) starts at the top of the reading area.
  const scrollToTopOf = useCallback((el: HTMLElement, behavior: ScrollBehavior = 'smooth') => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const delta = el.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    scroll.scrollTo({ top: scroll.scrollTop + delta - READ_TOP_GAP, behavior });
  }, []);

  // A user scroll decides whether we stay pinned: near the bottom re-pins, away
  // from it unpins and the view stops following new content.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setPin(el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK);
  }, [setPin]);

  // A new turn (or the typing indicator) appends and we reposition the view: the
  // initial load lands at the bottom instantly, and every later move animates
  // smoothly. A user scroll away opts out until they return to the bottom.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    if (!didInit.current) {
      didInit.current = true;
      scrollToBottom('auto');
      return;
    }
    const last = turns[turns.length - 1];
    // The user's own message (or a send error) is an explicit action — always
    // follow it to the bottom and resume pinning, even mid-read of a long reply.
    if (last && last.role !== 'agent') {
      setPin(true);
      scrollToBottom('smooth');
      return;
    }
    if (!pinnedRef.current) return;
    // A multi-page agent reply is anchored on the user's preceding message so the
    // question stays in view above the reply's start; the user then reads down to
    // the end. Everything shorter stays at the bottom.
    if (last) {
      const els = content.querySelectorAll<HTMLElement>('.jam-turn');
      const el = els[els.length - 1];
      if (el && el.getBoundingClientRect().height > scroll.clientHeight) {
        const anchor = el.previousElementSibling instanceof HTMLElement ? el.previousElementSibling : el;
        scrollToTopOf(anchor);
        setPin(false);
        return;
      }
    }
    scrollToBottom('smooth');
  }, [turns, agentBusy, scrollToBottom, scrollToTopOf, setPin]);

  // Late height changes (agent HTML laying out after mount) keep the bottom in
  // view only while the user is still following it.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);


  return (
    <div
      className="jam-transcript"
      ref={scrollRef}
      onScroll={onScroll}
      // An explicit tab stop so keyboard users can focus and scroll the log in
      // every browser (not just Chrome's implicit focusable-scroller behavior,
      // which only kicks in when the region overflows and has no focusable child).
      tabIndex={0}
      role="log"
      aria-label="Conversation"
    >
      <div className="jam-transcript-inner" ref={contentRef}>
        {turns.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}
        {agentBusy && (
          <div className="jam-typing" aria-label="Agent is composing a reply">
            <span /><span /><span />
          </div>
        )}
      </div>
    </div>
  );
}

// One transcript turn. Memoized because turns are immutable and keyed by id, so
// a new turn never re-sanitizes the ones already on screen.
const Turn = memo(function Turn({ turn }: { turn: TurnType }) {
  // Highlight code blocks and typeset any math once, right after this turn's HTML
  // lands in the DOM. Both load their libraries lazily (see highlight.ts, math.ts),
  // so these are fire-and-forget: the result paints a frame or two later. Only
  // agent HTML turns can carry a `<pre><code>` or a `.jam-math`; the ref is null
  // for the rest.
  const htmlRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (htmlRef.current) {
      void highlightWithin(htmlRef.current);
      void renderMathWithin(htmlRef.current);
    }
  }, []);

  if (turn.role === 'error') {
    return <div className="jam-error">{turn.text}</div>;
  }
  if (turn.role === 'you') {
    return <div className="jam-you">{turn.text}</div>;
  }
  // Agent: rich HTML is the point; plain text is a compact pre-wrap bubble.
  if (turn.format === 'html') {
    return (
      <article
        ref={htmlRef}
        className="jam-turn md-content"
        // Sanitized above (DOMPurify): script/handlers/js: URLs stripped, inline
        // style kept. `.jam-turn`'s `contain: paint` is what actually fences a
        // turn's layout to its box (see sanitize.ts).
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(turn.text) }}
      />
    );
  }
  return <div className="jam-turn jam-turn-text">{turn.text}</div>;
});
