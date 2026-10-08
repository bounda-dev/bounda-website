// The intro: before the hero enters, the page catches up with the global stream. The readout counts
// from position 1 to the head while the scene and the fonts load, then the hero enters in order and
// the canvas lights up. Shown once per session, skipped by any input; the `intro` class is set
// before first paint by the inline script in stage.astro, which also leaves it out for reduced motion.

import { formatPosition, HEAD } from "./timeline";

export interface IntroReadout {
  readonly key: string;
  readonly value: string;
  readonly sub: string;
  readonly position: number;
}

export interface Intro {
  /** What the readout shows at `now` while the page catches up; null once the hero has entered. */
  readonly readout: (now: number) => IntroReadout | null;
  /** Resolves when the hero starts to enter (at once when there is no intro). */
  readonly revealed: Promise<void>;
  /** 1 as the hero starts to enter, down to 0 over the hand-over, so the readout can fade with it. */
  readonly afterglow: (now: number) => number;
}

export interface IntroArgs {
  readonly root: HTMLElement;
  /** Settles when the scene is drawn, or has failed, or will not load. */
  readonly ready: Promise<unknown>;
}

const COUNT_MS = 1200; // the count to the head, when everything is ready in time
const FINISH_MS = 220; // the last stretch once it is
const GIVE_UP_MS = 3500; // past this the hero enters anyway; the scene fades in when it arrives
const ENTER_MS = 1700; // the longest enter transition, delays included
const AFTERGLOW_MS = 500; // gone before the install command enters
const SEEN = "bounda-intro";

const easeOut = (t: number): number => 1 - (1 - t) ** 3;

export const createIntro = ({ root, ready }: IntroArgs): Intro => {
  if (!root.classList.contains("intro"))
    return { readout: () => null, revealed: Promise.resolve(), afterglow: () => 0 };

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

  const at = (fraction: number): IntroReadout => {
    const position = Math.round(1 + (HEAD - 2) * fraction);
    return {
      key: "Global stream · catching up",
      value: formatPosition(position),
      sub: "from position 1",
      position,
    };
  };

  return {
    revealed,
    afterglow: (now) => (enteredAt ? Math.max(0, 1 - (now - enteredAt) / AFTERGLOW_MS) : 0),
    readout(now) {
      if (finished) return null;
      const elapsed = now - start;
      const counted = easeOut(Math.min(1, elapsed / COUNT_MS));
      if (finishFrom === null) {
        if (settled && elapsed >= COUNT_MS) finishFrom = now;
        // Still loading: hold just short of the head, creeping, so the count never stops dead.
        else
          return at(
            Math.min(
              counted,
              0.97 + 0.02 * (1 - Math.exp(-Math.max(0, elapsed - COUNT_MS) / 2000)),
            ),
          );
      }
      const t = Math.min(1, (now - finishFrom) / FINISH_MS);
      const from = Math.min(counted, 0.99);
      if (t >= 1) {
        enter();
        return null;
      }
      return at(from + (1 - from) * easeOut(t));
    },
  };
};
