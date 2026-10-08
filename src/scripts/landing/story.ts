// The scroll-driven story: turns scroll into the beat, sets the captions and the readout, and hands
// every frame to the 3D scene, which loads only where WebGL 2 is available.

import { currentTheme, onThemeChange } from "../theme";
import { createIntro, type ScreenPoint } from "./intro";
import {
  clamp,
  END,
  FOLD,
  formatPosition,
  HEAD,
  inWindow,
  PLATES,
  positionOf,
  REWIND,
  replayProgress,
  rewindProgress,
  SEGMENTS,
  type Stage,
  seg,
} from "./timeline";

interface Scene {
  readonly frame: () => void;
  readonly still: () => void;
  readonly headOnScreen: () => ScreenPoint;
}

const webgl2 = (): boolean => {
  const probe = document.createElement("canvas").getContext("webgl2");
  probe?.getExtension("WEBGL_lose_context")?.loseContext();
  return probe !== null;
};
// The scene is the heaviest part of the page, so its fetch starts before anything else here.
const loading = webgl2() ? import("./scene") : null;

const root = document.documentElement;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from the landing page`);
  return el as T;
};

const story = byId("story");
const cta = byId("cta");
const heroCopy = byId("hero-copy");
const heroFoot = byId("hero-foot");
const hud = byId("hud");
const hudKey = byId("hud-key");
const hudValue = byId("hud-value");
const hudSub = byId("hud-sub");
const hudBar = byId("hud-bar");
const callouts = byId("callouts");
const canvas = byId<HTMLCanvasElement>("stage-canvas");
const rail = byId("rail");
const railItems = [...rail.querySelectorAll<HTMLElement>("li")];
const RAIL = [
  [0.62, 1.6],
  [1.6, 2.55],
  [2.55, 3.42],
  [3.42, 4.3],
  [4.3, 5.18],
  [5.18, 8],
] as const;
const captions = [...story.querySelectorAll<HTMLElement>("[data-window]")].map((el) => {
  const [a = 0, z = 0] = (el.dataset.window ?? "").split(",").map(Number);
  return { el, a, z, last: -1 };
});

const stage: Stage = {
  beat: 0,
  mode: "story",
  theme: currentTheme(),
  time: 0,
  ctaProgress: 0,
  ctaTop: 1,
};
onThemeChange((theme) => {
  stage.theme = theme;
});

// ---- Scroll ↔ beat ----
let vh = innerHeight;
let vw = innerWidth;
const storyLength = SEGMENTS.reduce((sum, [, , length]) => sum + length, 0);
// Where the story and the closing section sit, measured when the layout changes rather than every frame.
const geometry = { storyTop: 0, storyEnd: 0, ctaTop: 0, ctaHeight: 0 };
const measure = (): void => {
  geometry.storyTop = story.offsetTop;
  geometry.storyEnd = story.offsetTop + story.offsetHeight;
  geometry.ctaTop = cta.offsetTop;
  geometry.ctaHeight = cta.offsetHeight;
};
const layout = (): void => {
  if (!reduced) story.style.height = `${Math.round((storyLength + 1) * vh)}px`;
  measure();
};
layout();
new ResizeObserver(measure).observe(document.body);
addEventListener("resize", () => {
  // Mobile browsers resize the viewport as their toolbars come and go; only a real change re-lays the story.
  if (innerWidth !== vw || Math.abs(innerHeight - vh) > 140) {
    vw = innerWidth;
    vh = innerHeight;
    layout();
  } else measure();
});

const beatAt = (y: number): number => {
  const top = geometry.storyTop;
  if (y <= top) return top > 0 ? y / top : 1;
  let v = (y - top) / vh;
  for (const [a, b, length] of SEGMENTS) {
    if (v <= length) return a + (b - a) * (v / length);
    v -= length;
  }
  return END;
};

// ---- The readout: global stream position first, in the ledger's figures ----
interface Readout {
  readonly key: string;
  readonly value: string;
  readonly sub: string;
  readonly position: number;
  readonly large: boolean;
}

const readoutAt = (b: number): Readout => {
  const at = (
    key: string,
    value: string,
    sub: string,
    position: number,
    large = false,
  ): Readout => ({
    key,
    value,
    sub,
    position,
    large,
  });
  if (b < 0.55)
    return at(
      "Global stream · head",
      formatPosition(HEAD - 1),
      "order/51c2 · OrderShipped",
      HEAD - 1,
    );
  if (b < 1.55)
    return at(
      "Command · order/7f3a",
      "PlaceOrder",
      b < 1.1 ? "checking payload" : "accepted · state new",
      HEAD - 1,
    );
  if (b < 2.5) {
    const n = b < 1.9 ? HEAD - 1 : HEAD;
    return at("Appended · order/7f3a", formatPosition(n), "OrderPlaced", n);
  }
  if (b < 3.4) {
    const k = b < 2.8 ? 0 : b < 3.02 ? 1 : 2;
    const step = FOLD[k];
    if (!step) throw new Error(`no fold step ${k}`);
    return at(
      `Apply ${k + 1} of 3 · order/7f3a`,
      formatPosition(step.position),
      `${step.name} → ${step.state}`,
      step.position,
    );
  }
  if (b < 4.3)
    return at("Projection · orders", "Upsert order/7f3a", b < 4.0 ? "6 rows" : "7 rows", HEAD);
  if (b < 5.2) return at("Query · orders", "id = '7f3a'", b < 4.6 ? "reading" : "1 row", HEAD);
  if (b < 7.25) {
    let n = HEAD;
    let rows = 7;
    let key = "Rebuild · orders";
    if (b < REWIND[0]) rows = Math.round(7 * (1 - seg(b, 5.05, 5.5)));
    else if (b < 6) {
      n = positionOf(rewindProgress(b) * PLATES - 1);
      rows = 0;
      key = "Rebuild · rewind";
    } else {
      const f = replayProgress(b);
      n = positionOf((1 - f) * PLATES - 1);
      key = "Rebuild · replay";
      rows = 0;
      for (let r = 0; r < 7; r++) if (f > (r + 0.9) / 8) rows++;
    }
    n = Math.max(1, Math.round(n));
    return at(key, formatPosition(n), `${rows} ${rows === 1 ? "row" : "rows"}`, n, b >= REWIND[0]);
  }
  return at("Global stream · head", formatPosition(HEAD), "orders · up to date", HEAD);
};

// ---- The scene and the intro ----
let scene: Scene | null = null;
const started: Promise<Scene | null> = loading
  ? loading.then(({ startScene }) => startScene({ canvas, callouts, stage })).catch(() => null)
  : Promise.resolve(null);
const intro = createIntro({
  root,
  stream: byId("intro-stream"),
  count: byId("intro-count"),
  ready: started,
});
// Where the stream's head sits in the hero until the scene can say exactly.
const estimatedHead = (): ScreenPoint =>
  innerWidth / innerHeight < 0.8 ? { x: 0.36, y: 0.76 } : { x: 0.54, y: 0.68 };

// ---- Frame ----
// Styles written every frame go through here, so an unchanged value does not dirty the page's style.
const written = new WeakMap<HTMLElement, Map<string, string>>();
const write = (el: HTMLElement, property: string, value: string): void => {
  let values = written.get(el);
  if (!values) {
    values = new Map();
    written.set(el, values);
  }
  if (values.get(property) === value) return;
  values.set(property, value);
  el.style.setProperty(property, value);
};

let shown = "";
let target = 0;
let beatSpeed = 0;
const FOLLOW = 8; // how tightly the story follows the scroll, per second
const STEP = 1 / 120;
let last = performance.now();

const read = (): number => {
  const y = scrollY;
  target = reduced ? 0 : beatAt(y);
  const ctaTop = geometry.ctaTop - y;
  const ctaInView = ctaTop < innerHeight && ctaTop + geometry.ctaHeight > 0;
  stage.mode = y < geometry.storyEnd ? "story" : ctaInView ? "cta" : "off";
  stage.ctaProgress = clamp((innerHeight - ctaTop) / (innerHeight + geometry.ctaHeight));
  stage.ctaTop = ctaTop / innerHeight;
  return y;
};

const frame = (now: number): void => {
  const dt = Math.min(0.5, Math.max(0, (now - last) / 1000));
  last = now;
  stage.time += dt;
  const y = read();
  // A critically damped spring toward the scroll: the story never jumps, and neither does its speed.
  for (let left = dt; left > 0; left -= STEP) {
    const h = Math.min(left, STEP);
    beatSpeed += (FOLLOW * FOLLOW * (target - stage.beat) - 2 * FOLLOW * beatSpeed) * h;
    stage.beat += beatSpeed * h;
  }
  if (Math.abs(target - stage.beat) < 1e-4 && Math.abs(beatSpeed) < 1e-3) {
    stage.beat = target;
    beatSpeed = 0;
  }
  const b = stage.beat;

  // The headline sinks into the scene as the story starts; the rest of the hero fades.
  if (y < innerHeight * 1.2) {
    write(heroCopy, "transform", `translate3d(0, ${(y * 0.32).toFixed(1)}px, 0)`);
    write(heroFoot, "opacity", (1 - clamp(y / (innerHeight * 0.4))).toFixed(3));
  }
  for (const c of captions) {
    const o = inWindow(b, c.a, c.z, 0.12);
    if (Math.abs(o - c.last) <= 0.002) continue;
    c.last = o;
    const shift = b < (c.a + c.z) / 2 ? (1 - o) * 22 : -(1 - o) * 22;
    c.el.style.opacity = o.toFixed(3);
    c.el.style.transform = `translate3d(0, ${shift.toFixed(1)}px, 0)`;
    // Hidden captions stay readable to assistive technology; they only stop catching the pointer.
    write(c.el, "pointer-events", o > 0.5 ? "auto" : "none");
  }
  railItems.forEach((li, i) => {
    const [a, z] = RAIL[i] ?? [0, 0];
    li.classList.toggle("on", b >= a && b < z);
    write(li, "--progress", seg(b, a, z).toFixed(3));
  });


  intro.tick(now, scene?.headOnScreen() ?? estimatedHead());
  const r = readoutAt(b);
  const key = r.key + r.value + r.sub;
  if (key !== shown) {
    shown = key;
    hudKey.textContent = r.key;
    hudValue.textContent = r.value;
    hudSub.textContent = r.sub;
  }
  hud.classList.toggle("large", r.large && stage.mode === "story");
  write(hudBar, "transform", `translateX(${((-(HEAD - r.position) / HEAD) * 240).toFixed(1)}px)`);
  let hudOpacity = stage.mode === "story" ? 1 : 0;
  // Below the wide layout the hero's actions sit where the readout is, so it waits for the story.
  if (innerWidth <= 1100) hudOpacity *= seg(b, 0.55, 0.85);
  hudOpacity *= intro.presence(now);
  write(hud, "opacity", hudOpacity.toFixed(3));
  write(callouts, "visibility", stage.mode === "story" ? "visible" : "hidden");
  write(canvas, "visibility", stage.mode === "off" ? "hidden" : "visible");

  scene?.frame();
  requestAnimationFrame(frame);
};

// ---- Showing the scene ----
const showDrawing = (): void => root.classList.add("no-webgl");
// On a slow connection the drawing stands in once the hero is in, and cross-fades to the scene later.
const late = setTimeout(() => void intro.revealed.then(showDrawing), 2500);

void started.then(async (controls) => {
  if (!controls) {
    clearTimeout(late);
    await intro.revealed;
    showDrawing();
    return;
  }
  scene = controls;
  if (reduced) {
    controls.still();
    const redraw = (): void => scene?.still();
    addEventListener("resize", redraw);
    onThemeChange(redraw);
  } else controls.frame();
  clearTimeout(late);
  // The canvas fades in with the hero, and only once its first frame is drawn.
  await intro.revealed;
  root.classList.remove("no-webgl");
  root.classList.add("webgl");
});

if (!reduced) requestAnimationFrame(frame);
