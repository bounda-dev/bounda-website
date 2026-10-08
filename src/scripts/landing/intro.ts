// The intro: before the hero enters, the page catches up with the global stream. A ruler of events
// draws itself from the left edge to the point where the scene's stream has its head, the position
// riding above it from 000 001 to the head, while the scene and the fonts load. Then the ruler gives
// way to the scene in the same place and the hero enters in order. Shown once per session, skipped
// by any input; the `intro` class is set before first paint by the inline script in stage.astro,
// which also leaves it out for reduced motion.

import { formatPosition, HEAD } from "./timeline";

/** A point on the viewport, as fractions of its width and height. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface Intro {
  /** Draws the intro at `now`, its ruler ending at `head`; false once the hero has entered, or with no intro. */
  readonly tick: (now: number, head: ScreenPoint) => boolean;
  /** Resolves when the hero starts to enter (at once when there is no intro). */
  readonly revealed: Promise<void>;
  /** How far the page's own chrome is back: 0 during the intro, rising to 1 as the hero enters. */
  readonly presence: (now: number) => number;
}

export interface IntroArgs {
  readonly root: HTMLElement;
  /** The ruler and the position riding it. */
  readonly stream: HTMLElement;
  readonly count: HTMLElement;
  /** Settles when the scene is drawn, or has failed, or will not load. */
  readonly ready: Promise<unknown>;
}

// The hero is the page's largest paint, so the intro is held to about two seconds even when the
// scene is slow to arrive: past GIVE_UP_MS the hero enters and the scene fades in when it is ready.
const COUNT_MS = 1200; // the count to the head, when everything is ready in time
const FINISH_MS = 220; // the last stretch once it is
const GIVE_UP_MS = 1700;
const ENTER_MS = 1700; // the longest enter transition, delays included
const PRESENCE_MS = 600;
const SEEN = "bounda-intro";

const easeOut = (t: number): number => 1 - (1 - t) ** 3;

export const createIntro = ({ root, stream, count, ready }: IntroArgs): Intro => {
  if (!root.classList.contains("intro")) {
    return { tick: () => false, revealed: Promise.resolve(), presence: () => 1 };
  }

  const start = performance.now();
  let settled = false;
  let finishFrom: number | null = null;
  let finished = false;
  let enteredAt = 0;
  let reveal: () => void = () => undefined;
  const revealed = new Promise<void>((resolve) => {
    reveal = resolve;
  });

  const loaded = Promise.all([ready, document.fonts?.ready]);
  const giveUp = new Promise((resolve) => setTimeout(resolve, GIVE_UP_MS));
  void Promise.race([loaded, giveUp]).then(() => {
    settled = true;
  });

  // Frames can stop (the tab goes to the background); the hero and the scene must come in regardless.
  setTimeout(() => {
    if (!finished) enter();
  }, GIVE_UP_MS + 1500);

  const skip = (): void => {
    settled = true;
    finishFrom ??= performance.now();
  };
  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"] as const) {
    addEventListener(type, skip, { once: true, passive: true });
  }

  const enter = (): void => {
    finished = true;
    enteredAt = performance.now();
    root.classList.add("entering");
    try {
      sessionStorage.setItem(SEEN, "1");
    } catch {
      // Without storage the intro plays again on the next visit.
    }
    setTimeout(() => root.classList.remove("intro", "entering"), ENTER_MS);
    reveal();
  };

  // Where the ruler ends follows the scene's head smoothly, from an estimate until the scene reports it.
  let headX = -1;
  let headY = -1;
  let shown = "";
  const draw = (fraction: number, head: ScreenPoint): void => {
    headX = headX < 0 ? head.x : headX + (head.x - headX) * 0.2;
    headY = headY < 0 ? head.y : headY + (head.y - headY) * 0.2;
    const x = fraction * headX * innerWidth;
    stream.style.setProperty("--head-x", `${x.toFixed(1)}px`);
    // The position flies from the cursor like a flag, kept inside the page's margins.
    const gutter = Math.min(64, Math.max(16, innerWidth * 0.04));
    const width = count.parentElement?.offsetWidth ?? 0;
    const flag = Math.max(gutter, Math.min(x + 12, innerWidth - gutter - width));
    stream.style.setProperty("--count-x", `${flag.toFixed(1)}px`);
    stream.style.setProperty("--head-y", `${(headY * innerHeight).toFixed(1)}px`);
    const value = formatPosition(1 + (HEAD - 2) * fraction);
    if (value !== shown) {
      shown = value;
      count.textContent = value;
    }
  };

  // How much of the count is done: eased, held just short of the head while loading, then finished.
  const progress = (now: number): number | null => {
    const elapsed = now - start;
    const counted = easeOut(Math.min(1, elapsed / COUNT_MS));
    if (finishFrom === null) {
      if (settled && elapsed >= COUNT_MS) finishFrom = now;
      else
        return Math.min(
          counted,
          0.97 + 0.02 * (1 - Math.exp(-Math.max(0, elapsed - COUNT_MS) / 2000)),
        );
    }
    const t = Math.min(1, (now - finishFrom) / FINISH_MS);
    if (t >= 1) return null;
    const from = Math.min(counted, 0.99);
    return from + (1 - from) * easeOut(t);
  };

  return {
    revealed,
    presence: (now) => (enteredAt ? Math.min(1, (now - enteredAt) / PRESENCE_MS) : 0),
    tick(now, head) {
      if (finished) return false;
      const fraction = progress(now);
      if (fraction === null) {
        draw(1, head);
        enter();
        return false;
      }
      draw(fraction, head);
      return true;
    },
  };
};
