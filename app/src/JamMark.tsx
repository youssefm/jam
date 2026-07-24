// JamMark.tsx — the jam logo: a five-bar equalizer (ink · amber · ink · amber ·
// ink) that sits still as the brand mark and pulses while the agent is composing.
// One component drives both states; `playing` toggles the animation, which the
// app binds to the agent-busy gate. The favicon (app/public/favicon.svg) is the
// same mark reduced to three bars for legibility at 16px.

// Bars in left-to-right order — the CSS animation staggers them by nth-of-type,
// so the DOM order is the visual order. Width 14, rx 7, all seated on a baseline
// at y=106; the two amber beats (bars 2 and 4) are the tallest, so the accent
// reads as the rhythm's peaks. viewBox pads 18 either side and leaves headroom
// above so a pulsing bar doesn't clip.
const BARS = [
  { x: 18, y: 52, height: 54, accent: false },
  { x: 46, y: 24, height: 82, accent: true },
  { x: 74, y: 60, height: 46, accent: false },
  { x: 102, y: 32, height: 74, accent: true },
  { x: 130, y: 48, height: 58, accent: false },
] as const;

export function JamMark({ playing = false }: { playing?: boolean }) {
  return (
    // Decorative: it always sits beside the "jam" wordmark, so hide it from the
    // accessibility tree rather than announce "jam" twice.
    <svg className={`jam-mark${playing ? ' is-playing' : ''}`} viewBox="0 0 162 118" aria-hidden="true">
      {BARS.map((bar) => (
        <rect
          key={bar.x}
          className={bar.accent ? 'jam-mark-bar jam-mark-accent' : 'jam-mark-bar'}
          x={bar.x}
          y={bar.y}
          width={14}
          height={bar.height}
          rx={7}
        />
      ))}
    </svg>
  );
}
