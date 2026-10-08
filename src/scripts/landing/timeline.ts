// The story is a single number, the beat: 0 hero, 1 command, 2 event, 3 fold, 4 projection,
// 5 query, then the rebuild (REWIND to position 1, replay from 6 to 7), 7.6 rest, 8 the hand-over
// to the code section. Scroll maps to the beat; the captions, the readout and the scene read it.

import type { Theme } from "../theme";

export const clamp = (x: number, a = 0, b = 1): number => Math.min(b, Math.max(a, x));
export const seg = (b: number, a: number, z: number): number => clamp((b - a) / (z - a));
export const ease = (t: number): number => t * t * (3 - 2 * t);
export const ease5 = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
/** Rises over `fade` after `a`, falls over `fade` before `z`. */
export const inWindow = (b: number, a: number, z: number, fade = 0.14): number =>
  Math.min(seg(b, a, a + fade), 1 - seg(b, z - fade, z));

/** Plates on the stream and the position of its head. */
export const PLATES = 300;
export const HEAD = 4212;

// Near the head every plate is one position; further back each plate stands for a wider span,
// so the last plate is position 1.
const SPREAD = (HEAD - 1) / PLATES - 1;
export const positionOf = (plate: number): number => {
  if (plate <= -1) return HEAD;
  const k = clamp(plate, 0, PLATES - 1) / (PLATES - 1);
  return HEAD - (plate + 1) * (1 + SPREAD * k * k * k);
};

/** Ledger grammar: six tabular figures in two groups, `004 212`. */
export const formatPosition = (n: number): string => {
  const s = String(Math.max(0, Math.round(n))).padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
};

export interface FoldStep {
  readonly plate: number;
  readonly position: number;
  readonly name: string;
  readonly state: string;
}

/** order/7f3a's events among everyone else's, folded in order; plate -1 is the one just appended. */
export const FOLD: readonly FoldStep[] = [
  { plate: 13, position: 4198, name: "OrderCreated", state: "status new" },
  { plate: 5, position: 4206, name: "ItemAdded", state: "1 item · 129.00" },
  { plate: -1, position: 4212, name: "OrderPlaced", state: "status placed" },
];
export const FOLD_AT = [2.6, 2.82, 3.04] as const;
export const REWIND = [5.55, 5.95] as const;
export const END = 8;

/** [from beat, to beat, viewport heights of scroll it takes] */
export const SEGMENTS: readonly (readonly [number, number, number])[] = [
  [1, 2, 0.55],
  [2, 3, 0.55],
  [3, 4, 0.55],
  [4, 5, 0.55],
  [5, 5.6, 0.4],
  [5.6, 6, 0.4],
  [6, 7, 0.8],
  [7, 7.6, 0.4],
  [7.6, 7.72, 0.16],
  [7.72, 8, 0.3],
];

/** Replay progress over the stream, slightly eased so it lingers at both ends. */
export const replayProgress = (b: number): number => {
  const f = seg(b, 6, 7);
  return f + (ease5(f) - f) * 0.35;
};

/** Where the reading light is during the rewind, as a fraction of the stream from the head. */
export const rewindProgress = (b: number): number => ease(seg(b, REWIND[0], REWIND[1]));

export type StageMode = "story" | "cta" | "off";

/** What the story controller hands the scene on every frame. */
export interface Stage {
  beat: number;
  mode: StageMode;
  theme: Theme;
  time: number;
  /** Progress through the closing section, 0 entering to 1 leaving. */
  ctaProgress: number;
  /** The closing section's top edge, in viewport heights. */
  ctaTop: number;
  /** Horizontal centre of the code section's rail, as a fraction of the viewport width. */
  railX: number;
}
