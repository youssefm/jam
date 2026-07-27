// Transcript.tsx — the scrolling conversation and its autoscroll behavior. While
// the user is following the latest turn it keeps the newest content in view, but
// the moment they scroll up to re-read something it stops moving and stays put. A
// new agent reply is revealed in full when it fits the viewport; a
// taller-than-viewport reply is anchored on the user's preceding message, so the
// question stays in view and they read down through the reply rather than being
// dropped at its end. A reload restores that same framing — long reply at its
// question, anything shorter at the bottom — but lands there instantly, before the
// first paint, so there is no scrolling to see. Agent HTML settles its height a
// frame or two after mount (images, fonts, layout), so a ResizeObserver keeps the
// view pinned through those late changes. While the bottom is off-screen the shell
// offers a way back to it — a "scroll to latest" button (see Composer.tsx), fed by
// `onAtBottomChange` and answered by the `scrollToBottom` handle below.

import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { Ref } from 'react';

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

// The human message a reply answers: the nearest preceding `.jam-you`, which is
// what we anchor a long reply on. Walking back rather than taking the immediate
// previous sibling is what handles two agent turns in a row — nothing prevents
// them, since the composer gate caps *human* messages in flight, not agent
// replies — by stopping at the other `.jam-turn` and self-anchoring. With no
// question to anchor on (that case, or a transcript that opens with a seeded
// agent message) the reply starts at its own first line.
function anchorFor(turn: HTMLElement): HTMLElement {
  let node = turn.previousElementSibling;
  while (node instanceof HTMLElement && !node.classList.contains('jam-turn')) {
    if (node.classList.contains('jam-you')) return node;
    node = node.previousElementSibling;
  }
  return turn;
}

// `behavior: 'smooth'` ignores the reduced-motion preference — unlike a CSS
// transition, nothing downgrades it for us — so every animated scroll asks. Read at
// call time, not module load: the OS setting can flip mid-session.
function resolveBehavior(behavior: ScrollBehavior): ScrollBehavior {
  if (behavior !== 'smooth') return behavior;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

// The two things the shell can ask of the transcript: jump back to the latest turn
// (the "scroll to latest" button, which the composer paints above its card), and
// take keyboard focus when that button disappears out from under it.
export type TranscriptHandle = { scrollToBottom: () => void; focus: () => void };

export function Transcript({
  turns,
  agentBusy,
  onAtBottomChange,
  ref,
}: {
  turns: TurnType[];
  agentBusy: boolean;
  // Reports the *measured* bottom-ness of the view, so the shell can offer a way
  // back down. Fired from `onScroll` — see the note there.
  onAtBottomChange: (atBottom: boolean) => void;
  ref?: Ref<TranscriptHandle>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether the view is following the latest turn. The ResizeObserver and scroll
  // handlers read it without re-subscribing, so it lives in a ref (nothing renders
  // off it, so it needs no state).
  const pinnedRef = useRef(true);
  // Whether the first layout pass has run. It takes the same reveal decision as a
  // later arrival but positions instantly rather than animating.
  const didInit = useRef(false);
  // The trailing turn we last repositioned for. `turns` is rebuilt wholesale on
  // every SSE reconcile (for why, see the `Turn` memo comment below), so array
  // identity alone would replay the reveal for a transcript that hasn't actually
  // changed — including on the reconcile that follows every reload: a scroll to
  // the bottom, or a scroll *up* to the anchor for a long trailing reply. Keying
  // on the id means a reconcile of the same transcript moves nothing. (One gap it
  // doesn't cover: `reconcile` re-sorts client-only turns to the tail, so a
  // pending error notice can outlive the reply that followed it, become the
  // trailing turn on the next reconnect, and take the human-turn branch below —
  // scrolling to the bottom from wherever the user was reading.)
  const revealedId = useRef<number | null>(null);
  // Whether the last scroll was ours rather than the user's. A programmatic
  // scroll fires `scroll` exactly like a real one, and `onScroll` reads position
  // as intent — so anchoring close to the bottom would re-pin the view we just
  // deliberately unpinned, and the ResizeObserver would then drag it down. There
  // is no flag on the event to tell them apart, so we mark our own and clear it on
  // the input that means the user took over. (Position alone can't decide it: the
  // anchored spot is legitimately within `AT_BOTTOM_SLACK` for a reply only a
  // little taller than the viewport.)
  const selfScrolled = useRef(false);

  const setPin = useCallback((value: boolean) => {
    pinnedRef.current = value;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    selfScrolled.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: resolveBehavior(behavior) });
  }, []);

  // Jumping back down is an explicit "follow the latest again": re-pin so arriving
  // turns keep moving the view, then scroll. The button that calls this clears
  // itself when the animation *lands* — `onScroll` keeps measuring throughout, even
  // though the scroll is ours — rather than when it starts.
  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: () => {
        setPin(true);
        scrollToBottom('smooth');
      },
      focus: () => scrollRef.current?.focus({ preventScroll: true }),
    }),
    [scrollToBottom, setPin],
  );

  // Bring `el`'s top just below the viewport top, so a long reply (anchored on the
  // user's message) starts at the top of the reading area.
  const scrollToTopOf = useCallback((el: HTMLElement, behavior: ScrollBehavior = 'smooth') => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    selfScrolled.current = true;
    const delta = el.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    scroll.scrollTo({ top: scroll.scrollTop + delta - READ_TOP_GAP, behavior: resolveBehavior(behavior) });
  }, []);

  // The user taking hold of the scroller — wheel or trackpad, a scrollbar drag or
  // touch, or the keyboard. From here the `scroll` events are theirs to interpret.
  const onUserScrollIntent = useCallback(() => {
    selfScrolled.current = false;
  }, []);

  // Belt and braces for scrolls with no input event of ours to hang off — a
  // find-in-page jump, whose keystrokes go to the browser's find bar rather than
  // the transcript. Once our own scroll has come to rest, anything after it is the
  // user's. Silently absent on browsers without `scrollend`, which is why the
  // intent handlers above carry the common paths rather than relying on this.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scrollend', onUserScrollIntent);
    return () => el.removeEventListener('scrollend', onUserScrollIntent);
  }, [onUserScrollIntent]);

  // A user scroll decides whether we stay pinned: near the bottom re-pins, away
  // from it unpins and the view stops following new content. Our own scrolls are
  // not intent and say nothing about where the user wants to be — they've already
  // set the pin deliberately.
  //
  // The at-bottom mirror is the exception, and takes the measurement above that
  // gate: it reports where the view *is*, not what anyone meant, so it has to keep
  // reporting through our own scrolls — those are most of the movement the button
  // cares about. Taking it from the pin instead would report intent, and the
  // callers that re-pin before an animated scroll would claim "at the bottom" a few
  // hundred milliseconds early, blinking the button out before the ride down it
  // triggered had started. It can lag when something moves the bottom without
  // moving the offset (a window resize, a turn re-rendering shorter); the next
  // scroll of any size corrects it — and the ResizeObserver below re-reports for
  // the one such move that is neither rare nor self-correcting, a growing draft
  // pushing the bottom away while the view sits still.
  const reportAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return false;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK;
    onAtBottomChange(atBottom);
    return atBottom;
  }, [onAtBottomChange]);

  const onScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const atBottom = reportAtBottom();
    if (selfScrolled.current) return;
    setPin(atBottom);
  }, [setPin, reportAtBottom]);

  // A new turn (or the first layout pass) repositions the view. The initial load
  // takes the same reveal decision as an arriving turn but lands instantly — it
  // runs before the first paint, so the page simply appears in position rather
  // than scrolling into it — and every later move animates smoothly. A user scroll
  // away opts out until they return to the bottom.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    const last = turns[turns.length - 1];
    const lastId = last?.id ?? null;
    const initial = !didInit.current;
    // Same trailing turn as last time — a reconcile, not an arrival. Stay put.
    if (!initial && lastId === revealedId.current) return;
    didInit.current = true;
    revealedId.current = lastId;
    const behavior: ScrollBehavior = initial ? 'auto' : 'smooth';
    // The user's own message (or a send error) is an explicit action — always
    // follow it to the bottom and resume pinning, even mid-read of a long reply.
    // A reload with a trailing human turn means the agent is still composing, and
    // the bottom is where to be for that too.
    if (last && last.role !== 'agent') {
      setPin(true);
      scrollToBottom(behavior);
      return;
    }
    // `initial` can't be unpinned (`pinnedRef` starts true), but say so rather
    // than rest on it: this is the line that decides whether a reading user's
    // scroll position is respected, and the first pass must always position.
    if (!initial && !pinnedRef.current) return;
    // A reply the user can't take in at once is anchored on the question that
    // prompted it, so that question stays in view above the reply's start and they
    // read down through it. A reload takes this same path, so a long reply resumes
    // at its question instead of at its tail — and unpinning here is what keeps it
    // there, since the ResizeObserver below only chases the bottom while pinned.
    //
    // The test is whether the *whole exchange* — question through the end of the
    // content — fits the viewport, not whether the reply alone is taller than it.
    // Measuring the reply alone got the boundary wrong in the damaging direction:
    // the composer clearance `.jam-transcript-inner` pads the bottom with is
    // viewport the bottom of the scroll can't use, so a reply a hair *under* the
    // viewport height took the `else` here and landed with its own opening
    // scrolled off the top. Measured anchor-to-bottom against the same
    // `READ_TOP_GAP` the anchored branch leaves, the two are pixel-continuous at
    // the threshold: "it fits" means going to the bottom already puts the question
    // exactly where anchoring would have.
    if (last) {
      const els = content.querySelectorAll<HTMLElement>('.jam-turn');
      const el = els[els.length - 1];
      if (el) {
        const anchor = anchorFor(el);
        const exchange = content.getBoundingClientRect().bottom - anchor.getBoundingClientRect().top;
        if (exchange + READ_TOP_GAP > scroll.clientHeight) {
          scrollToTopOf(anchor, behavior);
          setPin(false);
          return;
        }
      }
    }
    scrollToBottom(behavior);
  }, [turns, agentBusy, scrollToBottom, scrollToTopOf, setPin]);

  // Late height changes (agent HTML laying out after mount) keep the bottom in
  // view only while the user is still following it.
  //
  // Observed as a **border box**, which the default (content box) is not: the
  // composer's clearance lands on this element as `padding-bottom` (chrome.css),
  // and a content-box observation is by definition blind to padding. That blindness
  // was a real bug — growing a draft raised the card over the tail of the very
  // reply being answered, since the padding grew under a view that never moved.
  //
  // Known gap: this maintains the pinned mode but not the anchored one. Content
  // growing *above* the anchor slides it without moving `scrollTop`, and the
  // anchored path deliberately unpinned, so nothing corrects it. Mostly theoretical
  // — the two things that settle late are handled (fonts are already applied by
  // first paint on a reload, KaTeX is preloaded), and browser scroll anchoring
  // covers it outside Safari. What's left is an agent-authored `<img>` with no
  // intrinsic size above the anchor.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom();
      // Unpinned, the bottom just moved without a scroll event to notice it — the
      // button has to hear about it from here or it stays hidden while the bottom
      // is off-screen.
      else reportAtBottom();
    });
    observer.observe(content, { box: 'border-box' });
    return () => observer.disconnect();
  }, [scrollToBottom, reportAtBottom]);


  return (
    <div
      className="jam-transcript"
      ref={scrollRef}
      onScroll={onScroll}
      onWheel={onUserScrollIntent}
      onPointerDown={onUserScrollIntent}
      onKeyDown={onUserScrollIntent}
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

// One transcript turn. Turns are immutable and keyed by a unique monotonic id, so
// same id means same content — memoize on the id alone. The default (object
// identity) comparison would re-render on every SSE reconcile, which rebuilds the
// turn objects from a fresh /state (chat.ts `reconcile`): that re-runs
// `dangerouslySetInnerHTML`, and React DOM re-assigns `innerHTML` on any new
// wrapper object (it compares the wrapper by reference, not the HTML string) —
// wiping the highlight.js/KaTeX DOM mutations below, which the once-only mount
// effect never re-applies. Comparing by id keeps a reconciled-but-unchanged turn
// from re-rendering at all, so the typeset survives.
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
      renderMathWithin(htmlRef.current);
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
}, (previous, next) => previous.turn.id === next.turn.id);
