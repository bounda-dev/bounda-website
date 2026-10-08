// The mechanism in real-time 3D: the ⅃ as a machined monolith whose foot becomes the global stream,
// a command condensing into an event at its head, the order's state folded into a channel in the bar,
// a projection into the read model's rows, and the rebuild that rewinds to position 1 and replays.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Theme } from "../theme";
import {
  clamp,
  ease,
  ease5,
  FOLD,
  FOLD_AT,
  formatPosition,
  inWindow,
  PLATES,
  positionOf,
  REWIND,
  replayProgress,
  rewindProgress,
  type Stage,
  seg,
} from "./timeline";

export interface SceneArgs {
  readonly canvas: HTMLCanvasElement;
  readonly callouts: HTMLElement;
  readonly stage: Stage;
}

export interface SceneControls {
  /** Renders the frame for the stage's current beat and mode. */
  readonly frame: () => void;
  /** Renders the hero once, for visitors who asked for reduced motion. */
  readonly still: () => void;
}

interface Finish {
  readonly color: number;
  readonly metalness: number;
  readonly roughness: number;
}

interface Look {
  readonly accent: number;
  readonly highlight: number;
  readonly fog: number;
  readonly exposure: number;
  readonly key: number;
  readonly keyColor: number;
  readonly glyph: Finish & { readonly clearcoat: number; readonly clearcoatRoughness: number };
  readonly plate: Finish;
  readonly engraving: number;
  readonly rod: number;
  readonly row: Finish;
  readonly groove: number;
  readonly command: number;
  readonly shadow: number;
  readonly pool: readonly [number, number];
  readonly contact: number;
  readonly reflection: readonly [number, number];
  readonly trail: number;
  /** Basalt adds light; Bone tints, because added light disappears on a pale ground. */
  readonly additive: boolean;
}

// The object takes the logo's colour: satin aluminium on Basalt, black anodised on Bone.
// Ochre is the only light that means something: the live head, the folded state, the reading light.
const LOOKS: Readonly<Record<Theme, Look>> = {
  dark: {
    accent: 0xd9a04a,
    highlight: 0xf2c47c,
    fog: 0x121314,
    exposure: 1.15,
    key: 440,
    keyColor: 0xfff0dc,
    glyph: {
      color: 0xb2aea6,
      metalness: 1,
      roughness: 0.32,
      clearcoat: 0.5,
      clearcoatRoughness: 0.12,
    },
    plate: { color: 0xc0bcb3, metalness: 1, roughness: 0.3 },
    engraving: 0x1b1c1e,
    rod: 0xa8a49b,
    row: { color: 0x62615d, metalness: 1, roughness: 0.4 },
    groove: 0x050505,
    command: 0xe6e0d3,
    shadow: 0.62,
    pool: [0x2b2925, 0.9],
    contact: 0.8,
    reflection: [0.28, 0.2],
    trail: 0.55,
    additive: true,
  },
  light: {
    accent: 0xb07114,
    highlight: 0xc98626,
    fog: 0xeceae4,
    exposure: 1.0,
    key: 260,
    keyColor: 0xfff3e2,
    glyph: {
      color: 0x1e1d1b,
      metalness: 0.55,
      roughness: 0.5,
      clearcoat: 1,
      clearcoatRoughness: 0.24,
    },
    plate: { color: 0x2a2825, metalness: 0.6, roughness: 0.38 },
    engraving: 0xd6d0c4,
    rod: 0x5f5b53,
    row: { color: 0xcbc7be, metalness: 1, roughness: 0.36 },
    groove: 0x0a0a0a,
    command: 0x1a1916,
    shadow: 0.28,
    pool: [0xffffff, 0.55],
    contact: 0.55,
    reflection: [0.1, 0.045],
    trail: 0.9,
    additive: false,
  },
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const outCubic = (t: number): number => 1 - (1 - t) ** 3;
const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const seeded = (seed: number): (() => number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** A world-space position varying for patched shaders. */
const withWorldPosition = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vWorld;")
    .replace(
      "#include <project_vertex>",
      `#include <project_vertex>
      { vec4 w4 = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        w4 = instanceMatrix * w4;
      #endif
        vWorld = (modelMatrix * w4).xyz; }`,
    );
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <common>",
    "#include <common>\nvarying vec3 vWorld;",
  );
};

const canvasTexture = (
  width: number,
  height: number,
  draw: (g: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture => {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d");
  if (g) draw(g);
  return new THREE.CanvasTexture(c);
};

const radialTexture = (): THREE.CanvasTexture => {
  const t = canvasTexture(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.25, "rgba(255,255,255,.45)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
  });
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

// Studios of softboxes and strips, no HDRI: a dark stage for Basalt, a pale cyclorama for Bone.
const buildStudio = (pmrem: THREE.PMREMGenerator, light: boolean): THREE.Texture => {
  const s = new THREE.Scene();
  const linear = (r: number, g: number, b: number): THREE.Color =>
    new THREE.Color().setRGB(r, g, b);
  s.add(
    new THREE.Mesh(
      new THREE.BoxGeometry(44, 44, 44),
      new THREE.MeshBasicMaterial({
        color: light ? linear(0.36, 0.345, 0.32) : linear(0, 0, 0),
        side: THREE.BackSide,
      }),
    ),
  );
  const panel = (
    w: number,
    h: number,
    color: number,
    k: number,
    at: readonly [number, number, number],
    look: readonly [number, number, number] = [0, 1.4, 0],
  ): void => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(k),
        side: THREE.DoubleSide,
      }),
    );
    m.position.set(...at);
    m.lookAt(...look);
    s.add(m);
  };
  const wallGeometry = new THREE.PlaneGeometry(44, 18, 1, 12);
  const wp = wallGeometry.attributes.position;
  const colors: number[] = [];
  if (wp) {
    for (let i = 0; i < wp.count; i++) {
      const t = (wp.getY(i) + 9) / 18;
      const c = light ? 0.3 + 1.3 * t * t : 0.03 + 2.1 * t * t;
      colors.push(c * 1.04, c, c * 0.94);
    }
  }
  wallGeometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const wall = new THREE.Mesh(
    wallGeometry,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  );
  wall.position.set(0, 7, 19);
  wall.lookAt(0, 7, 0);
  s.add(wall);
  if (light) {
    panel(14, 8, 0xfff4e6, 4.2, [-8, 11, 7]); // key softbox, high front left
    panel(22, 12, 0xffffff, 2.4, [0, 15, -1], [0, 0, 0]); // overhead
    panel(2.6, 14, 0xffffff, 2.6, [-14, 4, -1]); // left strip
    panel(0.8, 14, 0xffffff, 2.8, [12, 4, -5]); // rim strip
    panel(40, 0.7, 0xffffff, 2.6, [0, -2.2, 15.5]);
    panel(40, 6, 0xf1ece2, 0.7, [0, -7, 14]); // floor bounce, bone
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshBasicMaterial({ color: linear(0.5, 0.48, 0.44), side: THREE.DoubleSide }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.6;
    s.add(floor);
  } else {
    panel(14, 8, 0xfff2e2, 5.0, [-8, 11, 7]); // key softbox, warm
    panel(18, 9, 0xffffff, 1.3, [0, 15, -1], [0, 0, 0]); // overhead
    panel(2.6, 14, 0xffffff, 2.0, [-14, 4, -1]); // left strip: the stream's faces
    panel(0.8, 14, 0xeef0f4, 3.4, [12, 4, -5]); // rim strip, back right
    panel(22, 0.35, 0xd9a04a, 0.7, [-2, 0.8, -16]); // a low ochre line on the horizon
    panel(40, 0.7, 0xf6f1e8, 3.1, [0, -2.2, 15.5]);
    panel(40, 6, 0xf6f1e8, 0.09, [0, -7, 14]);
  }
  return pmrem.fromScene(s, 0.02).texture;
};

export const startScene = async ({
  canvas,
  callouts,
  stage,
}: SceneArgs): Promise<SceneControls> => {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  const mobile = matchMedia("(pointer: coarse)").matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  let look = LOOKS[stage.theme];
  const accent = new THREE.Color(look.accent);
  const highlight = new THREE.Color(look.highlight);

  const scene = new THREE.Scene();
  const fog = new THREE.Fog(look.fog, 10, 40);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);

  // Each mode's studio is built the first time that mode is shown.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const studios: Partial<Record<Theme, THREE.Texture>> = {};
  const studio = (theme: Theme): THREE.Texture => {
    const built = studios[theme] ?? buildStudio(pmrem, theme === "light");
    studios[theme] = built;
    return built;
  };

  const key = new THREE.SpotLight(look.keyColor, look.key, 0, 0.44, 0.8, 2);
  key.position.set(-5.5, 9.5, 6.5);
  key.target.position.set(-0.4, 0.6, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 5;
  key.shadow.camera.far = 24;
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 4;
  scene.add(key, key.target);
  const readingLight = new THREE.PointLight(accent, 0, 2.6, 2);
  scene.add(readingLight);

  // Uniforms shared by the patched materials: the reading light along the stream and the accent.
  const U = {
    cursor: { value: -100 },
    cursorOn: { value: 0 },
    direction: { value: 1 },
    decay: { value: 2 },
    trail: { value: look.trail },
    accent: { value: accent.clone() },
  };

  const fadeReflection = <M extends THREE.MeshStandardMaterial>(
    material: M,
    opacity: number,
  ): M => {
    material.transparent = true;
    material.opacity = opacity;
    material.depthWrite = false;
    material.onBeforeCompile = (shader) => {
      withWorldPosition(shader);
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        "#include <dithering_fragment>\n gl_FragColor.a *= smoothstep(-1.5, 0.0, vWorld.y);",
      );
    };
    return material;
  };

  // Everything that glows, re-tinted and re-blended when the mode changes.
  const glowTexture = radialTexture();
  const glows: {
    readonly material: THREE.Material & { color?: THREE.Color };
    readonly tone: "accent" | "highlight";
  }[] = [];
  const glowShaders: THREE.ShaderMaterial[] = [];
  const glowShader = (): THREE.ShaderMaterial => {
    const m = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: accent.clone() }, uOpacity: { value: 0 } },
      vertexShader:
        "varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
      // Brightest where a tube faces the camera, so a thin line reads as light, not as a fat tube.
      fragmentShader:
        "uniform vec3 uColor; uniform float uOpacity; varying vec3 vN; varying vec3 vV; void main(){ float f = abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(uColor, pow(f, 2.2) * uOpacity); }",
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    glowShaders.push(m);
    return m;
  };
  const spriteMaterial = (tone: "accent" | "highlight"): THREE.SpriteMaterial => {
    const m = new THREE.SpriteMaterial({
      map: glowTexture,
      color: (tone === "highlight" ? highlight : accent).clone(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
      opacity: 0,
      fog: false,
    });
    glows.push({ material: m, tone });
    return m;
  };

  // Brushed finish: fine vertical streaks in the roughness of the faces, like a machined part.
  const brushed = canvasTexture(512, 512, (g) => {
    const r = seeded(11);
    g.fillStyle = "#c4c4c4";
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 2600; i++) {
      const v = (172 + r() * 66) | 0;
      g.globalAlpha = 0.1 + r() * 0.26;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(r() * 512, 0, 0.5 + r() * 1.6, 512);
    }
  });
  brushed.wrapS = brushed.wrapT = THREE.RepeatWrapping;
  brushed.repeat.set(1.4, 1);
  brushed.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  // ---- The ⅃: the symbol's module (bar 10, foot 6 by 25, tail 8) extruded and chamfered ----
  const K = 3.2 / 65;
  const shape = new THREE.Shape();
  const outline: readonly (readonly [number, number])[] = [
    [58, 7],
    [68, 7],
    [68, 72],
    [58, 72],
    [58, 64],
    [33, 64],
    [33, 58],
    [58, 58],
  ];
  outline.forEach(([x, y], i) => {
    const px = (x - 63) * K;
    const py = (72 - y) * K;
    if (i) shape.lineTo(px, py);
    else shape.moveTo(px, py);
  });
  shape.closePath();
  const DEPTH = 0.52;
  const BEVEL = 0.03;
  const glyphGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: DEPTH,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL,
    bevelOffset: -BEVEL,
    bevelSegments: 1,
    curveSegments: 1,
  });
  glyphGeometry.translate(0, 0, -DEPTH / 2);
  const FRONT = DEPTH / 2 + BEVEL;
  // ExtrudeGeometry groups: 0 the faces, brushed; 1 the sides, plain satin.
  const faces = new THREE.MeshPhysicalMaterial({
    roughnessMap: brushed,
    anisotropy: 0.35,
    anisotropyRotation: Math.PI / 2,
  });
  const sides = new THREE.MeshPhysicalMaterial();
  const glyph = new THREE.Mesh(glyphGeometry, [faces, sides]);
  glyph.castShadow = true;
  glyph.receiveShadow = true;
  scene.add(glyph);

  const ROD_Y = 11 * K;
  const FOOT_END = (33 - 63) * K;
  const BAR_LEFT = (58 - 63) * K;
  const CRADLE = v3(BAR_LEFT - 0.23, (72 - 58) * K + 0.215, 0);
  const CHANNEL_BASE = 0.95;
  const CHANNEL_HEIGHT = 2.0;

  // The channel machined into the bar: the aggregate's state, lit as it is folded.
  const grooveMaterial = new THREE.MeshBasicMaterial({ color: look.groove });
  const groove = new THREE.Mesh(new THREE.PlaneGeometry(0.034, CHANNEL_HEIGHT), grooveMaterial);
  groove.position.set(0, CHANNEL_BASE + CHANNEL_HEIGHT / 2, FRONT + 0.0015);
  const fillGeometry = new THREE.PlaneGeometry(0.016, CHANNEL_HEIGHT);
  fillGeometry.translate(0, CHANNEL_HEIGHT / 2, 0);
  const fillMaterial = new THREE.MeshBasicMaterial({
    color: accent.clone(),
    toneMapped: false,
    transparent: true,
  });
  const fill = new THREE.Mesh(fillGeometry, fillMaterial);
  fill.position.set(0, CHANNEL_BASE, FRONT + 0.003);
  const haloTexture = canvasTexture(64, 4, (g) => {
    const gr = g.createLinearGradient(0, 0, 64, 0);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(0.42, "rgba(255,255,255,.35)");
    gr.addColorStop(0.5, "rgba(255,255,255,1)");
    gr.addColorStop(0.58, "rgba(255,255,255,.35)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 4);
  });
  haloTexture.colorSpace = THREE.SRGBColorSpace;
  const haloGeometry = new THREE.PlaneGeometry(0.3, CHANNEL_HEIGHT);
  haloGeometry.translate(0, CHANNEL_HEIGHT / 2, 0);
  const haloMaterial = new THREE.MeshBasicMaterial({
    map: haloTexture,
    color: accent.clone(),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  glows.push({ material: haloMaterial, tone: "accent" });
  const halo = new THREE.Mesh(haloGeometry, haloMaterial);
  halo.position.set(0, CHANNEL_BASE, FRONT + 0.006);
  const fillTip = new THREE.Sprite(spriteMaterial("highlight"));
  fillTip.scale.set(0.34, 0.34, 1);
  scene.add(groove, fill, halo, fillTip);

  // ---- The global stream: plates threaded on a rod that continues the foot ----
  const HEAD = FOOT_END - 0.245;
  const SPACING = 0.24;
  const TAIL = HEAD - PLATES * SPACING;
  const plateGeometry = new RoundedBoxGeometry(0.03, 0.4, 0.4, 2, 0.01);
  const streamGeometry = plateGeometry.clone();
  const lit = new THREE.InstancedBufferAttribute(new Float32Array(PLATES), 1);
  lit.setUsage(THREE.DynamicDrawUsage);
  streamGeometry.setAttribute("aLit", lit);
  const plateMaterial = new THREE.MeshStandardMaterial();
  plateMaterial.onBeforeCompile = (shader) => {
    withWorldPosition(shader);
    Object.assign(shader.uniforms, {
      uCursor: U.cursor,
      uCursorOn: U.cursorOn,
      uDirection: U.direction,
      uDecay: U.decay,
      uTrail: U.trail,
      uAccent: U.accent,
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aLit; varying float vLit;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLit = aLit;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uCursor; uniform float uCursorOn; uniform float uDirection; uniform float uDecay; uniform float uTrail; uniform vec3 uAccent; varying float vLit;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        float d = (uCursor - vWorld.x) * uDirection;
        float wake = d > 0.0 ? exp(-d * uDecay) : exp(d * 12.0);
        totalEmissiveRadiance += uAccent * (wake * uCursorOn * uTrail + vLit);`,
      );
  };
  const plates = new THREE.InstancedMesh(streamGeometry, plateMaterial, PLATES);
  plates.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  plates.castShadow = true;
  plates.frustumCulled = false;
  scene.add(plates);

  // Engraved positions on every tenth plate, from one canvas atlas.
  const MAJORS: number[] = [];
  for (let i = 1; i < PLATES; i += 10) MAJORS.push(i);
  const atlasCanvas = document.createElement("canvas");
  atlasCanvas.width = 1024;
  atlasCanvas.height = 512;
  const atlas = new THREE.CanvasTexture(atlasCanvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const monoFamily =
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
    "monospace";
  const atlasFont = `500 44px ${monoFamily}`;
  const drawAtlas = (): void => {
    const g = atlasCanvas.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, 1024, 512);
    g.fillStyle = g.strokeStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 1.6;
    g.lineJoin = "round";
    g.font = atlasFont;
    MAJORS.forEach((plate, k) => {
      const text = formatPosition(positionOf(plate));
      const x = (k % 4) * 256 + 128;
      const y = Math.floor(k / 4) * 64 + 34;
      g.fillText(text, x, y);
      g.strokeText(text, x, y);
    });
    atlas.needsUpdate = true;
  };
  drawAtlas();
  document.fonts?.load(atlasFont).then(drawAtlas, () => undefined);
  const labelGeometry = new THREE.PlaneGeometry(0.46, 0.115);
  const cells = new THREE.InstancedBufferAttribute(new Float32Array(MAJORS.length * 4), 2);
  MAJORS.forEach((_, k) => {
    for (const side of [0, 1])
      cells.setXY(k * 2 + side, (k % 4) * 0.25, 1 - (Math.floor(k / 4) + 1) * 0.125);
  });
  labelGeometry.setAttribute("aCell", cells);
  const labelMaterial = new THREE.MeshStandardMaterial({
    metalness: 0.3,
    roughness: 0.85,
    map: atlas,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  labelMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aCell;")
      .replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\n#ifdef USE_MAP\n vMapUv = vMapUv * vec2(0.25, 0.125) + aCell;\n#endif",
      );
  };
  const labels = new THREE.InstancedMesh(labelGeometry, labelMaterial, MAJORS.length * 2);
  labels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  labels.frustumCulled = false;
  scene.add(labels);

  const matrix = new THREE.Matrix4();
  const identity = new THREE.Quaternion();
  const at = new THREE.Vector3();
  const size = new THREE.Vector3();
  const faceLeft = new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), -Math.PI / 2);
  const faceRight = new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), Math.PI / 2);
  const unit = v3(1, 1, 1);
  const plateX = (plate: number, shift = 1): number => HEAD - (plate + shift) * SPACING;
  let laidOut = -1;
  const layoutPlates = (shift: number): void => {
    if (Math.abs(shift - laidOut) < 1e-5) return;
    laidOut = shift;
    for (let i = 0; i < PLATES; i++) {
      const major = i % 10 === 1;
      at.set(plateX(i, shift), ROD_Y, 0);
      size.set(1, major ? 1.32 : 1, major ? 1.32 : 1);
      matrix.compose(at, identity, size);
      plates.setMatrixAt(i, matrix);
    }
    MAJORS.forEach((plate, k) => {
      const x = plateX(plate, shift);
      at.set(x - 0.0175, ROD_Y + 0.15, 0);
      matrix.compose(at, faceLeft, unit);
      labels.setMatrixAt(k * 2, matrix);
      at.set(x + 0.0175, ROD_Y + 0.15, 0);
      matrix.compose(at, faceRight, unit);
      labels.setMatrixAt(k * 2 + 1, matrix);
    });
    plates.instanceMatrix.needsUpdate = true;
    labels.instanceMatrix.needsUpdate = true;
  };
  const rodLength = FOOT_END - (TAIL - 0.5);
  const rodMaterial = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.35 });
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, rodLength, 10), rodMaterial);
  rod.rotation.z = Math.PI / 2;
  rod.position.set(FOOT_END - rodLength / 2, ROD_Y, 0);
  const rodCap = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 24), rodMaterial);
  rodCap.rotation.z = Math.PI / 2;
  rodCap.position.set(TAIL - 0.5, ROD_Y, 0);
  scene.add(rod, rodCap);

  // The event born from the command
  const eventMaterial = new THREE.MeshStandardMaterial({
    emissive: accent.clone(),
    emissiveIntensity: 0,
  });
  const event = new THREE.Mesh(plateGeometry, eventMaterial);
  event.castShadow = true;
  const eventGlow = new THREE.Sprite(spriteMaterial("accent"));
  eventGlow.scale.set(0.95, 0.95, 1);
  scene.add(event, eventGlow);

  // The command: an intention, drawn as edges only
  const command = new THREE.Group();
  const commandBox = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  const commandEdges = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0,
    toneMapped: false,
  });
  const commandFill = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
  });
  command.add(
    new THREE.Mesh(commandBox, commandFill),
    new THREE.LineSegments(new THREE.EdgesGeometry(commandBox), commandEdges),
  );
  scene.add(command);
  const commandColor = new THREE.Color();

  // ---- Read model: seven rows of three cells, past the boundary ----
  const ROWS = 7;
  const COLUMNS = [0.66, 0.58, 0.4] as const;
  const ROW_X = 0.62;
  const ROW_Y = 1.0;
  const ROW_STEP = 0.25;
  const ROW_THICKNESS = 0.07;
  const ROW_DEPTH = 0.5;
  const rowGeometry = new THREE.BoxGeometry(1, 1, 1);
  const rowGlow = new THREE.InstancedBufferAttribute(new Float32Array(ROWS * 3), 1);
  rowGlow.setUsage(THREE.DynamicDrawUsage);
  rowGeometry.setAttribute("aGlow", rowGlow);
  const rowMaterial = new THREE.MeshStandardMaterial();
  rowMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uAccent = U.accent;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float aGlow; varying float vGlow;",
      )
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = aGlow;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlow; uniform vec3 uAccent;")
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += uAccent * vGlow * 0.9;",
      );
  };
  const rows = new THREE.InstancedMesh(rowGeometry, rowMaterial, ROWS * 3);
  rows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rows.castShadow = true;
  rows.frustumCulled = false;
  scene.add(rows);
  const cellX: number[] = [];
  {
    let x = ROW_X;
    for (const w of COLUMNS) {
      cellX.push(x);
      x += w + 0.05;
    }
  }
  const ROW_END = (cellX[2] ?? 0) + COLUMNS[2];
  const rowY = (r: number): number => ROW_Y + r * ROW_STEP;

  // A line of light that draws itself along a path, with a glow around it.
  const SEGMENTS = 160;
  const RADIAL = 6;
  const PER_SEGMENT = RADIAL * 6;
  const traceCores: THREE.MeshBasicMaterial[] = [];
  interface Trace {
    readonly curve: THREE.Curve<THREE.Vector3>;
    readonly set: (from: number, to: number, opacity: number) => void;
  }
  const makeTrace = (
    curve: THREE.Curve<THREE.Vector3>,
    radius = 0.007,
    glowRadius = 0.045,
  ): Trace => {
    const core = new THREE.MeshBasicMaterial({
      color: highlight.clone(),
      transparent: true,
      opacity: 0,
      toneMapped: false,
      depthWrite: false,
      fog: false,
    });
    traceCores.push(core);
    const glowMaterial = glowShader();
    const line = new THREE.Mesh(
      new THREE.TubeGeometry(curve, SEGMENTS, radius, RADIAL, false),
      core,
    );
    const glow = new THREE.Mesh(
      new THREE.TubeGeometry(curve, SEGMENTS, glowRadius, RADIAL, false),
      glowMaterial,
    );
    line.visible = glow.visible = false;
    scene.add(line, glow);
    return {
      curve,
      set(from, to, opacity) {
        const a = Math.floor(clamp(from) * SEGMENTS);
        const z = Math.ceil(clamp(to) * SEGMENTS);
        const on = opacity > 0.001 && z > a;
        line.visible = glow.visible = on;
        if (!on) return;
        line.geometry.setDrawRange(a * PER_SEGMENT, (z - a) * PER_SEGMENT);
        glow.geometry.setDrawRange(a * PER_SEGMENT, (z - a) * PER_SEGMENT);
        core.opacity = 0.95 * opacity;
        const u = glowMaterial.uniforms.uOpacity;
        if (u) u.value = 0.55 * opacity;
      },
    };
  };
  // The projection over the boundary, and the query beam from the far side
  const arc = new THREE.CubicBezierCurve3(
    v3(HEAD, ROD_Y + 0.22, 0),
    v3(HEAD + 0.1, 4.5, 0.1),
    v3(0.3, 4.5, 0.1),
    v3(ROW_X - 0.02, rowY(6), 0),
  );
  const projection = makeTrace(arc);
  const QUERY_FROM = v3(5.8, rowY(6), 0.9);
  const QUERY_TO = v3(ROW_END + 0.02, rowY(6), 0);
  const query = makeTrace(new THREE.LineCurve3(QUERY_FROM, QUERY_TO), 0.006, 0.04);
  // The replay: one arc per row, from where the reading light is when it fires, over the bar, onto the row.
  const fireAt = (r: number): number => (r + 0.05) / 8;
  const landAt = (r: number): number => (r + 0.47) / 8;
  const replays: Trace[] = [];
  for (let r = 0; r < ROWS; r++) {
    const sx = lerp(TAIL, HEAD, fireAt(r));
    const points = [
      v3(sx, ROD_Y + 0.22, 0),
      v3(lerp(sx, -0.8, 0.5), 3.3, 0),
      v3(-0.7, 4.1, 0),
      v3(0.5, 4.15, 0),
      v3(ROW_X + 0.12, rowY(r) + 0.9, 0),
      v3(ROW_X + 0.12, rowY(r) + ROW_THICKNESS / 2 + 0.01, 0),
    ];
    replays.push(makeTrace(new THREE.CatmullRomCurve3(points, false, "centripetal"), 0.012, 0.075));
  }

  const cursor = new THREE.Sprite(spriteMaterial("highlight"));
  cursor.scale.set(0.7, 0.7, 1);
  const pulse = new THREE.Sprite(spriteMaterial("highlight"));
  pulse.scale.set(0.42, 0.42, 1);
  scene.add(cursor, pulse);

  // The fold: each of order/7f3a's events sends light along the rod and the foot into the channel.
  const foldPaths = FOLD.map((step) => {
    const path = new THREE.CurvePath<THREE.Vector3>();
    const x0 = step.plate < 0 ? HEAD : plateX(step.plate);
    const points = [
      v3(x0, ROD_Y + 0.02, 0.05),
      v3(FOOT_END, ROD_Y, FRONT + 0.04),
      v3(BAR_LEFT - 0.02, ROD_Y, FRONT + 0.04),
      v3(0, CHANNEL_BASE, FRONT + 0.04),
    ];
    for (let k = 0; k < 3; k++) {
      const from = points[k];
      const to = points[k + 1];
      if (from && to) path.add(new THREE.LineCurve3(from, to));
    }
    return path;
  });

  // ---- Floor: contact shadow, cast shadow, a soft pool and a faded reflection ----
  const shadowMaterial = new THREE.ShadowMaterial({ opacity: look.shadow });
  const shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), shadowMaterial);
  shadowFloor.rotation.x = -Math.PI / 2;
  shadowFloor.position.y = 0.001;
  shadowFloor.receiveShadow = true;
  shadowFloor.renderOrder = 3;
  const poolMaterial = new THREE.MeshBasicMaterial({
    map: radialTexture(),
    transparent: true,
    depthWrite: false,
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), poolMaterial);
  pool.rotation.x = -Math.PI / 2;
  pool.scale.set(15, 9, 1);
  pool.position.set(-0.4, 0, 0.4);
  pool.renderOrder = 1;
  const contactMaterial = new THREE.MeshBasicMaterial({
    map: canvasTexture(128, 128, (g) => {
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, "rgba(0,0,0,1)");
      gr.addColorStop(0.3, "rgba(0,0,0,.6)");
      gr.addColorStop(0.65, "rgba(0,0,0,.15)");
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
    }),
    color: 0x000000,
    transparent: true,
    depthWrite: false,
  });
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), contactMaterial);
  contact.rotation.x = -Math.PI / 2;
  contact.scale.set(1.25, 1.15, 1);
  contact.position.set(0, 0.002, 0);
  contact.renderOrder = 4;
  scene.add(pool, shadowFloor, contact);
  const mirror = new THREE.Group();
  mirror.scale.y = -1;
  scene.add(mirror);
  const glyphReflection = fadeReflection(new THREE.MeshPhysicalMaterial(), look.reflection[0]);
  const reflectedGlyph = new THREE.Mesh(glyphGeometry, glyphReflection);
  reflectedGlyph.renderOrder = 2;
  const plateReflection = fadeReflection(new THREE.MeshStandardMaterial(), look.reflection[1]);
  const reflectedPlates = new THREE.InstancedMesh(plateGeometry, plateReflection, PLATES);
  reflectedPlates.instanceMatrix = plates.instanceMatrix;
  reflectedPlates.frustumCulled = false;
  reflectedPlates.renderOrder = 2;
  const reflectedEvent = new THREE.Mesh(plateGeometry, plateReflection);
  reflectedEvent.renderOrder = 2;
  mirror.add(reflectedGlyph, reflectedPlates, reflectedEvent);

  // ---- The mode: swap the studio and the finishes, keep the geometry and the choreography ----
  let shownTheme: Theme | null = null;
  const applyTheme = (theme: Theme): void => {
    if (theme === shownTheme) return;
    shownTheme = theme;
    look = LOOKS[theme];
    accent.setHex(look.accent);
    highlight.setHex(look.highlight);
    U.accent.value.copy(accent);
    U.trail.value = look.trail;
    renderer.toneMappingExposure = look.exposure;
    scene.environment = studio(theme);
    fog.color.setHex(look.fog);
    key.color.setHex(look.keyColor);
    readingLight.color.copy(accent);
    for (const m of [faces, sides, glyphReflection]) {
      m.color.setHex(look.glyph.color);
      m.metalness = look.glyph.metalness;
      m.roughness = look.glyph.roughness;
      m.clearcoat = look.glyph.clearcoat;
      m.clearcoatRoughness = look.glyph.clearcoatRoughness;
    }
    for (const m of [plateMaterial, eventMaterial, plateReflection]) {
      m.color.setHex(look.plate.color);
      m.metalness = look.plate.metalness;
      m.roughness = look.plate.roughness;
    }
    eventMaterial.emissive.copy(accent);
    labelMaterial.color.setHex(look.engraving);
    rodMaterial.color.setHex(look.rod);
    rowMaterial.color.setHex(look.row.color);
    rowMaterial.metalness = look.row.metalness;
    rowMaterial.roughness = look.row.roughness;
    grooveMaterial.color.setHex(look.groove);
    commandColor.setHex(look.command);
    commandFill.color.copy(highlight);
    for (const m of traceCores) m.color.copy(look.additive ? highlight : accent);
    const blending = look.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    for (const { material, tone } of glows) {
      material.color?.copy(tone === "highlight" && look.additive ? highlight : accent);
      material.blending = blending;
      material.needsUpdate = true;
    }
    for (const m of glowShaders) {
      m.uniforms.uColor?.value.copy(accent);
      m.blending = blending;
      m.needsUpdate = true;
    }
    plates.castShadow = theme === "dark";
    shadowMaterial.opacity = look.shadow;
    poolMaterial.color.setHex(look.pool[0]);
    poolMaterial.opacity = look.pool[1];
    contactMaterial.opacity = look.contact;
    glyphReflection.opacity = look.reflection[0];
    plateReflection.opacity = look.reflection[1];
  };
  applyTheme(stage.theme);

  // ---- Camera ----
  // b: beat, p: position, t: target, f: field of view, s: frame shift as a fraction of the viewport.
  // `lin` keys travel at a near-constant speed; `log` keys dolly so the distance shrinks geometrically.
  interface Pose {
    readonly p: readonly [number, number, number];
    readonly t: readonly [number, number, number];
    readonly f: number;
    readonly s: readonly [number, number];
  }
  interface Key extends Pose {
    readonly b: number;
    readonly lin?: boolean;
    readonly log?: boolean;
    readonly portrait?: Pose;
  }
  const SIDE: readonly [number, number] = [0.22, 0.06]; // keeps the object right of the caption column
  const channelCentre = v3(0, CHANNEL_BASE + CHANNEL_HEIGHT / 2, FRONT);
  let handOverShift: readonly [number, number] = [-0.43, 0];
  const keys = (): readonly Key[] => [
    {
      b: 0,
      p: [2.7, 1.0, 9.0],
      t: [-1.5, 1.45, 0],
      f: 30,
      s: [0.08, 0.05],
      portrait: { p: [2.5, 1.3, 11.6], t: [-0.8, 1.6, 0], f: 34, s: [0.02, 0.12] },
    },
    { b: 1, p: [2.5, 4.2, 10.0], t: [0.15, 1.4, 0], f: 32, s: SIDE },
    { b: 2, p: [-4.9, 1.75, 6.4], t: [-1.5, 1.05, 0], f: 34, s: SIDE },
    { b: 3, p: [-7.4, 3.0, 9.0], t: [-1.45, 1.4, 0], f: 32, s: SIDE },
    { b: 4, p: [2.4, 4.6, 7.8], t: [0.45, 2.0, 0], f: 32, s: SIDE },
    { b: 5, p: [7.8, 2.8, 6.0], t: [2.0, 2.05, 0], f: 32, s: SIDE },
    { b: 5.3, p: [7.2, 3.6, 9.5], t: [0.6, 1.4, 0], f: 32, s: SIDE },
    // The rewind, seen from beyond position 1, looking up the whole stream as the light comes back.
    { b: 5.6, p: [TAIL - 7, 4.6, 6.5], t: [TAIL + 26, 0.8, 0], f: 36, s: [0.14, 0.02] },
    {
      b: 6,
      p: [TAIL - 2.4, 2.0, -2.8],
      t: [ROW_X + 0.8, rowY(3), 0],
      f: 40,
      s: [0.18, 0.06],
      lin: true,
      portrait: { p: [TAIL - 2.6, 2.0, -2.6], t: [ROW_X + 0.8, rowY(3), 0], f: 52, s: [0, -0.06] },
    },
    {
      b: 7,
      p: [HEAD - 3.2, 3.3, -4.8],
      t: [ROW_X + 0.6, rowY(3), 0],
      f: 40,
      s: [0.18, 0.06],
      lin: true,
      portrait: { p: [HEAD - 4.4, 2.4, -3.4], t: [ROW_X + 0.6, rowY(3), 0], f: 52, s: [0, -0.06] },
    },
    { b: 7.6, p: [5.8, 2.9, 13.4], t: [-0.1, 1.5, 0], f: 30, s: SIDE },
    { b: 7.72, p: [5.6, 2.85, 13.0], t: [-0.1, 1.5, 0], f: 30, s: SIDE },
    // The hand-over: close in on the channel until it is the code section's rail.
    {
      b: 7.86,
      p: [0, channelCentre.y, FRONT + 2.4],
      t: [0, channelCentre.y, FRONT],
      f: 30,
      s: handOverShift,
      portrait: {
        p: [0, channelCentre.y, FRONT + 2.4],
        t: [0, channelCentre.y, FRONT],
        f: 30,
        s: handOverShift,
      },
    },
    {
      b: 8,
      p: [0, channelCentre.y, FRONT + 0.3],
      t: [0, channelCentre.y, FRONT],
      f: 30,
      s: handOverShift,
      log: true,
      portrait: {
        p: [0, channelCentre.y, FRONT + 0.3],
        t: [0, channelCentre.y, FRONT],
        f: 30,
        s: handOverShift,
      },
    },
  ];
  const CTA: Pose & { readonly portrait: Pose } = {
    p: [6.2, 1.25, 10.4],
    t: [-1.0, 2.05, 0],
    f: 30,
    s: [0.22, 0.14],
    portrait: { p: [3.0, 1.6, 12.6], t: [-0.8, 1.55, 0], f: 36, s: [0.02, -0.24] },
  };
  // On a tall screen a key without its own portrait pose pulls back and widens.
  const portraitOf = (k: Key): Key => {
    if (k.portrait) return { ...k.portrait, b: k.b, lin: k.lin, log: k.log };
    const p = k.p.map((v, i) => (k.t[i] ?? 0) + (v - (k.t[i] ?? 0)) * 1.8) as unknown as readonly [
      number,
      number,
      number,
    ];
    return { p, t: k.t, f: k.f + 6, s: [0, -0.05], b: k.b, lin: k.lin };
  };
  let portrait = false;
  let poses: readonly Key[] = keys();
  const viewport = { w: 1, h: 1 };
  const camPosition = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  let frameShift: readonly [number, number] = [0, 0];
  const pose = (b: number): void => {
    let i = 0;
    while (i < poses.length - 2 && b > (poses[i + 1]?.b ?? Infinity)) i++;
    const A = poses[i];
    const Z = poses[i + 1];
    if (!A || !Z) return;
    let f = clamp((b - A.b) / (Z.b - A.b));
    f = Z.lin ? f + (ease5(f) - f) * 0.35 : ease5(f);
    let fp = f;
    if (Z.log) {
      const dA = Math.hypot(A.p[0] - A.t[0], A.p[1] - A.t[1], A.p[2] - A.t[2]);
      const dZ = Math.hypot(Z.p[0] - Z.t[0], Z.p[1] - Z.t[1], Z.p[2] - Z.t[2]);
      const ff = seg(b, A.b, Z.b);
      fp = (dA - dA * (dZ / dA) ** ff) / (dA - dZ);
    }
    camPosition.set(lerp(A.p[0], Z.p[0], fp), lerp(A.p[1], Z.p[1], fp), lerp(A.p[2], Z.p[2], fp));
    camTarget.set(lerp(A.t[0], Z.t[0], f), lerp(A.t[1], Z.t[1], f), lerp(A.t[2], Z.t[2], f));
    camera.fov = lerp(A.f, Z.f, f);
    frameShift = [lerp(A.s[0], Z.s[0], f), lerp(A.s[1], Z.s[1], f)];
  };
  const applyCamera = (): void => {
    camera.position.copy(camPosition);
    camera.lookAt(camTarget);
    camera.setViewOffset(
      viewport.w,
      viewport.h,
      -frameShift[0] * viewport.w,
      -frameShift[1] * viewport.h,
      viewport.w,
      viewport.h,
    );
    camera.updateProjectionMatrix();
  };
  const resize = (): void => {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    viewport.w = w;
    viewport.h = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    portrait = w / h < 0.8;
    // The hand-over lands the channel exactly on the code section's rail.
    handOverShift = [stage.railX - 0.5, 0];
    poses = portrait ? keys().map(portraitOf) : keys();
  };
  resize();
  addEventListener("resize", resize);

  // ---- The objects at a beat ----
  const eventAt = new THREE.Vector3();
  let foldStep = -1;
  const update = (b: number, time: number, idle: boolean): void => {
    // Append: the stream ratchets one position to make room at the head.
    layoutPlates(ease5(seg(b, 1.55, 1.95)));

    // The command descends into the cradle, is decided, and condenses into an event.
    const descent = seg(b, 0.35, 0.95);
    const commandOpacity = ease(seg(b, 0.35, 0.6)) * (1 - seg(b, 1.3, 1.48));
    command.visible = commandOpacity > 0.001;
    if (command.visible) {
      command.position.set(CRADLE.x, lerp(4.2, CRADLE.y, outCubic(descent)), CRADLE.z);
      command.rotation.set(lerp(0.5, 0, ease(descent)), lerp(1.2, 0, ease(descent)), 0);
      const decide = ease(seg(b, 0.95, 1.18));
      const condense = ease5(seg(b, 1.18, 1.42));
      const swell = 1 + Math.sin(decide * Math.PI) * 0.05;
      command.scale.set(lerp(1, 0.075, condense), swell, swell);
      commandEdges.color.copy(commandColor).lerp(accent, decide);
      commandEdges.opacity = commandOpacity;
      commandFill.opacity = commandOpacity * (0.04 + 0.16 * decide);
    }

    const folding = b > 2.45 && b < 3.6;

    // The new event: born in the cradle, it slides along the foot onto the head of the stream.
    const born = seg(b, 1.28, 1.44);
    event.visible = reflectedEvent.visible = born > 0;
    let glow = 0;
    if (event.visible) {
      const m = ease5(seg(b, 1.55, 1.98));
      eventAt.set(lerp(CRADLE.x, HEAD, m), lerp(CRADLE.y, ROD_Y, ease(seg(m, 0.62, 1))), 0);
      event.position.copy(eventAt);
      const sc = lerp(0.5, 1, ease(born));
      event.scale.set(1, sc, sc);
      reflectedEvent.position.copy(eventAt);
      reflectedEvent.scale.copy(event.scale);
      glow = ease(born);
      glow = lerp(glow, 0.3, seg(b, 2.15, 2.55));
      glow = Math.max(glow, inWindow(b, FOLD_AT[2] - 0.02, FOLD_AT[2] + 0.2, 0.05));
      glow = Math.max(glow, 0.85 * inWindow(b, 3.42, 3.8, 0.08));
      if (b > 3.8) glow = lerp(0.3, 0.1, seg(b, 3.8, 4.3));
      if (b > 5.6) glow = 0.1;
      eventMaterial.emissiveIntensity = glow;
    }
    eventGlow.visible = event.visible && glow > 0.35;
    if (eventGlow.visible) {
      eventGlow.position.set(eventAt.x - 0.02, eventAt.y, eventAt.z);
      eventGlow.material.opacity = (look.additive ? 0.55 : 0.4) * (glow - 0.3);
    }

    // The order's earlier events, lit among the other aggregates' events as they are folded.
    for (let k = 0; k < 2; k++) {
      const plate = FOLD[k]?.plate ?? 0;
      const at = FOLD_AT[k] ?? 0;
      const l = folding
        ? 0.28 * inWindow(b, 2.48, 3.6, 0.1) + 0.9 * inWindow(b, at - 0.02, at + 0.2, 0.05)
        : 0;
      if (Math.abs(lit.getX(plate) - l) > 1e-4) {
        lit.setX(plate, l);
        lit.needsUpdate = true;
      }
    }

    // The channel: the order's state before the command, re-folded from its events, lit for the hand-over.
    let level = 1;
    let intensity = 0.45;
    if (b >= 0.6 && b < 2.5) level = lerp(1, 2 / 3, ease(seg(b, 0.6, 0.95)));
    else if (b >= 2.5 && b < 3.4) {
      level = (2 / 3) * (1 - ease(seg(b, 2.5, 2.6)));
      for (const at of FOLD_AT) level += ease5(seg(b, at + 0.12, at + 0.2)) / 3;
      intensity = 1;
    } else if (b >= 3.4 && b < 7.6) intensity = lerp(1, 0.45, seg(b, 3.4, 3.9));
    if (b >= 7.6) intensity = lerp(0.45, 1, seg(b, 7.65, 7.9));
    const handOver = seg(b, 7.72, 7.9);
    faces.roughness = look.glyph.roughness * (1 + 0.9 * handOver);
    fill.scale.set(1, Math.max(0.0001, level), 1);
    groove.scale.x = 1;
    fill.visible = halo.visible = level > 0.002;
    fillMaterial.color.copy(accent).multiplyScalar(0.55 + intensity * 0.75);
    halo.scale.set(1, Math.max(0.0001, level), 1);
    haloMaterial.opacity =
      (0.18 + 0.32 * intensity) * (1 - 0.4 * handOver) * (look.additive ? 1 : 0.5);
    fillTip.position.set(0, CHANNEL_BASE + CHANNEL_HEIGHT * level, FRONT + 0.03);
    fillTip.material.opacity =
      level > 0.01 ? (0.25 + intensity * 0.6) * (1 - handOver) * (look.additive ? 1 : 0.45) : 0;

    // The read model's rows
    for (let r = 0; r < ROWS; r++) {
      let present =
        r < 6 ? ease5(seg(b, 0.3 + r * 0.05, 0.62 + r * 0.05)) : ease5(seg(b, 3.85, 4.12));
      let drop = 0;
      let g = 0;
      if (r === 6)
        g = Math.max(inWindow(b, 3.85, 4.6, 0.22) * 1.2, inWindow(b, 4.55, 5.1, 0.12) * 1.5);
      if (b >= 5.0 && b < 6) drop = ease(seg(b, 5.05 + r * 0.035, 5.3 + r * 0.035));
      if (b >= 6) {
        const f = replayProgress(b);
        present = ease5(seg(f, (r + 0.4) / 8, (r + 0.9) / 8));
        g = present > 0 ? 1.3 * (1 - seg(f, (r + 0.9) / 8, (r + 2.2) / 8)) : 0;
        if (b > 7) g *= 1 - seg(b, 7, 7.5);
      }
      if (b > 7.74) present *= 1 - seg(b, 7.74, 7.84);
      for (let c = 0; c < 3; c++) {
        const i = r * 3 + c;
        const grown = ease(clamp(present * 3 - c * 0.9));
        const w = (COLUMNS[c] ?? 0) * Math.max(grown, 0.0001);
        at.set((cellX[c] ?? 0) + w / 2, rowY(r) - 0.9 * ease(drop) * ease(drop), 0);
        size.set(
          w,
          Math.max(ROW_THICKNESS * (1 - drop), 0.0001),
          Math.max(ROW_DEPTH * (1 - drop * 0.6), 0.0001),
        );
        if (grown <= 0.0001 || drop >= 0.999) size.set(0.0001, 0.0001, 0.0001);
        matrix.compose(at, identity, size);
        rows.setMatrixAt(i, matrix);
        rowGlow.setX(i, g);
      }
    }
    rows.instanceMatrix.needsUpdate = true;
    rowGlow.needsUpdate = true;

    // The projection arc and the query beam draw themselves along their paths.
    projection.set(0, ease(seg(b, 3.45, 3.85)), b < 4.45 ? 1 - seg(b, 4.0, 4.4) : 0);
    query.set(0, ease(seg(b, 4.3, 4.58)), b < 5.25 ? 1 - seg(b, 4.95, 5.2) : 0);

    // One travelling light: the fold, the projection, the query's reply, each row of the replay.
    let pulseOpacity = 0;
    foldStep = -1;
    if (folding) {
      FOLD_AT.forEach((at, k) => {
        if (b > at - 0.01 && b < at + 0.17) {
          foldPaths[k]?.getPointAt(ease(seg(b, at, at + 0.14)), pulse.position);
          pulseOpacity = inWindow(b, at, at + 0.16, 0.03);
          foldStep = k;
        }
      });
      if (foldStep < 0) foldStep = b < FOLD_AT[1] ? 0 : b < FOLD_AT[2] ? 1 : 2;
    } else if (b > 3.45 && b < 3.9) {
      arc.getPoint(ease(seg(b, 3.48, 3.88)), pulse.position);
      pulseOpacity = inWindow(b, 3.48, 3.9, 0.06);
    } else if (b > 4.6 && b < 5.0) {
      pulse.position.lerpVectors(QUERY_TO, QUERY_FROM, ease(seg(b, 4.62, 4.95)));
      pulseOpacity = inWindow(b, 4.62, 4.98, 0.06);
    }

    const replaying = b >= 6 && b < 7.3;
    const replayed = replaying ? replayProgress(b) : 0;
    replays.forEach((trace, r) => {
      if (!replaying) return trace.set(0, 0, 0);
      const f0 = fireAt(r);
      const f1 = landAt(r);
      const f2 = f1 + 0.45 / 8;
      const head = ease(seg(replayed, f0, f1));
      trace.set(
        ease(seg(replayed, f1, f2)),
        head,
        replayed > f0 && replayed < f2 ? 1 - 0.45 * seg(replayed, f1, f2) : 0,
      );
      if (replayed > f0 && replayed < f1) {
        trace.curve.getPointAt(head, pulse.position);
        pulseOpacity = 1;
      }
    });
    pulse.material.opacity = pulseOpacity * (look.additive ? 1 : 0.6);
    pulse.visible = pulseOpacity > 0.001;
    pulse.scale.setScalar(replaying ? 0.7 : 0.42);

    // The reading light. Idle, it runs up to the head. On rebuild it rewinds fast to position 1,
    // a long comet over the whole stream, then replays forward as the camera's companion.
    let x = -100;
    let on = 0;
    let direction = 1;
    let decay = 2.2;
    if (b >= REWIND[0] - 0.05 && b < 6) {
      x = lerp(HEAD + 0.05, TAIL, rewindProgress(b));
      on = seg(b, REWIND[0] - 0.05, REWIND[0] + 0.04);
      direction = -1;
      decay = lerp(0.1, 0.22, rewindProgress(b));
    } else if (b >= 6 && b < 7.05) {
      x = lerp(TAIL, HEAD, replayed);
      on = 1 - seg(b, 6.95, 7.05);
    } else {
      const idleWeight = idle
        ? 1
        : b < 1
          ? 1 - seg(b, 0.25, 0.7)
          : seg(b, 7.25, 7.6) * (1 - seg(b, 7.6, 7.8));
      if (idleWeight > 0) {
        const cycle = (time % 7) / 7;
        x = lerp(HEAD - 20, HEAD + 0.05, ease(seg(cycle, 0.05, 0.8)));
        on = idleWeight * Math.min(seg(cycle, 0.05, 0.15), 1 - seg(cycle, 0.82, 0.95));
      }
    }
    U.cursor.value = x;
    U.cursorOn.value = on;
    U.direction.value = direction;
    U.decay.value = decay;
    U.trail.value = look.trail * (direction < 0 ? 1.6 : 1);
    cursor.position.set(x, ROD_Y, 0);
    cursor.material.opacity = on * (look.additive ? 0.95 : 0.7);
    cursor.visible = on > 0.001;
    readingLight.position.set(x, ROD_Y + 0.25, 0.3);
    readingLight.intensity = on * 2.2;

    // During the rebuild the far end stays visible, and the mirrored plates stop smearing under the rod.
    const far = inWindow(b, 5.35, 7.25, 0.2);
    scene.environmentIntensity = 1 - 0.88 * seg(b, 7.62, 7.95);
    key.intensity = look.key * (1 - 0.6 * seg(b, 7.7, 7.95));
    fog.near = lerp(10, 16, far);
    fog.far = lerp(40, 120, far);
    plateReflection.opacity = look.reflection[1] * (1 - 0.8 * inWindow(b, 5.7, 7.25, 0.15));
  };

  // ---- Callouts: technical labels pinned to points in the scene ----
  const calloutEls = new Map<string, { readonly el: HTMLElement; shown: boolean }>();
  for (const el of callouts.querySelectorAll<HTMLElement>("[data-callout]"))
    calloutEls.set(el.dataset.callout ?? "", { el, shown: false });
  const foldText = callouts.querySelector<HTMLElement>("[data-fold-text]");
  let foldShown = -2;
  const point = new THREE.Vector3();
  const CALLOUTS: readonly (readonly [
    string,
    number,
    number,
    (v: THREE.Vector3) => THREE.Vector3,
  ])[] = [
    ["command", 0.6, 1.42, (v) => v.set(CRADLE.x + 0.2, CRADLE.y + 0.22, 0.2)],
    ["event", 1.62, 2.48, (v) => v.set(eventAt.x, eventAt.y + 0.24, 0)],
    ["stream", 1.75, 2.48, (v) => v.set(HEAD - 7 * SPACING, ROD_Y - 0.22, 0)],
    [
      "fold",
      2.56,
      3.3,
      (v) => {
        const step = FOLD[Math.max(0, foldStep)];
        return v.set(!step || step.plate < 0 ? HEAD : plateX(step.plate), ROD_Y + 0.26, 0);
      },
    ],
    ["state", 3.2, 3.44, (v) => v.set(0.02, CHANNEL_BASE + CHANNEL_HEIGHT, FRONT)],
    ["read-model", 3.75, 5.08, (v) => v.set(ROW_END, rowY(6) + 0.06, 0)],
    ["query", 4.32, 5.05, (v) => v.copy(QUERY_FROM)],
    ["origin", 5.92, 6.22, (v) => v.set(U.cursor.value, ROD_Y + 0.26, 0)],
    ["rebuilt", 7.3, 7.66, (v) => v.set(ROW_END, rowY(6) + 0.06, 0)],
  ];
  const placeCallouts = (b: number): void => {
    const step = FOLD[foldStep];
    if (foldStep !== foldShown && step && foldText) {
      foldShown = foldStep;
      foldText.firstChild?.replaceWith(`${step.name} · `);
      const position = foldText.querySelector("em");
      if (position) position.textContent = formatPosition(step.position);
    }
    for (const [id, a, z, locate] of CALLOUTS) {
      const c = calloutEls.get(id);
      if (!c) continue;
      const o = inWindow(b, a, z, 0.08);
      if (o <= 0.001) {
        if (c.shown) {
          c.el.style.opacity = "0";
          c.shown = false;
        }
        continue;
      }
      locate(point).project(camera);
      if (point.z > 1 || Math.abs(point.x) > 1.2 || Math.abs(point.y) > 1.2) {
        c.el.style.opacity = "0";
        c.shown = false;
        continue;
      }
      const x = (point.x * 0.5 + 0.5) * viewport.w;
      const y = (-point.y * 0.5 + 0.5) * viewport.h;
      c.el.classList.toggle(
        "left",
        ((id === "stream" || id === "query") && x >= 160) || x > viewport.w - 240,
      );
      c.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      c.el.style.opacity = o.toFixed(3);
      c.shown = true;
    }
  };

  const drift = (time: number, amount: number): void => {
    camPosition.x += Math.sin(time * 0.21) * 0.12 * amount;
    camPosition.y += Math.sin(time * 0.17 + 1.3) * 0.05 * amount;
  };

  const frame = (): void => {
    if (stage.mode === "off") return;
    applyTheme(stage.theme);
    const time = stage.time;
    if (stage.mode === "cta") {
      update(7.6, time, true);
      const k = portrait ? CTA.portrait : CTA;
      const angle = (stage.ctaProgress - 0.5) * 0.5;
      const dx = k.p[0] - k.t[0];
      const dz = k.p[2] - k.t[2];
      camPosition.set(
        k.t[0] + dx * Math.cos(angle) - dz * Math.sin(angle),
        k.p[1] + (stage.ctaProgress - 0.5) * 0.8,
        k.t[2] + dx * Math.sin(angle) + dz * Math.cos(angle),
      );
      camTarget.set(...k.t);
      camera.fov = k.f;
      // On a phone the object rides with the section, so it stays above the copy instead of sliding under it.
      frameShift = portrait ? [k.s[0], k.s[1] + Math.min(0.4, stage.ctaTop)] : k.s;
      drift(time, 0.6);
      applyCamera();
    } else {
      const b = stage.beat;
      update(b, time, false);
      pose(b);
      drift(time, 1 - seg(b, 0, 0.3));
      applyCamera();
      if (b > 7.72) {
        // Hold the channel at the rail's width while the camera closes in.
        const pixelsPerUnit =
          viewport.h /
          (2 *
            Math.max(0.05, camPosition.distanceTo(channelCentre)) *
            Math.tan((camera.fov * Math.PI) / 360));
        const k = ease(seg(b, 7.74, 7.9));
        fill.scale.x = lerp(1, Math.min(1, 2.2 / (0.016 * pixelsPerUnit)), k);
        groove.scale.x = lerp(1, Math.min(1, 10 / (0.034 * pixelsPerUnit)), k);
        halo.scale.x = lerp(1, Math.min(1, 30 / (0.3 * pixelsPerUnit)), k);
      }
      placeCallouts(b);
    }
    renderer.render(scene, camera);
  };

  const still = (): void => {
    applyTheme(stage.theme);
    resize();
    update(0, 2.6, true);
    pose(0);
    applyCamera();
    renderer.render(scene, camera);
  };

  // Compile every program before the first frame, hidden objects included, so the scene neither
  // stalls on its first frame nor stutters the first time the command or a trace appears.
  // The first update sets each object's visibility back.
  scene.traverse((object) => {
    object.visible = true;
  });
  pose(0);
  applyCamera();
  // Without parallel compilation (a software renderer, some browsers) compileAsync only warns and blocks anyway.
  if (renderer.extensions.has("KHR_parallel_shader_compile")) await renderer.compileAsync(scene, camera);
  else renderer.compile(scene, camera);

  return { frame, still };
};
