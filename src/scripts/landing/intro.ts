// The intro: on a first visit, while the scene loads, the page catches up with the global stream.
// A ruler of events draws itself from the left edge to the point where the scene's stream will have
// its head, and the readout counts from 000 001 up to the head. Then the ruler gives way to the scene
// in the same place. The hero is on screen from the first frame throughout (its entrance is CSS, see
// [data-enter] in global.css): the intro is the scene's loading state, never a curtain over the page.
// Shown once per session, skipped by any input; the `intro` class is set before first paint by the
// inline script in stage.astro, which also leaves it out for reduced motion.

import { formatPosition, HEAD } from "./timeline";

/** A point on the viewport, as fractions of its width and height. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface Intro {
  /** Draws the intro at `now`, its ruler ending at `head`; false once it has given way to the scene. */
  readonly tick: (now: number, head: ScreenPoint) => boolean;
  /** Resolves when the ruler has reached the head (at once when there is no intro). */
  readonly revealed: Promise<void>;
  /** How present the readout is: it comes in with the count and stays. */
  readonly presence: (now: number) => number;
}

export interface Readout {
  readonly key: HTMLElement;
  readonly value: HTMLElement;
  readonly sub: HTMLElement;
}

export interface IntroArgs {
  readonly root: HTMLElement;
  /** The ruler, in the canvas's frame. */
  readonly stream: HTMLElement;
  /** The page's readout, which counts during the intro. */
  readonly readout: Readout;
  /** Settles when the scene is drawn, or has failed, or will not load. */
  readonly ready: Promise<unknown>;
}

// The count takes about a second when everything is ready in time. Past GIVE_UP_MS it finishes anyway
// and the scene fades in whenever it arrives: the stream is a loading state, not a wait.
const COUNT_MS = 1100;
const FINISH_MS = 220;
const GIVE_UP_MS = 1700;
const LEAVE_MS = 1500; // the longest of the page's entrance animations, delays included
const PRESENCE_MS = 500;
const SEEN = "bounda-intro";

const easeOut = (t: number): number => 1 - (1 - t) ** 3;

declare global {
  interface Window {
    /** The inline script's timer that takes the intro down if this module never runs. */
    boundaIntroFallback?: number;
  }
}

export const createIntro = ({ root, stream, readout, ready }: IntroArgs): Intro => {
  clearTimeout(window.boundaIntroFallback);
  if (!root.classList.contains("intro")) {
    return { tick: () => false, revealed: Promise.resolve(), presence: () => 1 };
  }

  const start = performance.now();
  let settled = false;
  let finishFrom: number | null = null;
  let finished = false;
  let reveal: () => void = () => undefined;
  const revealed = new Promise<void>((resolve) => {
    reveal = resolve;
  });

  const loaded = Promise.all([ready, document.fonts?.ready]);
  const giveUp = new Promise((resolve) => setTimeout(resolve, GIVE_UP_MS));
  void Promise.race([loaded, giveUp]).then(() => {
    settled = true;
  });

  // Frames can stop (the tab goes to the background); the scene must come in regardless.
  setTimeout(() => {
    if (!finished) leave();
  }, GIVE_UP_MS + 1500);

  const skip = (): void => {
    settled = true;
    finishFrom ??= performance.now();
  };
  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"] as const) {
    addEventListener(type, skip, { once: true, passive: true });
  }

  const leave = (): void => {
    finished = true;
    root.classList.add("entering");
    try {
      sessionStorage.setItem(SEEN, "1");
    } catch {
      // Without storage the intro plays again on the next visit.
    }
    setTimeout(() => root.classList.remove("intro", "entering"), LEAVE_MS);
    reveal();
  };

  // Where the ruler ends follows the scene's head smoothly, from an estimate until the scene reports it.
  let headX = -1;
  let headY = -1;
  let shown = "";
  const target = formatPosition(HEAD - 1);
  const draw = (fraction: number, head: ScreenPoint): void => {
    headX = headX < 0 ? head.x : headX + (head.x - headX) * 0.2;
    headY = headY < 0 ? head.y : headY + (head.y - headY) * 0.2;
    // The stream's box is the canvas's, so fractions of the scene map onto it exactly.
    const width = stream.clientWidth || innerWidth;
    const height = stream.clientHeight || innerHeight;
    stream.style.setProperty("--head-x", `${(fraction * headX * width).toFixed(1)}px`);
    stream.style.setProperty("--head-y", `${(headY * height).toFixed(1)}px`);
    const value = formatPosition(1 + (HEAD - 2) * fraction);
    if (value !== shown) {
      if (!shown) {
        readout.key.textContent = "Global stream · catching up";
        readout.sub.textContent = `head ${target}`;
      }
      shown = value;
      readout.value.textContent = value;
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
    presence: (now) => Math.min(1, Math.max(0, now - start) / PRESENCE_MS),
    tick(now, head) {
      if (finished) return false;
      const fraction = progress(now);
      if (fraction === null) {
        draw(1, head);
        leave();
        return false;
      }
      draw(fraction, head);
      return true;
    },
  };
};
