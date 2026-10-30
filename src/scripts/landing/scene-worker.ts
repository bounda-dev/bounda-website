// The scene in a worker: three.js loads, compiles and renders here, on an OffscreenCanvas, so the
// page's own thread only ever sends the beat and places the callouts (see scene-client.ts).

import { startScene, type CalloutFrame, type SceneControls } from "./scene";
import type { Stage } from "./timeline";

/** A @font-face from the page's stylesheet, so the engraved positions can be set in the mono face here. */
export interface FontSpec {
  readonly family: string;
  readonly src: string;
  readonly weight: string;
  readonly unicodeRange: string;
}

export interface InitMessage {
  readonly type: "init";
  readonly canvas: OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly coarse: boolean;
  readonly monoFamily: string;
  readonly font: FontSpec | null;
  readonly stage: Stage;
}

export interface DrawMessage {
  readonly type: "frame" | "still";
  readonly stage: Stage;
  readonly width: number;
  readonly height: number;
}

export type ToWorker = InitMessage | DrawMessage;

export type FromWorker =
  | { readonly type: "ready" }
  | { readonly type: "unsupported" }
  | {
      readonly type: "drawn";
      readonly head: { readonly x: number; readonly y: number };
      readonly callouts: CalloutFrame | null;
    };

interface WorkerScope {
  postMessage(message: FromWorker): void;
  addEventListener(type: "message", listener: (event: MessageEvent<ToWorker>) => void): void;
  readonly fonts?: FontFaceSet;
}

const scope = self as unknown as WorkerScope;
const size = { w: 1, h: 1 };
let stage: Stage | null = null;
let controls: SceneControls | null = null;
let callouts: CalloutFrame | null = null;

const webgl2 = (): boolean => {
  const probe = new OffscreenCanvas(1, 1).getContext("webgl2");
  probe?.getExtension("WEBGL_lose_context")?.loseContext();
  return probe !== null;
};

// A worker has no stylesheet, so the page's mono face is loaded here by its descriptors. Where that
// is not possible the engraving falls back to the generic monospace, which is close enough at its size.
const loadFont = async (spec: FontSpec | null): Promise<void> => {
  if (!spec || !scope.fonts || typeof FontFace === "undefined") return;
  const descriptors: FontFaceDescriptors = {};
  if (spec.weight) descriptors.weight = spec.weight;
  if (spec.unicodeRange) descriptors.unicodeRange = spec.unicodeRange;
  try {
    scope.fonts.add(await new FontFace(spec.family, spec.src, descriptors).load());
  } catch {
    // The generic monospace stands in.
  }
};

const init = async (m: InitMessage): Promise<void> => {
  size.w = m.width;
  size.h = m.height;
  if (!webgl2()) {
    scope.postMessage({ type: "unsupported" });
    return;
  }
  stage = m.stage;
  const font = loadFont(m.font);
  controls = await startScene({
    canvas: m.canvas,
    stage,
    host: {
      pixelRatio: m.pixelRatio,
      coarse: m.coarse,
      size: () => size,
      createCanvas: (width, height) => new OffscreenCanvas(width, height),
      monoFamily: m.monoFamily,
      loadFont: () => font,
      callouts: (frame) => {
        callouts = frame;
      },
    },
  });
  scope.postMessage({ type: "ready" });
};

scope.addEventListener("message", (event) => {
  const m = event.data;
  if (m.type === "init") {
    void init(m).catch(() => scope.postMessage({ type: "unsupported" }));
    return;
  }
  if (!controls || !stage) return;
  Object.assign(stage, m.stage);
  size.w = m.width;
  size.h = m.height;
  callouts = null;
  if (m.type === "frame") controls.frame();
  else controls.still();
  scope.postMessage({ type: "drawn", head: controls.headOnScreen(), callouts });
});
