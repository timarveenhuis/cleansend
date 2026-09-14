// CleanSend — story.js (v5): "chamber cinema" engine.
// One progress source (a pinned ScrollTrigger) drives a pure render(p): every
// visual and every UI value is derived from p alone, except the mist clock
// (a free-running time base, gated by section-visibility/L/reduced-motion so
// any scrub position is still coherent). See plans/spec-story-engine-v5.md.
//
// Rendering: a single canvas draws the whole demonstration.
//   p < ~0.10          the dirty still (<img>) is opaque, canvas idle
//   0.10 – 0.13         dissolve: canvas fades in showing arrive[0] (frozen)
//   0.13 – 0.26         `arrive` sequence (baked dolly-in), frame = f(p)
//   0.26 – 0.32         `close` sequence (baked door swing), frame = f(p)
//   0.32 – 0.90         `hold`: WebGL composite of dirty/clean x light on/off
//                        + a surface progress map + a mist layer, driven by
//                        L (light), c (clean amount), ringMix, mist — all f(p)
//   0.90 – 0.95         `open` sequence (baked door open), frame = f(p)
//   0.95 – 1.00         dissolve: canvas fades out revealing the clean still
// Fallbacks: reduced motion / no JS / manifest or hold-layer failure -> the
// three static stills (.story-static, styled by site.css). No WebGL -> a
// canvas-2D crossfade between five baked hold states, no mist.
import { StoryGL } from "./story-gl.js";

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
const range = (p, a, b) => (a === b ? (p >= a ? 1 : 0) : smooth((p - a) / (b - a)));
const linFrac = (p, a, b) => (a === b ? (p >= a ? 1 : 0) : clamp((p - a) / (b - a), 0, 1));

// ---- storyboard constants (plans/DIRECTION-v5.md) --------------------------
const SEG = {
  dirtyEnd: 0.10,
  // The 0.10-0.13 dissolve (dirty still -> arrive[0]) was checked against
  // the real arrive frames via gen/record-story.mjs's contact sheet and
  // found fighting, not reading as a cut-with-a-short-dissolve: the mat
  // close-up's shoe silhouette and the wide 3-compartment establishing shot
  // ghost through each other for a good third of the window (see f-011/
  // f-012 in screenshots/v5/motion/1440x900/). Shortened to 0.02 per the
  // fallback instruction for exactly this case. arriveStart (0.13) is left
  // alone — that's the asset-timing boundary where arrive content itself
  // starts, not the dissolve's own visual duration.
  dissolveInEnd: 0.12,
  arriveStart: 0.13, arriveEnd: 0.26,
  closeStart: 0.26, closeEnd: 0.32,
  holdStart: 0.32, holdEnd: 0.90,
  openStart: 0.90, openEnd: 0.95,
  // The p=0.90-1.0 reveal was found double-exposing two unrelated
  // compositions (the open-door chamber and the full mat reveal) cross-
  // dissolved over the whole 0.95-1.0 tail — the same "fighting" failure
  // mode as the 0.10-0.13 entry dissolve, just at the exit. Fix mirrors that
  // one: open[dims.open-1] (openEnd is already reached at 0.95, so the
  // canvas already just holds that frozen frame from there) stays fully
  // opaque through 0.975, THEN a short 0.015-wide dissolve, landing on the
  // clean still by 0.99 — a cut with a breath, not a long crossfade.
  //
  // First attempt used 0.965-0.98 with a check at p=0.972 — almost exactly
  // that window's own midpoint, so of course it read as a ~50/50 double
  // exposure in real Chrome; the check point has to sit OUTSIDE the
  // dissolve window (before it starts / after it ends), not inside it.
  dissolveOutStart: 0.975, dissolveOutEnd: 0.99,
};
const HOLD = {
  lightUpEnd: 0.40,
  cleanRampAEnd: 0.74, // c 0 -> 0.80
  cleanRampBEnd: 0.84, // c 0.80 -> 1.0
  lightDownStart: 0.84, lightDownEnd: 0.90,
  mistInStart: 0.36, mistInEnd: 0.45,
  mistFull: 0.65,
  mistOutEnd: 0.82,
  timerStart: 0.32, timerEnd: 0.86,
  // Working-light sweep (real Blender pack, round 3): the emissive band
  // travels left->right across the pair over the 24 frames and is already
  // dark at both frame 0 and frame 23 (a real render, not a synthetic
  // mask), so a plain wrap at the loop point is invisible — no separate
  // ease-in/out envelope needed on top; L alone (already ramping in/out at
  // the edges of the hold) handles the fade. ~3 passes across p 0.32-0.86.
  // Deterministic in p (floor(cycles*t*count) mod count — see
  // computeState) so scrubbing forward/backward reconstructs the identical
  // frame every time.
  sweepStart: 0.32, sweepEnd: 0.86, sweepCycles: 3,
};
const TIMER_TOTAL_S = 4 * 60 + 52;
// Per-segment scroll-to-frame index remap. `arrive`'s own baked camera move
// carries its ease already, so it stays a plain linear index (see below).
// `close` (measured from the rendered frames, build3d/machine-v5/renders/d/
// close): the door swing is frames 0-7, then 8-23 is a slow soft-close seat
// (frame deltas 12-18 early, 3-4 late) — a linear scroll->frame map would
// burn through the swing in ~1.5% of the 0.26-0.32 scroll segment. idx =
// round((n-1) * t^CLOSE_EXP) with CLOSE_EXP=1.7 gives the swing (the first
// ~1/3 of the frames) roughly 60% of the segment's scroll distance, matching
// how the fast part should dominate the felt scrub time, with the slow seat
// compressed into the remainder (still fully visible, just scrubbed faster).
// `open` measured the same way once its real frames landed (renders/d/open):
// deltas 0.9, 2.3, 3.4, 4.1 ... peak 13-15 at frames 13-16, then 7, 5, 3,
// 1.4 — an ease-in-out already baked into the frames themselves, with
// visible motion spread across frames 2-22 (not bunched at one end the way
// close's swing is). So unlike close, open does NOT need a remap on top —
// a plain linear index already matches the footage; OPEN_EXP=1 makes the
// power-curve formula below a no-op while keeping one code path for both.
const CLOSE_EXP = 1.7;
const OPEN_EXP = 1.0;
// object-fit: cover focus point, fraction from the top. DIRECTION-v5 sets
// 50%/52%, which works on phone (own camera, own compact rail below the
// stage). On desktop the real Blender chamber rect is tall/centred enough
// that 52% put it low enough in frame to collide with the fixed bottom-left
// caption box (confirmed by direct measurement: a real ~153x81px overlap at
// 1440x900). Team-approved exception for desktop only: 50%/60%, crops more
// off the top and lifts the chamber, freeing the band the caption sits in.
const FOCUS_DESKTOP = { x: 0.5, y: 0.60 };
const FOCUS_PHONE = { x: 0.5, y: 0.52 };
const MAX_RESIDENT_FRAMES = 20;

function fmtTime(s) {
  s = Math.round(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// object-fit: cover, in CSS/percentage space (top-left origin, no Y flip) —
// used to place the status rail against manifest.chamber (hold-frame
// fractions) without duplicating the GL cover math.
function coverRectCss(stageW, stageH, texAspect, focus) {
  const stageAspect = stageW / stageH;
  let dispW, dispH;
  if (stageAspect > texAspect) { dispW = stageW; dispH = stageW / texAspect; }
  else { dispH = stageH; dispW = stageH * texAspect; }
  const offX = (dispW - stageW) * focus.x;
  const offY = (dispH - stageH) * focus.y;
  return { dispW, dispH, offX, offY };
}
function chamberToCss(stageW, stageH, chamber, texAspect, focus) {
  const { dispW, dispH, offX, offY } = coverRectCss(stageW, stageH, texAspect, focus);
  return {
    left: chamber[0] * dispW - offX,
    top: chamber[1] * dispH - offY,
    width: chamber[2] * dispW,
    height: chamber[3] * dispH,
  };
}

// GL cover uv: screenUv * scale + offset = textureUv. The vertex shader's
// vUv is top-down (0 at screen-top) to match the no-flip texture upload, so
// focus.y is used directly here (fraction from the top), same as CSS.
function coverUvGl(texAspect, stageW, stageH, focus) {
  const stageAspect = stageW / stageH;
  let dispW, dispH;
  if (stageAspect > texAspect) { dispW = stageW; dispH = stageW / texAspect; }
  else { dispH = stageH; dispW = stageH * texAspect; }
  const scaleX = stageW / dispW, scaleY = stageH / dispH; // <= 1: the fraction of the texture that's visible
  const offX = (1 - scaleX) * focus.x;
  const offY = (1 - scaleY) * focus.y;
  return { scale: [scaleX, scaleY], offset: [offX, offY] };
}

class FrameCache {
  // Sliding-window bitmap cache shared across arrive/close/open. Hold layers
  // are managed separately (always resident as GL textures).
  constructor(max = MAX_RESIDENT_FRAMES) {
    this.max = max;
    this.slots = { arrive: [], close: [], open: [], sweep: [] };
    this.order = []; // MRU at the end, as "seg:i" keys
    this.onEvict = null;
    // Real bug found by direct testing: the progressive background loader
    // (every-4th-frame-first) can load a sequence's frame 0 well before the
    // user/scroll ever reaches it, and if enough *later* frames load in the
    // meantime (also part of that same progressive fill), plain LRU evicts
    // frame 0 for having gone the longest untouched — even though it's never
    // actually been rendered yet. A user or test that jumps straight to
    // p just past a segment boundary then finds frame 0 gone and falls back
    // to `nearest()`, which can return a frame from deep in the sequence
    // (visually nothing like frame 0) — producing a hard, structural jump at
    // exactly the boundary where continuity with the hold layers matters
    // most (close[last]/dirty-off and open[0]/clean-off are pixel-registered
    // pairs). Protect each sequence's first and last frame from eviction
    // permanently once loaded; six bitmaps at this resolution is a small,
    // bounded cost for guaranteeing the two continuity-critical ends never
    // silently disappear.
    this.protectedKeys = new Set();
    // That fix alone wasn't enough: it stops the worst case (total loss of
    // an end frame) but not the more common one — as soon as `ready` fires,
    // background prefetch for arrive/open starts immediately and races far
    // ahead (small webp files, localhost/CDN latency), and since the cache
    // budget is SHARED across all three sequences with no notion of "what's
    // actually on screen right now", it can evict the *middle* frames of the
    // segment the user/test is still sitting on — confirmed directly: right
    // after `ready`, only close[0] and close[23] survived out of 24, with
    // 16 arrive frames having already loaded into the same budget.
    // windowKeys is a second, short-lived protection set covering a small
    // neighborhood around whatever frame is actually being displayed for
    // the active segment; drawCanvas() updates it on every arrive/close/
    // open draw, so what's on screen is never sacrificed to prefetch of
    // sequences the scroll position hasn't reached yet.
    this.windowKeys = new Set();
  }
  setProtected(seg, indices) {
    indices.forEach((i) => this.protectedKeys.add(`${seg}:${i}`));
  }
  setWindow(seg, center, radius) {
    this.windowKeys.clear();
    for (let d = -radius; d <= radius; d++) {
      const i = center + d;
      if (i >= 0) this.windowKeys.add(`${seg}:${i}`);
    }
  }
  _isProtected(key) { return this.protectedKeys.has(key) || this.windowKeys.has(key); }
  has(seg, i) { return !!this.slots[seg][i]; }
  get(seg, i) {
    const b = this.slots[seg][i];
    if (b) this._touch(seg, i);
    return b || null;
  }
  set(seg, i, bitmap) {
    if (this.slots[seg][i]) return;
    this.slots[seg][i] = bitmap;
    this._touch(seg, i);
    this._evictIfNeeded();
  }
  _touch(seg, i) {
    const key = `${seg}:${i}`;
    const idx = this.order.indexOf(key);
    if (idx >= 0) this.order.splice(idx, 1);
    this.order.push(key);
  }
  _evictIfNeeded() {
    // count only non-protected entries against the budget: protected frames
    // are a small, fixed overhead on top, not part of the sliding window
    let liveCount = this.order.length;
    let cursor = 0;
    while (liveCount > this.max && cursor < this.order.length) {
      const key = this.order[cursor];
      if (this._isProtected(key)) { cursor++; continue; }
      this.order.splice(cursor, 1);
      const [seg, iStr] = key.split(":");
      const i = Number(iStr);
      const bitmap = this.slots[seg][i];
      if (bitmap) {
        this.slots[seg][i] = null;
        if (this.onEvict) this.onEvict(bitmap);
        if (bitmap.close) bitmap.close();
      }
      liveCount--;
    }
  }
  // nearest loaded index to `i` in segment `seg` (never returns null unless
  // absolutely nothing is loaded for that segment).
  nearest(seg, i, count) {
    if (this.slots[seg][i]) return i;
    for (let d = 1; d < count; d++) {
      if (i - d >= 0 && this.slots[seg][i - d]) return i - d;
      if (i + d < count && this.slots[seg][i + d]) return i + d;
    }
    return null;
  }
  clearAll() {
    ["arrive", "close", "open", "sweep"].forEach((seg) => {
      this.slots[seg].forEach((b) => { if (b) { if (this.onEvict) this.onEvict(b); if (b.close) b.close(); } });
      this.slots[seg] = [];
    });
    this.order = [];
    this.protectedKeys.clear(); // pickDims() re-registers these for the new breakpoint right after
    this.windowKeys.clear();
  }
}

export function initStory() {
  const root = document.querySelector("[data-story]");
  if (!root) return;
  const pin = root.querySelector(".story-pin");
  const stage = root.querySelector(".story-stage");
  const uiRoot = root.querySelector(".story-ui");
  const stillDirty = root.querySelector(".se-still--dirty");
  const stillClean = root.querySelector(".se-still--clean");
  const stillMid = root.querySelector(".se-still--mid"); // P1 fix: not-ready standby, see updateUI
  const canvasEl = root.querySelector(".se-canvas");
  const captions = Array.from(root.querySelectorAll(".se-caption"));
  const captionsBox = root.querySelector(".se-captions");
  const rail = root.querySelector("[data-rail]");
  const ringWrap = root.querySelector(".se-ring-wrap");
  const ringFill = root.querySelector(".se-ring-fill");
  const readout = root.querySelector(".se-readout");
  const lockEl = root.querySelector("[data-lock]");
  const unlockLine = root.querySelector("[data-unlock]");
  const statusEl = root.querySelector(".se-status");
  const progressFill = root.querySelector(".se-progress-fill");
  if (!stage || !canvasEl) return;

  const statusSteps = statusEl ? JSON.parse(statusEl.dataset.steps || "[]") : [];
  const RING_CIRC = 175.9;

  function goStatic(reason) {
    root.classList.add("is-static");
    if (statusEl && statusSteps.length) statusEl.textContent = statusSteps[statusSteps.length - 1].text;
    window.__story = { state: () => ({ ready: false, staticFallback: true, reason }) };
  }

  if (reduceMotion || !gsap || !ScrollTrigger || !window.WebGLRenderingContext) {
    // Reduced motion always gets the static beats; missing GSAP/WebGL support
    // (very old browsers) also degrades gracefully rather than risk a broken pin.
    if (reduceMotion) return goStatic("reduced-motion");
  }

  const seqBase = root.dataset.seq || "assets/seq/v5";
  // isPhone: LAYOUT breakpoint only (stacked stage/rail/caption vs desktop
  // overlay rail), keyed on viewport width per the design spec.
  let isPhone = window.matchMedia("(max-width: 760px)").matches;
  // useP: ASSET-SET selection, keyed on the stage's own ORIENTATION (its
  // rendered aspect ratio), independent of isPhone. A portrait-ish stage
  // (e.g. a tablet viewport with the desktop layout) still needs the p/
  // portrait camera set to avoid the severe cover-fit cropping a landscape
  // camera suffers at aspect < ~0.95; a wide phone-in-landscape stage still
  // wants d. Re-evaluated on resize/orientation change; see the resize
  // handler below for the reload-on-change logic.
  let useP = computeUseP();
  let manifest = null;
  let dims = null; // manifest[useP ? "p" : "d"]
  let texAspect = 1.5;
  const getFocus = () => (useP ? FOCUS_PHONE : FOCUS_DESKTOP);

  function computeUseP() {
    const rect = stage.getBoundingClientRect();
    const aspect = rect.height > 0 ? rect.width / rect.height : 1;
    return aspect < 0.95;
  }

  const cache = new FrameCache(MAX_RESIDENT_FRAMES);
  let glCtx = null; // StoryGL instance, if WebGL is available
  let ctx2d = null; // 2D fallback context
  let holdImgs2d = {}; // <img>/ImageBitmap for the 2D fallback path
  let holdReady = false;
  let closeReady = false;
  let loadFailed = false;
  let ready = false; // hold + close loaded
  let loadingStarted = false;
  let midStillBitmap = null; // P1 fix: small baked-050 standby, see updateUI

  let lastState = { p: 0, seg: "dirty", frame: 0, L: 0, c: 0, mist: 0, timer: "0:00", locked: false, status: "", ready: false };
  let mistClock = 0;
  let lastFrameTs = null;
  let rafId = null;
  let sectionVisible = false;
  let farOffscreen = true;
  let pinActive = false;

  cache.onEvict = (bitmap) => { if (glCtx) glCtx.dropFrameTexture(bitmap); };

  async function decodeOne(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      return await createImageBitmap(blob);
    } catch (e) {
      return null;
    }
  }

  // Decode and, only if the source is larger than needed, downscale to at
  // most maxW x maxH via createImageBitmap's own resize (cheaper than
  // uploading a full 2048x1365 texture — e.g. a hold layer with map or dirty
  // pixels that's shown on a 1440px canvas — when the canvas is smaller).
  // Never upscales: a source already at or below the cap is used as-is.
  async function decodeOneCapped(url, maxW, maxH) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const full = await createImageBitmap(blob);
      if (full.width <= maxW && full.height <= maxH) return full;
      const scale = Math.min(maxW / full.width, maxH / full.height);
      const w = Math.max(1, Math.round(full.width * scale));
      const h = Math.max(1, Math.round(full.height * scale));
      const resized = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
      full.close();
      return resized;
    } catch (e) {
      return null;
    }
  }

  async function loadHoldLayers(base) {
    const names = ["dirty-off", "dirty-on", "clean-on", "clean-off", "map", "window"];
    const bitmaps = {};
    // cap hold texture upload to 1.25x the canvas's own pixel size — the
    // canvas rarely needs full 2048x1365 texel density, and this saves GPU
    // memory bandwidth (upload cost and per-sample cache pressure) with no
    // visible loss at the sizes this section actually renders at. BUT: a
    // floor is needed, not just the cap. At a phone canvas (~390px wide),
    // 1.25x alone asked for ~488px against a 1080px-wide source — a >2x
    // downscale that measurably softens the map's cleaning-front edge (the
    // smoothstep width is only 0.035 of c) and was failing the pixel-
    // accuracy assertions (gen/_pixel-check.mjs) at p=0.32 and p=0.45 on
    // real phone assets. The floor keeps that edge sharp while still
    // shrinking the texture meaningfully vs. the 2048px desktop source; the
    // memory saved on an already-modest 1080x1350 phone texture was never
    // where the GPU-bandwidth win was anyway (that's the 1920px desktop case).
    const CAP_FLOOR = 800;
    let maxW = Math.round((canvasEl.width || 2048) * 1.25);
    let maxH = Math.round((canvasEl.height || 1365) * 1.25);
    if (maxW < CAP_FLOOR) { const s = CAP_FLOOR / Math.max(1, maxW); maxW = Math.round(maxW * s); maxH = Math.round(maxH * s); }
    maxW = Math.max(1, maxW); maxH = Math.max(1, maxH);
    for (const n of names) {
      const url = `${base}/hold/${n}.${n === "map" || n === "window" ? "png" : "webp"}`;
      const bm = await decodeOneCapped(url, maxW, maxH);
      if (!bm) { loadFailed = true; return null; }
      bitmaps[n] = bm;
    }
    return bitmaps;
  }

  async function loadBakedFallback(base) {
    const names = ["baked-025", "baked-050", "baked-075"];
    const out = {};
    for (const n of names) out[n] = await decodeOne(`${base}/hold/${n}.webp`);
    return out;
  }

  async function loadSeqFrame(base, seg, i, count) {
    if (cache.has(seg, i)) return;
    const idxStr = String(i).padStart(3, "0");
    const bm = await decodeOne(`${base}/${seg}/${idxStr}.webp`);
    if (bm) {
      cache.set(seg, i, bm);
      requestRender();
    }
  }

  async function loadSeqProgressive(base, seg, count) {
    // every 4th frame first, then fill the rest
    const order = [];
    for (let i = 0; i < count; i += 4) order.push(i);
    for (let i = 0; i < count; i++) if (i % 4 !== 0) order.push(i);
    for (const i of order) {
      if (farOffscreen) return; // stop background fetch once we've scrolled far away
      await loadSeqFrame(base, seg, i, count);
    }
  }

  async function startLoading() {
    if (loadingStarted) return;
    loadingStarted = true;
    try {
      const res = await fetch(`${seqBase}/manifest.json`);
      manifest = await res.json();
    } catch (e) {
      loadFailed = true;
      goStatic("manifest-failed");
      return;
    }
    pickDims();
    positionRail(); // manifest.chamber is known now; the initial resizeCanvas() ran before this
    positionCaptions();
    const base = `${seqBase}/${useP ? "p" : "d"}`;

    // P1 fix: fetch the small baked-050 standby BEFORE the heavy hold
    // layers/close sequence (~1.6 MB+) so scrolling into the locked/
    // cleaning region (p 0.32-0.90) during that load window has a real
    // still to show instead of a black canvas (see updateUI's !ready
    // branch). clean-still is already an eager, fetchpriority=high <img>
    // in the DOM so it's typically available even earlier than this.
    // Non-fatal on failure — the !ready branch just falls back further
    // down its still-selection chain (mid -> dirty).
    try {
      const bmp = await decodeOne(`${base}/hold/baked-050.webp`);
      if (bmp && stillMid) {
        midStillBitmap = bmp;
        stillMid.width = bmp.width;
        stillMid.height = bmp.height;
        stillMid.getContext("2d").drawImage(bmp, 0, 0);
        requestRender();
      }
    } catch (e) { /* non-fatal, see comment above */ }

    // WebGL vs 2D decision
    try {
      glCtx = new StoryGL(canvasEl);
    } catch (e) {
      glCtx = null;
      ctx2d = canvasEl.getContext("2d");
    }

    const hold = await loadHoldLayers(base);
    if (!hold || loadFailed) { goStatic("hold-failed"); return; }
    holdReady = true;
    if (glCtx) {
      glCtx.setHoldLayer("dirtyOff", hold["dirty-off"]);
      glCtx.setHoldLayer("dirtyOn", hold["dirty-on"]);
      glCtx.setHoldLayer("cleanOn", hold["clean-on"]);
      glCtx.setHoldLayer("cleanOff", hold["clean-off"]);
      glCtx.setHoldLayer("map", hold["map"]);
      glCtx.setHoldLayer("window", hold["window"]);
      // real tileable mist noise (engine-level asset, not per-shot)
      Promise.all([
        decodeOne("assets/gl/noise-a.png"),
        decodeOne("assets/gl/noise-b.png"),
        decodeOne("assets/gl/noise-fine.png"),
      ]).then(([a, b, fine]) => { if (glCtx) glCtx.setNoiseTextures(a, b, fine); requestRender(); });
    } else {
      holdImgs2d = hold;
      holdImgs2d.baked = await loadBakedFallback(base);
    }

    // close must be fully loaded before "ready" (spec: hold + close gate
    // readiness). If the manifest doesn't list a close count yet (hold-only
    // mode — sequences not rendered yet), dims.close is undefined and this
    // loop is simply zero iterations: readiness only ever waits on what's
    // actually promised, never blocks on a sequence that doesn't exist.
    for (let i = 0; i < dims.close; i++) await loadSeqFrame(base, "close", i, dims.close);
    closeReady = true;
    // sweep (working-light) starts mattering at p=0.36, right after hold
    // begins (0.32) — load it fully alongside close, before ready, rather
    // than progressively: unlike arrive/open it's small (24 frames, same
    // budget as close) and needed almost immediately into the hold, not
    // traversed once at the far end of the timeline. A missing manifest
    // count (older asset set) makes this loop a no-op, same pattern as close.
    for (let i = 0; i < dims.sweep; i++) await loadSeqFrame(base, "sweep", i, dims.sweep);
    ready = true;
    root.classList.add("is-ready");
    // P1 fix: cross-fade the canvas in over 300ms from whatever still was
    // standing in for it, rather than an instant pop the moment loading
    // finishes — the class is transition-only-for-this-instant (see
    // css/story.css .se-canvas.is-revealing) so it never affects the
    // continuous p-driven opacity used everywhere else.
    if (canvasEl) {
      canvasEl.classList.add("is-revealing");
      setTimeout(() => canvasEl.classList.remove("is-revealing"), 320);
    }
    requestRender();

    // background: arrive + open, progressive, non-blocking (no-ops when the
    // manifest has no count for them — drawCanvas() then uses the hold-only
    // degrade for those segments instead of a sequence frame)
    if (dims.arrive) loadSeqProgressive(base, "arrive", dims.arrive);
    if (dims.open) loadSeqProgressive(base, "open", dims.open);
  }

  function pickDims() {
    useP = computeUseP();
    dims = manifest[useP ? "p" : "d"];
    texAspect = dims.w / dims.h;
    // protect the continuity-critical ends of each sequence from LRU
    // eviction — see the FrameCache constructor comment for why
    if (dims.arrive) cache.setProtected("arrive", [0, dims.arrive - 1]);
    if (dims.close) cache.setProtected("close", [0, dims.close - 1]);
    if (dims.open) cache.setProtected("open", [0, dims.open - 1]);
    // Sweep gets ALL of its frames protected, not just the two endpoints:
    // unlike arrive/close/open (a single monotonic pass, where only the
    // current neighborhood and the two continuity endpoints ever matter),
    // sweep cycles through its whole 24-frame range repeatedly and
    // unpredictably across most of the hold (~3 passes) while arrive's
    // progressive background load is ALSO running and competing for the
    // shared cache budget. Confirmed by direct testing: with only the two
    // endpoints protected, the sliding-window eviction (tuned for a single
    // monotonic pass) left just sweep:0/sweep:23 resident soon after ready
    // — nearestProtected's own fallback-to-nearest-loaded-frame then always
    // resolved to one of those two (both dark, by design, at the loop
    // seam), so the working light never actually appeared on screen despite
    // computeState producing the right frame indices throughout. Protected
    // keys are exempt from the eviction budget entirely (see
    // FrameCache._evictIfNeeded), so this is a fixed ~24-bitmap overhead on
    // top of the existing budget, not a change to it.
    if (dims.sweep) cache.setProtected("sweep", Array.from({ length: dims.sweep }, (_, i) => i));
  }

  // ---------------------------------------------------------------- render
  function computeState(p) {
    p = clamp(p, 0, 1);
    // dims can still be null here: ScrollTrigger.create()'s own synchronous
    // init (and .refresh()) calls onUpdate/onRefresh -> render() -> this
    // function IMMEDIATELY, before the async manifest fetch in
    // startLoading() has resolved. On a normal fresh load that's harmless
    // (scroll is 0, so p=0 -> "dirty-dissolve", no dims access at all) —
    // but a browser restoring a non-zero scroll position on reload feeds a
    // real, non-zero p into that very first synchronous call, landing in
    // whichever segment branch that p maps to and crashing on `dims.open`/
    // `.close`/`.arrive` being read off a null `dims` (confirmed via a real
    // reload-with-restored-scroll repro; the resulting uncaught exception
    // also aborted ScrollTrigger's own refresh, leaving the pin/spacer
    // mis-set — the "blank stage" report). `d` is a safe stand-in: every
    // frame count below already treats a missing/falsy count as 0.
    const d = dims || {};
    let seg, frame = 0, L = 0, c = 0, ringMix = 0, mist = 0, sweepMix = 0, sweepFrame = 0;

    if (p < SEG.arriveStart) {
      seg = "dirty-dissolve"; frame = 0;
    } else if (p < SEG.arriveEnd) {
      seg = "arrive";
      const t = range(p, SEG.arriveStart, SEG.arriveEnd);
      frame = d.arrive ? Math.round(t * (d.arrive - 1)) : 0;
    } else if (p < SEG.closeEnd) {
      seg = "close";
      // raw linear scroll fraction, then the swing/seat remap (CLOSE_EXP) —
      // NOT range()'s smoothstep, which would add a second, unwanted ease on
      // top of the remap.
      const t = linFrac(p, SEG.closeStart, SEG.closeEnd);
      frame = d.close ? Math.round(Math.pow(t, CLOSE_EXP) * (d.close - 1)) : 0;
      L = 0; // still dark (studio key at 55%; chamber light not yet up)
    } else if (p < SEG.holdEnd) {
      seg = "hold";
      L = p < HOLD.lightUpEnd ? range(p, SEG.holdStart, HOLD.lightUpEnd)
        : p < HOLD.lightDownStart ? 1
        : 1 - range(p, HOLD.lightDownStart, HOLD.lightDownEnd);
      if (p < HOLD.lightUpEnd) c = 0;
      else if (p < HOLD.cleanRampAEnd) c = lerp(0, 0.80, range(p, HOLD.lightUpEnd, HOLD.cleanRampAEnd));
      else if (p < HOLD.cleanRampBEnd) c = lerp(0.80, 1.0, range(p, HOLD.cleanRampAEnd, HOLD.cleanRampBEnd));
      else c = 1;
      ringMix = p < HOLD.lightDownStart ? 0 : range(p, HOLD.lightDownStart, HOLD.lightDownEnd);
      if (p < HOLD.mistInStart) mist = 0;
      else if (p < HOLD.mistInEnd) mist = range(p, HOLD.mistInStart, HOLD.mistInEnd);
      else if (p < HOLD.mistFull) mist = 1;
      else if (p < HOLD.mistOutEnd) mist = 1 - range(p, HOLD.mistFull, HOLD.mistOutEnd);
      else mist = 0;
      // Working-light sweep: on for p in [sweepStart, sweepEnd) — the real
      // asset is already dark at both loop ends, so no separate ease
      // envelope; sweepMix is just L (the shader also gates by the window
      // mask), off entirely past sweepEnd (0.86) even though hold itself
      // continues to 0.90 — the "~3 passes" beat is explicitly p 0.32-0.86.
      if (p < HOLD.sweepEnd) {
        sweepMix = L;
        const sweepCount = d.sweep;
        if (sweepCount) {
          const sweepT = linFrac(p, HOLD.sweepStart, HOLD.sweepEnd);
          sweepFrame = Math.floor(HOLD.sweepCycles * sweepT * sweepCount) % sweepCount;
        }
      } else {
        sweepMix = 0;
      }
    } else if (p < SEG.openEnd) {
      seg = "open";
      // mirror of the close remap: slow start, fast finish (see OPEN_EXP note above)
      const t = linFrac(p, SEG.openStart, SEG.openEnd);
      frame = d.open ? Math.round((1 - Math.pow(1 - t, OPEN_EXP)) * (d.open - 1)) : 0;
      L = 1; ringMix = 1;
    } else {
      seg = "clean-dissolve"; frame = d.open ? d.open - 1 : 0; L = 1; ringMix = 1; c = 1;
    }

    const timerT = clamp((p - HOLD.timerStart) / (HOLD.timerEnd - HOLD.timerStart), 0, 1);
    const timerS = timerT * TIMER_TOTAL_S;
    const locked = p >= SEG.holdStart - 0.0015 && p < SEG.openStart;
    const status = (statusSteps.slice().reverse().find((s) => p >= s.at) || statusSteps[0] || { text: "" }).text;

    return { p, seg, frame, L, c, ringMix, mist, sweepMix, sweepFrame, timer: fmtTime(timerS), locked, status, ready };
  }

  // Zoom the sampled UV window around `focus` by `zoom` (>1 = visually
  // zoomed in). Used only for the hold-only arrive degrade's scale settle,
  // since a real arrive sequence already provides its own baked camera move.
  function zoomUv(scale, offset, focus, zoom) {
    const sx = scale[0] / zoom, sy = scale[1] / zoom;
    return {
      scale: [sx, sy],
      offset: [offset[0] + (scale[0] - sx) * focus.x, offset[1] + (scale[1] - sy) * focus.y],
    };
  }

  // Protects a small neighborhood around the frame actually being displayed
  // before asking for it — see FrameCache's windowKeys comment for why this
  // is necessary (background prefetch of the OTHER sequences would otherwise
  // race ahead and evict exactly what's on screen right now).
  const WINDOW_RADIUS = 4;
  function nearestProtected(seg, frame, count) {
    if (!count) return null;
    cache.setWindow(seg, frame, WINDOW_RADIUS);
    return cache.nearest(seg, frame, count);
  }

  let lastDrawKey = null;
  function drawCanvas(state, force) {
    const rectW = canvasEl.clientWidth || stage.clientWidth;
    const rectH = canvasEl.clientHeight || stage.clientHeight;
    if (!rectW || !rectH) return;

    // Skip the GL draw entirely when nothing that could change a pixel has
    // changed since the last draw: the ScrollTrigger onUpdate handler and
    // the rAF loop both call this far more often than the visible state
    // actually moves (sub-threshold scroll deltas, ticks while the mist is
    // inactive). Debug overrides (pixel-accuracy tests) always bypass this —
    // they need a guaranteed fresh draw every call.
    const hasOverride = state.LOverride != null || state.cOverride != null || state.mistOverride != null || state.bandScale != null;
    if (!force && !hasOverride) {
      const mistActive = state.seg === "hold" && state.L > 0 && state.mist > 0.001 && !reduceMotion;
      const timeKey = mistActive ? Math.round(mistClock / 4) : 0; // 4ms buckets, only while mist is actually animating
      const key = [rectW, rectH, state.seg, state.frame, state.L.toFixed(3), state.c.toFixed(3), state.ringMix.toFixed(3), state.mist.toFixed(3), timeKey].join("|");
      if (key === lastDrawKey) return;
      lastDrawKey = key;
    }

    if (glCtx) {
      const { scale, offset } = coverUvGl(texAspect, rectW, rectH, getFocus());
      // For an actual decoded sequence-frame bitmap, use ITS real aspect
      // ratio for the cover-fit math, not the manifest's declared dims.w/h —
      // a packing regression that reflows a frame's actual dimensions (e.g.
      // the 08:09 close-set repack, wrong resolution and exposure vs the
      // 1536x1024/1536x1024-aspect contract) must not silently mis-register
      // the on-screen crop just because the manifest number still looked
      // plausible. texImage2D already uploads bitmaps at their own true
      // size regardless (see _uploadInto in story-gl.js); this closes the
      // remaining place a stale manifest number could still bite.
      const uvFor = (bitmap) => {
        if (!bitmap || !bitmap.width || !bitmap.height) return { scale, offset };
        const bmpAspect = bitmap.width / bitmap.height;
        if (Math.abs(bmpAspect - texAspect) < 0.001) return { scale, offset }; // common case, skip recompute
        return coverUvGl(bmpAspect, rectW, rectH, getFocus());
      };
      if (state.seg === "hold" && holdReady) {
        // Working-light sweep: same sliding FrameCache as arrive/close/open
        // (nearestProtected falls back to the nearest resident frame if the
        // exact one somehow isn't loaded yet, same as those). sweepMix
        // already 0 outside p 0.36-0.84 (or overridden to 0 for tests via
        // sweepOverride), so there's nothing to look up in that case.
        const sweepMixVal = state.sweepOverride != null ? state.sweepOverride : state.sweepMix;
        let sweepTex = null;
        if (sweepMixVal > 0 && dims.sweep) {
          const sIdx = nearestProtected("sweep", state.sweepFrame, dims.sweep);
          if (sIdx != null) sweepTex = glCtx.getFrameTexture(cache.get("sweep", sIdx));
        }
        glCtx.drawHold({
          L: state.LOverride != null ? state.LOverride : state.L,
          c: state.cOverride != null ? state.cOverride : state.c,
          ringMix: state.ringMix,
          mist: state.mistOverride != null ? state.mistOverride : state.mist,
          time: mistClock / 1000,
          uvScale: scale, uvOffset: offset,
          winRect: dims.chamber,
          bandScale: state.bandScale != null ? state.bandScale : 1,
          sweepTex,
          sweepMix: sweepTex ? sweepMixVal : 0,
        });
      } else if (state.seg === "arrive" || state.seg === "dirty-dissolve") {
        const count = dims.arrive;
        const idx = nearestProtected("arrive", state.frame, count);
        if (idx != null) {
          const bitmap = cache.get("arrive", idx);
          const uv = uvFor(bitmap);
          glCtx.drawFrame(glCtx.getFrameTexture(bitmap), uv.scale, uv.offset, [0.059, 0.106, 0.09]);
        } else if (holdReady) {
          // hold-only degrade: no arrive sequence yet (or it failed to load) —
          // stand on dirty-off with a slow 1.06 -> 1.0 scale settle instead of
          // a baked dolly-in; still-dirty is crossfading over this via its
          // own opacity, so this only needs to be right once that reveals it.
          const t = range(state.p, SEG.arriveStart, SEG.arriveEnd);
          const zoomed = zoomUv(scale, offset, getFocus(), lerp(1.06, 1.0, t));
          glCtx.drawHold({ L: 0, c: 0, ringMix: 0, mist: 0, time: 0, uvScale: zoomed.scale, uvOffset: zoomed.offset, winRect: dims.chamber });
        }
      } else if (state.seg === "close") {
        const count = dims.close;
        const idx = nearestProtected("close", state.frame, count);
        if (idx != null) {
          const bitmap = cache.get("close", idx);
          const uv = uvFor(bitmap);
          glCtx.drawFrame(glCtx.getFrameTexture(bitmap), uv.scale, uv.offset, [0.059, 0.106, 0.09]);
        } else if (holdReady) {
          // hold-only degrade: dirty-off, static — the lock/ring UI (fading
          // in as the door "seats") carries the sense of the door closing.
          glCtx.drawHold({ L: 0, c: 0, ringMix: 0, mist: 0, time: 0, uvScale: scale, uvOffset: offset, winRect: dims.chamber });
        }
      } else if (state.seg === "open" || state.seg === "clean-dissolve") {
        const count = dims.open;
        const idx = nearestProtected("open", state.frame, count);
        if (idx != null) {
          const bitmap = cache.get("open", idx);
          const uv = uvFor(bitmap);
          glCtx.drawFrame(glCtx.getFrameTexture(bitmap), uv.scale, uv.offset, [0.059, 0.106, 0.09]);
        } else if (holdReady) {
          // hold-only degrade: clean-off (door still closed, light off) —
          // the 0.95-1.00 dissolve then carries this into the clean still.
          glCtx.drawHold({ L: 0, c: 1, ringMix: 1, mist: 0, time: 0, uvScale: scale, uvOffset: offset, winRect: dims.chamber });
        }
      }
    } else if (ctx2d) {
      draw2dFallback(state, rectW, rectH);
    }
  }

  function draw2dFallback(state, w, h) {
    const { dispW, dispH, offX, offY } = coverRectCss(w, h, texAspect, getFocus());
    const drawImg = (img, alpha = 1) => {
      if (!img) return;
      ctx2d.globalAlpha = alpha;
      ctx2d.drawImage(img, -offX, -offY, dispW, dispH);
      ctx2d.globalAlpha = 1;
    };
    const drawSeqFrame = (seg, count) => {
      const idx = nearestProtected(seg, state.frame, count);
      if (idx != null) drawImg(cache.get(seg, idx));
    };
    ctx2d.clearRect(0, 0, w, h);
    if (state.seg === "hold" && holdReady) {
      const { dirtyOff, dirtyOn, cleanOn, cleanOff, baked } = holdImgs2d;
      if (state.L < 1 && state.c < 0.001) {
        drawImg(dirtyOff); drawImg(dirtyOn, state.L);
      } else if (state.c >= 0.999) {
        drawImg(cleanOn); drawImg(cleanOff, 1 - state.L);
      } else {
        const pts = [[0, dirtyOn], [0.25, baked["baked-025"]], [0.5, baked["baked-050"]], [0.75, baked["baked-075"]], [1, cleanOn]];
        let i = 0;
        while (i < pts.length - 2 && state.c > pts[i + 1][0]) i++;
        const [c0, img0] = pts[i], [c1, img1] = pts[i + 1];
        const t = c1 === c0 ? 0 : (state.c - c0) / (c1 - c0);
        drawImg(img0); drawImg(img1, t);
      }
    } else if (state.seg === "arrive" || state.seg === "dirty-dissolve") {
      const idx = nearestProtected("arrive", state.frame, dims.arrive);
      if (idx != null) drawImg(cache.get("arrive", idx));
      else if (holdImgs2d["dirty-off"]) drawImg(holdImgs2d["dirty-off"]);
    } else if (state.seg === "close") {
      const idx = nearestProtected("close", state.frame, dims.close);
      if (idx != null) drawImg(cache.get("close", idx));
      else if (holdImgs2d["dirty-off"]) drawImg(holdImgs2d["dirty-off"]);
    } else {
      const idx = nearestProtected("open", state.frame, dims.open);
      if (idx != null) drawImg(cache.get("open", idx));
      else if (holdImgs2d["clean-off"]) drawImg(holdImgs2d["clean-off"]);
    }
  }

  const LOADING_TEXT = "Loading the demonstration…";

  function updateUI(state) {
    // stage tone and captions run identically whether or not the heavy
    // assets are ready (captions are just text/timing, no dependency on the
    // canvas or hold layers being loaded).
    const toneIn = range(state.p, 0.13, 0.30);
    const toneOut = range(state.p, 0.90, 0.97);
    const tone = clamp(toneIn - toneOut, 0, 1);
    const mineral = [232, 238, 233], dark = [15, 26, 23];
    const mix = mineral.map((v, i) => Math.round(lerp(v, dark[i], tone)));
    stage.style.backgroundColor = `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
    stage.style.setProperty("--tone-op", tone.toFixed(3));

    captions.forEach((el) => {
      const a = Number(el.dataset.from), b = Number(el.dataset.to);
      const w = 0.02;
      const o = a === 0 ? 1 - range(state.p, b - w, b) : range(state.p, a, a + w) * (1 - range(state.p, b - w, b));
      el.style.opacity = o.toFixed(3);
      el.style.transform = `translateY(${((1 - o) * 10).toFixed(1)}px)`;
      el.classList.toggle("is-on", o > 0.02);
    });
    if (progressFill) progressFill.style.transform = `scaleX(${state.p.toFixed(4)})`;

    if (!ready) {
      // P1 fix: while the heavy hold-layer/close-sequence assets are still
      // loading, computeState(p) already reports the FULL-CYCLE state (it's
      // a pure function of p alone) — timer, lock, status would all read as
      // if the demonstration were actually running, and the untextured
      // WebGL canvas would render solid black if shown. Never show the
      // canvas here; show the best available still instead, and replace the
      // rail with an explicit loading notice rather than a fabricated
      // timer/status. Brief requirement: no blank/black frames, page reads
      // before media loads.
      if (canvasEl) canvasEl.style.opacity = "0";
      const showClean = state.p >= SEG.openStart && stillClean && stillClean.complete && stillClean.naturalWidth > 0;
      const showMid = !showClean && state.p >= SEG.holdStart && midStillBitmap;
      if (stillMid) stillMid.style.opacity = showMid ? "1" : "0";
      if (stillClean) stillClean.style.opacity = showClean ? "1" : "0";
      if (stillDirty) stillDirty.style.opacity = (showClean || showMid) ? "0" : "1";
      if (rail) rail.style.opacity = "1";
      if (statusEl && statusEl.textContent !== LOADING_TEXT) statusEl.textContent = LOADING_TEXT;
      if (ringWrap) ringWrap.style.opacity = "0";
      if (readout) readout.textContent = "";
      if (lockEl) lockEl.classList.remove("is-locked");
      if (unlockLine) unlockLine.style.opacity = "0";
      root.classList.remove("in-cycle", "is-done");
      return;
    }

    const stillDirtyOp = 1 - range(state.p, SEG.dirtyEnd, SEG.dissolveInEnd);
    const canvasOp = range(state.p, SEG.dirtyEnd - 0.01, SEG.dissolveInEnd) * (1 - range(state.p, SEG.dissolveOutStart, SEG.dissolveOutEnd));
    if (stillDirty) stillDirty.style.opacity = stillDirtyOp.toFixed(3);
    if (canvasEl) canvasEl.style.opacity = canvasOp.toFixed(3);
    if (stillClean) stillClean.style.opacity = "1"; // sits underneath; revealed as canvas fades
    if (stillMid) stillMid.style.opacity = "0"; // only ever used pre-ready

    if (ringFill) {
      ringFill.style.strokeDashoffset = String(RING_CIRC * (1 - clamp((state.p - HOLD.timerStart) / (HOLD.timerEnd - HOLD.timerStart), 0, 1)));
      // Ring "breathes" (client round 2) while the cycle is actually
      // running and on screen — reduceMotion never reaches here at all
      // (the whole live engine goes static instead, see the top of this
      // file), but the CSS animation itself still carries a defensive
      // @media guard the same way the lock-icon transition does.
      ringFill.classList.toggle("is-breathing", state.locked && sectionVisible);
    }
    if (readout) readout.textContent = state.timer;
    if (lockEl) lockEl.classList.toggle("is-locked", state.locked);
    if (statusEl && statusEl.textContent !== state.status) statusEl.textContent = state.status;

    // Rail (and the lock icon nested inside it, .se-lock) must be fully
    // gone before the reveal dissolve starts (now at 0.975, see SEG above) —
    // otherwise it ghosts through the cross-dissolve into the clean still.
    // 0.93-0.95 finishes the fade-out with a good margin to spare.
    const railOp = range(state.p, 0.12, 0.16) * (1 - range(state.p, 0.93, 0.95));
    if (rail) rail.style.opacity = railOp.toFixed(3);
    // ring/readout: hidden entirely before the lock engages, then fades in
    // exactly as the door seats (0.30-0.32) — before that the rail shows
    // status text only ("Compartment 2", etc).
    if (ringWrap) ringWrap.style.opacity = range(state.p, 0.30, 0.32).toFixed(3);
    if (unlockLine) {
      const uo = range(state.p, 0.84, 0.845) * (1 - range(state.p, 0.895, 0.90));
      unlockLine.style.opacity = uo.toFixed(3);
    }
    root.classList.toggle("in-cycle", state.locked);
    root.classList.toggle("is-done", state.p >= HOLD.timerEnd && state.p < SEG.openStart);
  }

  function positionRail() {
    if (!dims || !rail) return;
    const stageRect = stage.getBoundingClientRect();
    const c = chamberToCss(stageRect.width, stageRect.height, dims.chamber, texAspect, getFocus());
    // Set on .story-pin (the shared ancestor of .story-stage and .story-ui)
    // so the custom properties actually inherit down to .se-rail — it lives
    // in .story-ui, a *sibling* of .story-stage, not a descendant of it, so
    // setting them on .story-stage alone (as before) never reached it and
    // .se-rail was silently falling back to the CSS defaults (60%/20%/30%).
    const target = pin || stage;
    target.style.setProperty("--chamber-left", `${(c.left / stageRect.width) * 100}%`);
    target.style.setProperty("--chamber-top", `${(c.top / stageRect.height) * 100}%`);
    target.style.setProperty("--chamber-width", `${(c.width / stageRect.width) * 100}%`);
    target.style.setProperty("--chamber-height", `${(c.height / stageRect.height) * 100}%`);
    if (isPhone) { rail.removeAttribute("data-mode"); rail.style.left = ""; rail.style.top = ""; rail.style.transform = ""; return; }

    // Desktop: the rail defaults to sitting beside the chamber's right edge
    // (mode "side", pure CSS via the vars above). If that would push its own
    // right edge past the viewport (minus a 24px margin), pin it to the
    // viewport's right edge instead (mode "right"); if THAT then overlaps
    // the chamber, fall back to a compact strip above it (mode "above").
    const VIEWPORT_MARGIN = 24, GAP = 22; // 1.4rem @ 16px root
    const chamberViewport = { left: stageRect.left + c.left, top: stageRect.top + c.top, width: c.width, height: c.height };
    // Use the rail's worst-case size (its CSS max-width, and a generous
    // height covering the 3-line "unlock" state), not its width at this
    // instant: the status text's length changes every few percent of scroll
    // ("Compartment 2" vs "Locked · cycle running" vs "Done · 4:52"), and
    // positionRail() is only re-run on load/resize/breakpoint-change, not on
    // every render(p) tick — deciding the layout mode from momentary content
    // width would leave it wrong for every other status string.
    const railWidth = 300;
    const railHeight = 100;
    const sideLeft = chamberViewport.left + chamberViewport.width + GAP;
    const vw = window.innerWidth;
    let mode = "side";
    if (sideLeft + railWidth > vw - VIEWPORT_MARGIN) {
      const rightModeLeft = vw - VIEWPORT_MARGIN - railWidth;
      mode = rightModeLeft < chamberViewport.left + chamberViewport.width ? "above" : "right";
    }
    rail.dataset.mode = mode;
    if (mode === "side") {
      rail.style.left = ""; rail.style.top = ""; rail.style.transform = "";
    } else if (mode === "right") {
      rail.style.left = `${vw - VIEWPORT_MARGIN - railWidth - stageRect.left}px`;
      rail.style.top = `${chamberViewport.top + chamberViewport.height * 0.55 - stageRect.top}px`;
      rail.style.transform = "translateY(-50%)";
    } else {
      // above: right-aligned to the viewport margin, sitting just above the chamber's top edge
      rail.style.left = `${vw - VIEWPORT_MARGIN - railWidth - stageRect.left}px`;
      rail.style.top = `${chamberViewport.top - stageRect.top - railHeight - GAP}px`;
      rail.style.transform = "none";
    }
  }

  // Desktop only: the caption box is fixed bottom-left per spec, but its
  // HEIGHT varies with how many lines its text wraps to at the current
  // viewport width, and that can be tall enough to reach the (also
  // viewport-dependent) chamber rect — confirmed at 1280px, where the
  // longest caption wraps one line further than at 1440+. Escalate: try the
  // default compact size; if any of the four captions would still intersect
  // the chamber, drop one font step (.se-captions--tight); if that still
  // isn't enough, dock the whole caption block under the header instead
  // (data-pos="top") rather than ship an overlap.
  function positionCaptions() {
    if (!dims || !captionsBox || isPhone) { if (captionsBox) { captionsBox.classList.remove("se-captions--tight"); captionsBox.removeAttribute("data-pos"); } return; }
    const stageRect = stage.getBoundingClientRect();
    const c = chamberToCss(stageRect.width, stageRect.height, dims.chamber, texAspect, getFocus());
    const chamberViewport = { left: stageRect.left + c.left, top: stageRect.top + c.top, right: stageRect.left + c.left + c.width, bottom: stageRect.top + c.top + c.height };

    const anyIntersects = () => captions.some((el) => {
      const r = el.getBoundingClientRect();
      return !(r.right < chamberViewport.left || chamberViewport.right < r.left || r.bottom < chamberViewport.top || chamberViewport.bottom < r.top);
    });

    captionsBox.classList.remove("se-captions--tight");
    captionsBox.removeAttribute("data-pos");
    if (!anyIntersects()) return;
    captionsBox.classList.add("se-captions--tight");
    if (!anyIntersects()) return;
    captionsBox.setAttribute("data-pos", "top");
  }

  function render(p, force) {
    const state = computeState(p);
    lastState = state;
    drawCanvas(state, force);
    updateUI(state);
    window.__story = {
      state: () => ({ ...lastState }),
      // test-only: draw once at `p` with `mist` forced to a specific value
      // (bypassing the normal envelope) so the no-veil/readability check can
      // compare mist-on vs mist-off without altering engine state.
      debugRenderMist: (p2, mistValue) => {
        const s = computeState(p2);
        s.mistOverride = mistValue;
        drawCanvas(s, true);
      },
      // test-only: draw once at `p` with explicit overrides for L/c/mist/
      // bandScale, isolating exactly what a pixel-accuracy assertion needs
      // (e.g. bandScale:0 to check the pure dirty/clean mix without the
      // working-light sweep or glow perturbing the comparison).
      debugRenderRaw: (p2, overrides = {}) => {
        const s = computeState(p2);
        if (overrides.L != null) s.LOverride = overrides.L;
        if (overrides.c != null) s.cOverride = overrides.c;
        if (overrides.mist != null) s.mistOverride = overrides.mist;
        if (overrides.bandScale != null) s.bandScale = overrides.bandScale;
        if (overrides.sweepMix != null) s.sweepOverride = overrides.sweepMix;
        drawCanvas(s, true);
        return s;
      },
      // test-only: the uv cover-fit params and on-screen rect for the canvas
      // as it's currently sized, plus manifest.chamber and hold dims — lets
      // a test convert a screen point to the exact texture UV the shader
      // sampled there, to compare against source assets pixel-for-pixel.
      debugCanvasParams: () => {
        const rectW = canvasEl.clientWidth || stage.clientWidth;
        const rectH = canvasEl.clientHeight || stage.clientHeight;
        const rect = canvasEl.getBoundingClientRect();
        const { scale, offset } = coverUvGl(texAspect, rectW, rectH, getFocus());
        return { scale, offset, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, chamber: dims && dims.chamber, holdW: dims && dims.hold && dims.hold.w, holdH: dims && dims.hold && dims.hold.h, seqBase, isPhone, useP, assetSet: useP ? "p" : "d" };
      },
      // test-only: the whole canvas as top-left-origin RGBA, read via
      // gl.readPixels (works with preserveDrawingBuffer:false — see
      // StoryGL.readPixelsFull). Call right after debugRenderRaw/debugRenderMist
      // in the same synchronous step, before any paint can occur.
      debugReadCanvas: () => (glCtx ? glCtx.readPixelsFull() : null),
      // test-only: cache diagnostics for chasing loader/eviction bugs
      debugCacheInfo: () => ({
        orderLength: cache.order.length,
        order: cache.order.slice(),
        closeLoaded: (dims && dims.close ? Array.from({ length: dims.close }, (_, i) => cache.has("close", i)) : []),
        openLoaded: (dims && dims.open ? Array.from({ length: dims.open }, (_, i) => cache.has("open", i)) : []),
        arriveLoaded: (dims && dims.arrive ? Array.from({ length: dims.arrive }, (_, i) => cache.has("arrive", i)) : []),
        protectedKeys: Array.from(cache.protectedKeys),
      }),
      // test-only: draw whatever bitmap is actually stored in the cache for
      // (seg,i) to a small canvas and return a pixel sample, to verify the
      // cached bitmap really is the frame it claims to be.
      debugCachedBitmapSample: (seg, i) => {
        const bm = cache.slots[seg] && cache.slots[seg][i];
        if (!bm) return null;
        const c = document.createElement("canvas");
        c.width = 64; c.height = 64;
        const ctx = c.getContext("2d");
        ctx.drawImage(bm, 0, 0, 64, 64);
        return { width: bm.width, height: bm.height, sample: Array.from(ctx.getImageData(0, 0, 64, 64).data) };
      },
    };
  }

  // Forces a redraw even if p/mist-clock look unchanged — used after an
  // asset finishes loading (a nearest-fallback frame can now be replaced by
  // the exact one) and after resize, where the cache-skip in drawCanvas()
  // would otherwise (correctly, for its normal purpose) do nothing.
  function requestRender() { render(lastState.p, true); }

  // ------------------------------------------------------------- rAF / mist
  function frameLoop(ts) {
    rafId = null;
    const dt = lastFrameTs != null ? Math.min(64, ts - lastFrameTs) : 16.7;
    lastFrameTs = ts;
    const advanceMist = pinActive && sectionVisible && lastState.L > 0 && !document.hidden && !reduceMotion;
    if (advanceMist) mistClock += dt;
    if (lastState.seg === "hold" && holdReady) drawCanvas(lastState);
    if (pinActive || advanceMist) rafId = requestAnimationFrame(frameLoop);
  }
  function ensureLoop() {
    if (rafId == null && (pinActive || (lastState.L > 0 && sectionVisible))) {
      lastFrameTs = null;
      rafId = requestAnimationFrame(frameLoop);
    }
  }

  // --------------------------------------------------------------- resize
  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, isPhone ? 2 : 1.5);
    canvasEl.style.width = "100%";
    canvasEl.style.height = "100%";
    if (glCtx) glCtx.resize(rect.width, rect.height, dpr);
    else { canvasEl.width = Math.round(rect.width * dpr); canvasEl.height = Math.round(rect.height * dpr); if (ctx2d) ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0); }
    positionRail();
    positionCaptions();
    requestRender();
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nowPhone = window.matchMedia("(max-width: 760px)").matches;
      isPhone = nowPhone; // layout breakpoint: always safe to update immediately
      const nowUseP = computeUseP();
      if (nowUseP !== useP) {
        // Asset-set switch (orientation change, not necessarily a layout
        // breakpoint change): reload the sequences under the new set. The
        // current progress (p, driven by scroll) is untouched by this —
        // only which frames/camera render it changes.
        useP = nowUseP;
        if (manifest) pickDims();
        cache.clearAll();
        loadingStarted = false;
        holdReady = false; closeReady = false; ready = false;
        startLoading();
      }
      resizeCanvas();
      if (ScrollTrigger) ScrollTrigger.refresh();
    }, 150);
  });

  // ------------------------------------------------------------ intersect
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) startLoading(); });
    }, { rootMargin: "150% 0px" }).observe(root);

    new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        sectionVisible = e.isIntersecting;
        ensureLoop();
      });
    }, { rootMargin: "0px" }).observe(root);

    new IntersectionObserver((entries) => {
      entries.forEach((e) => { farOffscreen = !e.isIntersecting; });
    }, { rootMargin: "200% 0px" }).observe(root);
  } else {
    startLoading();
    sectionVisible = true;
    farOffscreen = false;
  }

  document.addEventListener("visibilitychange", ensureLoop);

  // -------------------------------------------------------------- pin
  render(0);
  resizeCanvas();
  ScrollTrigger.create({
    trigger: root,
    start: "top top",
    end: () => "+=" + Math.round(window.innerHeight * 5.5),
    pin,
    pinSpacing: true,
    scrub: 0.35,
    anticipatePin: 1,
    invalidateOnRefresh: true,
    onUpdate: (self) => { render(self.progress); ensureLoop(); },
    onRefresh: (self) => { resizeCanvas(); render(self.progress); },
    onToggle: (self) => { pinActive = self.isActive; ensureLoop(); },
  });

  // Reload-with-restored-scroll fix: this ScrollTrigger.create() call above
  // computes its OWN initial pin start/end and fires an immediate onUpdate/
  // onRefresh synchronously, using whatever the CURRENT scroll position is
  // at that instant. On a fresh navigation that's always 0 (harmless — p=0
  // needs no sequence data). But when the browser restores a non-zero
  // scroll position on reload, that first synchronous call runs against
  // this early, pre-image-load layout — hero and other above-the-fold
  // images haven't necessarily decoded yet, so the page (and this
  // section's true top offset) can still grow, and the immediately-
  // computed progress for the real, already-nonzero scrollY can land
  // anywhere, stale relative to the final layout (confirmed by direct
  // repro: real Chrome reload at a mid-story scroll position leaves the
  // pin/spacer mis-set and the stage area blank). A refresh once the page
  // has actually finished loading recomputes start/end against the FINAL
  // layout and re-fires onRefresh with the correct progress for the
  // current (real) scroll position, resyncing the pin and the render.
  window.addEventListener("load", () => { if (ScrollTrigger) ScrollTrigger.refresh(); });
}
