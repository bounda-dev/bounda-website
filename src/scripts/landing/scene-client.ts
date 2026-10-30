// Starts the scene where it costs the page least: in a worker, on an OffscreenCanvas, where the
// browser allows it, and on the page's own thread otherwise. The page sees the same controls either
// way, and the callouts' elements are only ever touched here.

import type { ScreenPoint } from "./intro";
import type { SceneHost } from "./scene";
import type { FontSpec, FromWorker, InitMessage, ToWorker } from "./scene-worker";
import type { Stage } from "./timeline";

export interface Scene {
  readonly frame: () => void;
  readonly still: () => void;
  /** Where the head of the stream was on screen in the last frame drawn, once there is one. */
  readonly headOnScreen: () => ScreenPoint | null;
  /** Resolves once a first frame is on the canvas. */
  readonly drawn: Promise<void>;
}

export interface SceneClientArgs {
  readonly canvas: HTMLCanvasElement;
  readonly callouts: HTMLElement;
  readonly stage: Stage;
}

const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, "");

/** The --font-mono stack, and the @font-face of its first family for a worker that has no stylesheet. */
const monoFont = (): { readonly stack: string; readonly spec: FontSpec | null } => {
  const stack = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  const first = unquote(stack.split(",")[0] ?? "");
  if (!first) return { stack: "monospace", spec: null };
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a stylesheet from another origin
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const src = rule.style.getPropertyValue("src");
      if (unquote(rule.style.getPropertyValue("font-family")) !== first || !src.includes("url("))
        continue;
      return {
        stack,
        spec: {
          family: first,
          src,
          weight: rule.style.getPropertyValue("font-weight"),
          unicodeRange: rule.style.getPropertyValue("unicode-range"),
        },
      };
    }
  }
  return { stack, spec: null };
};

/** The canvas's size in CSS pixels, read when the window changes rather than every frame. */
const sizeOf = (canvas: HTMLCanvasElement): (() => { readonly w: number; readonly h: number }) => {
  const size = { w: 1, h: 1 };
  const measure = (): void => {
    size.w = canvas.clientWidth || innerWidth;
    size.h = canvas.clientHeight || innerHeight;
  };
  measure();
  addEventListener("resize", measure);
  return () => size;
};

/** Pins the callouts where the scene says, and takes down the ones it no longer places. */
const calloutSink = (root: HTMLElement): SceneHost["callouts"] => {
  const elements = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>("[data-callout]"))
    elements.set(el.dataset.callout ?? "", el);
  const foldText = root.querySelector<HTMLElement>("[data-fold-text]");
  const shown = new Set<string>();
  let fold = "";
  return (frame) => {
    if (frame.fold && foldText) {
      const key = `${frame.fold.name} ${frame.fold.position}`;
      if (key !== fold) {
        fold = key;
        foldText.firstChild?.replaceWith(`${frame.fold.name} · `);
        const position = foldText.querySelector("em");
        if (position) position.textContent = frame.fold.position;
      }
    }
    const placed = new Set<string>();
    for (const p of frame.placed) {
      const el = elements.get(p.id);
      if (!el) continue;
      placed.add(p.id);
      shown.add(p.id);
      el.classList.toggle("left", p.left);
      el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
      el.style.opacity = String(p.opacity);
    }
    for (const id of shown) {
      if (placed.has(id)) continue;
      shown.delete(id);
      const el = elements.get(id);
      if (el) el.style.opacity = "0";
    }
  };
};

const webgl2 = (): boolean => {
  const probe = document.createElement("canvas").getContext("webgl2");
  probe?.getExtension("WEBGL_lose_context")?.loseContext();
  return probe !== null;
};

const pending = (): { readonly done: Promise<void>; readonly mark: () => void } => {
  let mark: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    mark = resolve;
  });
  return { done, mark };
};

const inWorker = (
  { canvas, stage }: SceneClientArgs,
  callouts: SceneHost["callouts"],
): Promise<Scene | null> =>
  new Promise((resolve) => {
    const worker = new Worker(new URL("./scene-worker.ts", import.meta.url), { type: "module" });
    const size = sizeOf(canvas);
    const drawn = pending();
    let settled = false;
    let inflight = false;
    let head: ScreenPoint | null = null;
    const post = (type: "frame" | "still"): void => {
      const { w, h } = size();
      const message: ToWorker = { type, stage, width: w, height: h };
      worker.postMessage(message);
    };
    const scene: Scene = {
      // One frame in flight at a time: a slow worker drops frames instead of falling behind the scroll.
      frame: () => {
        if (stage.mode === "off" || inflight) return;
        inflight = true;
        post("frame");
      },
      still: () => {
        inflight = true;
        post("still");
      },
      headOnScreen: () => head,
      drawn: drawn.done,
    };
    worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
      const m = event.data;
      if (m.type === "ready") {
        settled = true;
        resolve(scene);
        return;
      }
      if (m.type === "unsupported") {
        settled = true;
        worker.terminate();
        resolve(null);
        return;
      }
      inflight = false;
      head = m.head;
      if (m.callouts) callouts(m.callouts);
      drawn.mark();
    });
    worker.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
    const { w, h } = size();
    const { stack, spec } = monoFont();
    const offscreen = canvas.transferControlToOffscreen();
    const message: InitMessage = {
      type: "init",
      canvas: offscreen,
      width: w,
      height: h,
      pixelRatio: devicePixelRatio || 1,
      coarse: matchMedia("(pointer: coarse)").matches,
      monoFamily: stack,
      font: spec,
      stage,
    };
    worker.postMessage(message, [offscreen]);
  });

const onPage = async (
  { canvas, stage }: SceneClientArgs,
  callouts: SceneHost["callouts"],
): Promise<Scene | null> => {
  if (!webgl2()) return null;
  const { startScene } = await import("./scene");
  const controls = await startScene({
    canvas,
    stage,
    host: {
      pixelRatio: devicePixelRatio || 1,
      coarse: matchMedia("(pointer: coarse)").matches,
      size: sizeOf(canvas),
      createCanvas: (width, height) => {
        const c = document.createElement("canvas");
        c.width = width;
        c.height = height;
        return c;
      },
      monoFamily: monoFont().stack,
      loadFont: (font) => document.fonts?.load(font) ?? Promise.resolve(),
      callouts,
    },
  });
  const drawn = pending();
  return {
    frame: () => {
      controls.frame();
      drawn.mark();
    },
    still: () => {
      controls.still();
      drawn.mark();
    },
    headOnScreen: controls.headOnScreen,
    drawn: drawn.done,
  };
};

/**
 * Starts the scene, or resolves to null where it cannot run (no WebGL 2) and the drawing stands in.
 * A worker whose WebGL 2 is missing (Safari 16) also leaves the drawing: its canvas is already gone.
 */
export const startScene = (args: SceneClientArgs): Promise<Scene | null> => {
  const callouts = calloutSink(args.callouts);
  const offscreen =
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    "transferControlToOffscreen" in args.canvas;
  return offscreen ? inWorker(args, callouts) : onPage(args, callouts);
};
