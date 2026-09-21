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
// Gate 3 defect #5 (cache-busting): a static `import` specifier is
// resolved by the browser's module preloader at parse time, in parallel
// with the rest of document parsing, before initStory() ever runs -- a
// dynamic `import('./story-gl.js?v=' + build)` would instead be awaited
// mid-function (inside startLoading(), right where `glCtx = new
// StoryGL(...)` happens today), adding a network round-trip at exactly
// the point that currently just constructs an already-loaded class,
// delaying first paint of the canvas-based content. Baking the token as
// a static specifier keeps load timing unchanged at the cost of a second
// hardcoded location (README's cache-busting bump list, item 5, covers
// it) -- picked deliberately over the dynamic-import alternative for
// that reason. Bump this token together with every other location listed
// in README.md's "Cache-busting token" section.
import { StoryGL } from "./story-gl.js?v=20260921f";

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Gate 3 defect #4 (cache-busting): Stream B stamps the release build id
// on <html data-build="..."> plus ?v= on its own static refs. Every URL
// THIS module fetches (manifest, hold stills, sequence frames, GL noise
// textures) goes through decodeOne/decodeOneCapped/the one direct
// fetch() below, so appending the token there covers all of them from
// one place rather than touching each call site. Works identically if
// the attribute is absent (no-op, url returned unchanged) — never
// required for the engine to function.
const BUILD_ID = document.documentElement.dataset.build || null;
function versioned(url) {
  if (!BUILD_ID) return url;
  return url + (url.includes("?") ? "&" : "?") + "v=" + encodeURIComponent(BUILD_ID);
}
// Gate 1 requirement: diagnostics must never be on by default in
// production. `window.__story` (test-only state/debug hooks, incl. pixel-
// accuracy readback) is now only installed when explicitly requested via
// ?csdiag=1 or localStorage csdiag=1 — a default load exposes nothing.
const DIAG = /(?:^|[?&])csdiag=1(?:&|$)/.test(location.search) || (() => {
  try { return localStorage.getItem("csdiag") === "1"; } catch (e) { return false; }
})();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
const range = (p, a, b) => (a === b ? (p >= a ? 1 : 0) : smooth((p - a) / (b - a)));
const linFrac = (p, a, b) => (a === b ? (p >= a ? 1 : 0) : clamp((p - a) / (b - a), 0, 1));

// ---- storyboard constants (plans/DIRECTION-v5.md) --------------------------
// F. (2026-09-15 quality pass): the pin was shortened from 5.5·vh to 4.0·vh,
// and the hold ("cleaning") phase — previously 0.58 of total progress (0.32
// to 0.90), 58% of the pin — is rebalanced down to 0.42 (42%, comfortably
// under the ≤45% target) so scroll-through feels less like a long dead
// zone. Every other boundary is scaled up proportionally within its own
// side of the hold (pre-hold segments by k = (1-0.42)/(1-0.58) = 1.38095;
// post-hold segments by the same k; hold-internal HOLD.* offsets rescaled
// by 0.42/0.58 = 0.72414) so the *relative* pacing of dirty/arrive/close and
// open/dissolve-out is unchanged — only the hold is compressed. See
// REPORT-F.md for the full derivation and old->new boundary table.
const SEG = {
  dirtyEnd: 0.1381,
  // The 0.10-0.13 dissolve (dirty still -> arrive[0]) was checked against
  // the real arrive frames via gen/record-story.mjs's contact sheet and
  // found fighting, not reading as a cut-with-a-short-dissolve: the mat
  // close-up's shoe silhouette and the wide 3-compartment establishing shot
  // ghost through each other for a good third of the window (see f-011/
  // f-012 in screenshots/v5/motion/1440x900/). Shortened to 0.02 per the
  // fallback instruction for exactly this case. arriveStart is left
  // alone — that's the asset-timing boundary where arrive content itself
  // starts, not the dissolve's own visual duration.
  dissolveInEnd: 0.1657,
  arriveStart: 0.1795, arriveEnd: 0.3590,
  closeStart: 0.3590, closeEnd: 0.4419,
  holdStart: 0.4419, holdEnd: 0.8619,
  openStart: 0.8619, openEnd: 0.9310,
  // The p=0.90-1.0 reveal was found double-exposing two unrelated
  // compositions (the open-door chamber and the full mat reveal) cross-
  // dissolved over the whole tail — the same "fighting" failure mode as the
  // entry dissolve, just at the exit. Fix mirrors that one: open[dims.open-1]
  // (openEnd is already reached by dissolveOutStart, so the canvas already
  // just holds that frozen frame from there) stays fully opaque until
  // dissolveOutStart, THEN a short dissolve, landing on the clean still by
  // dissolveOutEnd — a cut with a breath, not a long crossfade.
  dissolveOutStart: 0.9655, dissolveOutEnd: 0.9862,
};
const HOLD = {
  lightUpEnd: 0.4998,
  cleanRampAEnd: 0.7460, // c 0 -> 0.80
  cleanRampBEnd: 0.8185, // c 0.80 -> 1.0
  lightDownStart: 0.8185, lightDownEnd: 0.8619,
  mistInStart: 0.4709, mistInEnd: 0.5360,
  mistFull: 0.6809,
  mistOutEnd: 0.8040,
  timerStart: 0.4419, timerEnd: 0.8329,
  // Working-light sweep (real Blender pack, round 3): the emissive band
  // travels left->right across the pair over the 24 frames and is already
  // dark at both frame 0 and frame 23 (a real render, not a synthetic
  // mask), so a plain wrap at the loop point is invisible — no separate
  // ease-in/out envelope needed on top; L alone (already ramping in/out at
  // the edges of the hold) handles the fade. ~3 passes across the hold.
  // Deterministic in p (floor(cycles*t*count) mod count — see
  // computeState) so scrubbing forward/backward reconstructs the identical
  // frame every time.
  sweepStart: 0.4419, sweepEnd: 0.8329, sweepCycles: 3,
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
// CS-04 retune: CLOSE_EXP=1.7 was an unvalidated heuristic ("roughly 60% of
// scroll distance to the first third of frames"). Replaced with the actual
// measured cumulative visual distance between adjacent close frames — a
// downsampled (64x64 grayscale) per-adjacent-frame RMS, cumulatively
// summed and normalized to [0,1] — for each camera's real assets (see
// qa/final-2026-09-21/stream-a/scripts/measure-frame-distance.mjs and its
// logs/frame-distance-measurements.json; measured max deltas (re-run
// after Stream C's 930daf8 chamber clean-shoe promotion, which touched
// open's pixel content only — geometry/count/timing/chamber rect
// unchanged): d_close 38.84, p_close 46.61 (byte-identical to the
// pre-930daf8 measurement, confirming close frames themselves are
// untouched), d_open 32.65 (was 34.12), p_open 41.30 (was 42.79) —
// consistent with the contract's own reference numbers for the same
// audit method, and open's per-frame delta shape stays smoothly spread
// across the sequence rather than bunched at one end — OPEN_EXP=1's
// no-remap decision below still holds against the new frames). Index i of
// each array is the fraction of the close swing's TOTAL visual motion that
// has occurred by the time frame i is reached; frameForCumulative() inverts
// it (t -> continuous frame index) so uniform scroll now produces uniform
// PERCEIVED door motion instead of uniform frame-count motion.
const CLOSE_CUM = {
  d: [0, 0.0867, 0.2037, 0.3062, 0.4136, 0.5102, 0.5873, 0.6467, 0.6942, 0.7358, 0.7728, 0.8031, 0.8287, 0.8523, 0.8742, 0.8971, 0.9194, 0.9388, 0.9561, 0.9712, 0.9831, 0.9918, 0.9975, 1],
  p: [0, 0.068, 0.1795, 0.2868, 0.3957, 0.4877, 0.5588, 0.6167, 0.6694, 0.7177, 0.7538, 0.7806, 0.8081, 0.8353, 0.8617, 0.8867, 0.9109, 0.932, 0.9515, 0.9679, 0.9813, 0.9913, 0.9976, 1],
};
// Inverts a cumulative-distance table: given t in [0,1] (fraction of total
// scroll-segment traversed), returns the continuous frame index whose
// cumulative visual distance equals t (linear interpolation between the two
// bracketing measured frames). Falls back to a plain linear map if the
// table's frame count doesn't match the live asset count (e.g. a manifest
// swap to a differently-sized sequence — keeps the engine correct even if
// these constants ever drift out of sync with the assets on disk).
function frameForCumulative(cum, t, count) {
  if (!cum || cum.length !== count) return t * (count - 1);
  t = clamp(t, 0, 1);
  let i = 0;
  while (i < cum.length - 1 && cum[i + 1] < t) i++;
  const c0 = cum[i], c1 = cum[Math.min(i + 1, cum.length - 1)];
  const frac = c1 > c0 ? (t - c0) / (c1 - c0) : 0;
  return Math.min(count - 1, i + frac);
}
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
// CS-03: explicit decoded-memory byte budget for the non-protected sliding
// window, ON TOP OF the frame-count budget above — whichever is stricter
// wins. A decoded 1536x1024 RGBA frame is ~6.29MB (1536*1024*4); 40MB is
// room for roughly the 20-frame count budget's worth at that resolution
// (the frame-count budget is normally the binding constraint at this
// resolution — the byte budget exists as a hard backstop against a future
// higher-resolution asset regenerate silently blowing the memory budget
// even while staying under the frame-count cap).
// Round 10: raised 40MB -> 64MB (~10 frames at 6.29MB each, up from ~6).
// Root-caused a persistent hold that survived the priority-queue rewrite:
// with all four sequences now loading somewhat concurrently (by design —
// that's the whole point of the priority queue), a single shared 40MB
// non-protected window was too small to hold even ONE segment's nearby
// frames without them being evicted by the OTHER three segments' own
// loads landing in the same shared budget -- confirmed directly
// (qa/.../stream-a/lag/release4/): `close` frames near the actively-
// needed one were resident only sparsely (endpoints + a couple of
// leftovers), non-protected bytes sitting right at the old 40MB ceiling.
// 64MB still leaves comfortable headroom under the 180MB MAX_TOTAL_BYTES
// total ceiling (measured protected/fixed overhead ~100-105MB with sweep
// capped, so 64MB non-protected keeps the worst case ~165-170MB, still
// under 180MB).
const MAX_RESIDENT_BYTES = 64 * 1024 * 1024;
// CS-03 hard ceiling: a genuine cap on TOTAL decoded bytes (protected +
// non-protected), unlike MAX_RESIDENT_BYTES above which only ever bounded
// the non-protected LRU slice. With sweep capped to <=1024x683 (see
// sweepCapDims — was the single largest fixed contributor at full
// 1536x1024x24 frames, ~151MB), the fixed protected floor (24 sweep +
// close/open/arrive endpoints) plus the 40MB LRU budget should stay
// comfortably under this. Enforced in loadSeqFrame: a NON-PROTECTED
// background load (arrive/open progressive prefetch — never a protected
// or in-window frame, which are load-bearing for correctness) is skipped
// once total resident bytes reach this ceiling, and retried on the next
// progressive pass once eviction frees room.
const MAX_TOTAL_BYTES = 180 * 1024 * 1024;
const bitmapBytes = (bm) => (bm && bm.width && bm.height ? bm.width * bm.height * 4 : 0);

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
  constructor(max = MAX_RESIDENT_FRAMES, maxBytes = MAX_RESIDENT_BYTES) {
    this.max = max;
    this.maxBytes = maxBytes; // explicit decoded-memory byte budget (CS-03)
    this.bytes = 0; // sum of (width*height*4) for every currently-resident bitmap, protected included
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
  _slot(seg) { if (!this.slots[seg]) this.slots[seg] = []; return this.slots[seg]; }
  has(seg, i) { return !!this._slot(seg)[i]; }
  get(seg, i) {
    const b = this._slot(seg)[i];
    if (b) this._touch(seg, i);
    return b || null;
  }
  set(seg, i, bitmap) {
    if (this._slot(seg)[i]) return;
    this._slot(seg)[i] = bitmap;
    this.bytes += bitmapBytes(bitmap);
    this._touch(seg, i);
    this._evictIfNeeded();
  }
  _dropBitmap(seg, i, bitmap) {
    this._slot(seg)[i] = null;
    this.bytes -= bitmapBytes(bitmap);
    if (this.onEvict) this.onEvict(bitmap);
    if (bitmap.close) bitmap.close();
  }
  _touch(seg, i) {
    const key = `${seg}:${i}`;
    const idx = this.order.indexOf(key);
    if (idx >= 0) this.order.splice(idx, 1);
    this.order.push(key);
  }
  // CS-02 fix: the previous implementation seeded liveCount from
  // this.order.length, which includes protected entries (permanently-
  // protected endpoints/sweep frames AND the short-lived viewing-window
  // frames). Once protected entries alone exceed `max` (24 sweep frames +
  // 6 endpoints already does, against a nominal budget of 20), liveCount
  // could never drop at or below max by evicting only non-protected keys,
  // so eviction degenerated into "evict every non-protected frame it scans
  // past" — confirmed directly: right after `ready`, only close[0]/
  // close[23] survived out of 24. Fix: count only non-protected resident
  // entries against the budget; protected entries are fixed overhead on
  // top, never counted and never evicted here.
  _liveNonProtectedCount() {
    let n = 0;
    for (const key of this.order) if (!this._isProtected(key)) n++;
    return n;
  }
  // Byte budget applies only to the non-protected count's own bytes (same
  // scope as the frame-count budget — protected frames are fixed overhead,
  // never evicted here either way) so the two budgets are directly
  // comparable/combinable rather than one silently overriding the other.
  _nonProtectedBytes() {
    let b = 0;
    for (const key of this.order) {
      if (this._isProtected(key)) continue;
      const [seg, iStr] = key.split(":");
      b += bitmapBytes(this._slot(seg)[Number(iStr)]);
    }
    return b;
  }
  _evictIfNeeded() {
    let liveCount = this._liveNonProtectedCount();
    let liveBytes = this._nonProtectedBytes();
    let cursor = 0;
    while ((liveCount > this.max || liveBytes > this.maxBytes) && cursor < this.order.length) {
      const key = this.order[cursor];
      if (this._isProtected(key)) { cursor++; continue; }
      this.order.splice(cursor, 1);
      const [seg, iStr] = key.split(":");
      const i = Number(iStr);
      const bitmap = this._slot(seg)[i];
      if (bitmap) {
        liveBytes -= bitmapBytes(bitmap);
        this._dropBitmap(seg, i, bitmap);
      }
      liveCount--;
      // cursor NOT incremented: the splice already shifted the next
      // candidate into this position.
    }
  }
  // nearest loaded index to `i` in segment `seg`, bounded to `maxDist`
  // steps away (default: unbounded, for callers that explicitly want the
  // old "closest available, however far" behavior — e.g. the 2D fallback's
  // very first paint). CS-02/CS-04 fix: the story engine itself now always
  // passes a small bounded maxDist (see nearestProtected/WINDOW_RADIUS)
  // so a missing frame can no longer resolve to a frame from deep in the
  // sequence — once ready, an out-of-window miss returns null and the
  // caller holds the last coherent frame instead (see drawCanvas).
  nearest(seg, i, count, maxDist = Infinity) {
    const slot = this._slot(seg);
    if (slot[i]) return i;
    for (let d = 1; d <= maxDist && d < count; d++) {
      if (i - d >= 0 && slot[i - d]) return i - d;
      if (i + d < count && slot[i + d]) return i + d;
    }
    return null;
  }
  // Evict every resident (and protected) entry whose key starts with
  // `prefix` — used to release one camera's frames once a breakpoint/
  // camera switch has swapped a new, fully-loaded set into place (see
  // switchCamera()), instead of blanking everything the instant the
  // switch begins.
  evictPrefix(prefix) {
    const keep = [];
    for (const key of this.order) {
      if (key.startsWith(prefix)) {
        const [seg, iStr] = key.split(":");
        const i = Number(iStr);
        const bitmap = this._slot(seg)[i];
        if (bitmap) this._dropBitmap(seg, i, bitmap);
      } else keep.push(key);
    }
    this.order = keep;
    for (const key of Array.from(this.protectedKeys)) if (key.startsWith(prefix)) this.protectedKeys.delete(key);
  }
  clearAll() {
    Object.keys(this.slots).forEach((seg) => {
      this.slots[seg].forEach((b, i) => { if (b) this._dropBitmap(seg, i, b); });
      this.slots[seg] = [];
    });
    this.order = [];
    this.bytes = 0;
    this.protectedKeys.clear(); // pickDims() re-registers these for the new breakpoint right after
    this.windowKeys.clear();
  }
}

// CS-02: exported (additive, no behavior change) so FrameCache's eviction/
// protection/nearest-fallback invariants can be unit-tested directly
// against the real class, not a hand-copied re-implementation that could
// drift out of sync. See qa/final-2026-09-21/stream-a/scripts/
// frame-cache.test.mjs.
export { FrameCache, MAX_RESIDENT_FRAMES, MAX_RESIDENT_BYTES };

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
  const skipBtn = root.querySelector(".story-skip");
  if (!stage || !canvasEl) return;

  // F. skip control: always wired (works before assets finish loading, and
  // in the WebGL/2D fallback paths) — jumps past the pinned demonstration to
  // #outcomes, respecting reduced-motion for the scroll itself.
  if (skipBtn) {
    skipBtn.addEventListener("click", () => {
      const target = document.getElementById("outcomes");
      if (!target) return;
      const heading = document.getElementById("outcomes-h");
      const header = document.querySelector(".site-header");
      const headerH = header ? header.getBoundingClientRect().height : 0;
      // Bug fix (CS-07): #outcomes (the section) starts above its own
      // eyebrow paragraph, ABOVE #outcomes-h itself -- landing on the
      // section's own top instead of the heading's undershoots by that
      // eyebrow's height, which is small relative to a tall viewport but,
      // confirmed in WebKit at 844x390, pushes the heading (739px down)
      // entirely past a 390px-tall viewport. Target the heading's own
      // position (falling back to the section if the heading is somehow
      // missing) so it's the heading itself that lands 16px below the
      // header, matching the "at least 16px from viewport edges" rule
      // applied to the story's own captions/rail.
      const anchor = heading || target;
      const top = anchor.getBoundingClientRect().top + window.scrollY - headerH - 16;
      const focusHeading = () => {
        if (!heading) return;
        const hadTabindex = heading.hasAttribute("tabindex");
        if (!hadTabindex) heading.setAttribute("tabindex", "-1");
        // preventScroll: focusing during/just after an in-flight smooth
        // scroll otherwise lets the browser's own focus-scroll-into-view
        // behavior fight the scroll already under way.
        heading.focus({ preventScroll: true });
        if (!hadTabindex) heading.addEventListener("blur", () => heading.removeAttribute("tabindex"), { once: true });
      };
      if (reduceMotion) {
        // Immediate correct jump: no animation to wait out, so focus can
        // follow the scroll on the very next frame.
        window.scrollTo({ top, behavior: "auto" });
        focusHeading();
        return;
      }
      // Bug fix (CS-07): the previous code called heading.focus()
      // synchronously right after starting the smooth scroll, so the
      // browser's default focus-scroll-into-view algorithm fired mid-
      // animation and fought the in-flight scrollTo — confirmed to settle
      // short, leaving ~279px of outgoing story still above #outcomes at
      // 390x844 instead of the heading landing below the header. Move
      // focus only once the scroll has actually settled.
      window.scrollTo({ top, behavior: "smooth" });
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        // Bug fix (CS-07): the target `top` above is computed from a
        // snapshot taken before the scroll starts. Confirmed in WebKit at
        // 844x390 landscape on a fresh load (before the pinned story's own
        // ScrollTrigger has finished sizing its spacer): the document can
        // still grow taller WHILE the smooth scroll is in flight, shifting
        // #outcomes-h hundreds of px further down than where the scroll
        // actually lands. Re-check the heading's real position once the
        // scroll has settled and correct once, instantly, rather than
        // trusting the pre-scroll snapshot.
        if (heading) {
          const wanted = headerH + 16;
          const actual = heading.getBoundingClientRect().top;
          if (Math.abs(actual - wanted) > 24) {
            window.scrollTo({ top: window.scrollY + (actual - wanted), behavior: "auto" });
          }
        }
        focusHeading();
      };
      if ("onscrollend" in window) {
        window.addEventListener("scrollend", settle, { once: true });
      } else {
        // Safari/WebKit fallback (no scrollend event as of this writing):
        // poll scrollY until it stops moving for a few consecutive frames.
        let last = window.scrollY, stableFrames = 0;
        const poll = () => {
          if (settled) return;
          if (Math.abs(window.scrollY - last) < 1) {
            stableFrames++;
            if (stableFrames >= 3) return settle();
          } else stableFrames = 0;
          last = window.scrollY;
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }
      setTimeout(settle, 900); // hard cap in case neither path fires
    });
  }

  const statusSteps = statusEl ? JSON.parse(statusEl.dataset.steps || "[]") : [];
  const RING_CIRC = 175.9;

  function goStatic(reason) {
    root.classList.add("is-static");
    if (statusEl && statusSteps.length) statusEl.textContent = statusSteps[statusSteps.length - 1].text;
    if (DIAG) window.__story = { state: () => ({ ready: false, staticFallback: true, reason }) };
  }

  // Reduced motion always gets the static beats. Missing GSAP/ScrollTrigger,
  // or a browser/GPU that can't actually create a WebGL context (checked by
  // attempting getContext, not just testing for the constructor's presence),
  // also degrades gracefully — every one of these branches returns, so
  // execution can never fall through to ScrollTrigger.create() below without
  // both libraries and a real WebGL context. See code-map.md Summary #1.
  if (reduceMotion) return goStatic("reduced-motion");
  if (!gsap || !ScrollTrigger) return goStatic("no-gsap");
  const __webglProbe = document.createElement("canvas");
  const __hasWebGL = !!(__webglProbe.getContext("webgl") || __webglProbe.getContext("experimental-webgl"));
  if (!__hasWebGL) return goStatic("no-webgl");

  const seqBase = root.dataset.seq || "assets/seq/v5";
  // isPhone: LAYOUT breakpoint only (stacked stage/rail/caption vs desktop
  // overlay rail), keyed on viewport width per the design spec.
  let isPhone = window.matchMedia("(max-width: 760px)").matches;
  // D. short-landscape compact mode: viewport height <= 520px, or height <
  // 0.6*width with height <= 720px (landscape phones / small tablets) — see
  // css/story.css's .is-short-landscape block. Re-evaluated on every resize
  // alongside isPhone.
  let isShortLandscape = false;
  function computeShortLandscape() {
    const w = window.innerWidth, h = window.innerHeight;
    return h <= 520 || (h < 0.6 * w && h <= 720);
  }
  // useP: ASSET-SET selection, keyed on the stage's own ORIENTATION (its
  // rendered aspect ratio), independent of isPhone. A portrait-ish stage
  // (e.g. a tablet viewport with the desktop layout) still needs the p/
  // portrait camera set to avoid the severe cover-fit cropping a landscape
  // camera suffers at aspect < ~0.95; a wide phone-in-landscape stage still
  // wants d. Re-evaluated on resize/orientation change; see the resize
  // handler below for the reload-on-change logic.
  let useP = computeUseP();
  // Round 10 (revised plan, item 3): a lighter 1024px-wide desktop frame
  // set (assets/seq/v5/d1024/, generated by build3d/machine-v5/
  // pack-d1024.mjs from the shipped 1536px set -- a pure resize, same
  // registration/crop) for viewports where the full 1536px set is more
  // resolution than the display can actually show: viewport width
  // <=1440 and devicePixelRatio <=1.5. A retina 1440-wide laptop renders
  // the chamber at ~1580 device px (1440 * ~1.1 chamber-rect scale) even
  // at DPR 1 once the cover-fit crop is applied, and a DPR>1.5 display
  // needs the extra source resolution to stay sharp -- so both are
  // excluded, keeping the full 1536px set there unless a future
  // measurement says otherwise. Desktop-only (useP has its own,
  // independently-sized p/ set already).
  let useLite = computeUseLite();
  let manifest = null;
  let dims = null; // manifest[cameraKey(useP, useLite)]
  let texAspect = 1.5;
  const getFocus = () => (useP ? FOCUS_PHONE : FOCUS_DESKTOP);

  function computeUseP() {
    const rect = stage.getBoundingClientRect();
    const aspect = rect.height > 0 ? rect.width / rect.height : 1;
    return aspect < 0.95;
  }
  function computeUseLite() {
    const dpr = window.devicePixelRatio || 1;
    return window.innerWidth <= 1440 && dpr <= 1.5;
  }
  // Single source of truth for the manifest key / asset folder name / cache
  // key prefix for a given (phone, lite) pair -- every call site that used
  // to hardcode `useP ? "p" : "d"` now goes through this, so the d1024
  // variant is just a third value of the same axis, not a separate code
  // path duplicated everywhere.
  function cameraKey(p, lite) { return p ? "p" : (lite ? "d1024" : "d"); }

  // CS-02/CS-05: `cache` is reassignable so switchCamera() can swap in a
  // fully-loaded replacement atomically (see below); segKey() namespaces
  // every seg key by the CURRENT live camera so a mid-switch load into a
  // separate cache instance can never collide with / silently overwrite a
  // resident frame from the other camera at the same numeric index.
  let cache = new FrameCache(MAX_RESIDENT_FRAMES);
  let currentBase = null; // seqBase + "/d" or "/p" for the LIVE camera; used by priority re-fetch
  let switchingCamera = false;
  const segKey = (seg) => cameraKey(useP, useLite) + "_" + seg;
  // last real, on-screen-coherent bitmap per bare segment name — held and
  // redrawn (never left blank) whenever the exact/near requested frame
  // isn't resident yet. Survives camera switches (see switchCamera): it is
  // only ever replaced by another successfully-drawn frame, never cleared
  // by a cache eviction.
  const lastGood = { arrive: null, close: null, open: null };
  let glCtx = null; // StoryGL instance, if WebGL is available
  let ctx2d = null; // 2D fallback context
  let holdImgs2d = {}; // <img>/ImageBitmap for the 2D fallback path
  let holdReady = false;
  let closeReady = false;
  let loadFailed = false;
  let ready = false; // hold + close loaded
  let loadingStarted = false;
  let midStillBitmap = null; // P1 fix: small baked-050 standby, see updateUI
  // CS-03: decoded-byte estimate for the 6 always-resident hold-layer
  // bitmaps (not tracked by FrameCache, which only covers arrive/close/
  // open/sweep) — updated wherever hold layers are (re)assigned, exposed
  // via debugCacheInfo for peak-memory reporting.
  let holdBytesEstimate = 0;
  const sumHoldBytes = (hold) => Object.values(hold || {}).reduce((s, bm) => s + bitmapBytes(bm), 0);

  let lastState = { p: 0, seg: "dirty", frame: 0, L: 0, c: 0, mist: 0, timer: "0:00", locked: false, status: "", ready: false };
  let mistClock = 0;
  let lastFrameTs = null;
  let rafId = null;
  let sectionVisible = false;
  let farOffscreen = true;
  let pinActive = false;

  cache.onEvict = (bitmap) => { if (glCtx) glCtx.dropFrameTexture(bitmap); };

  // Round 10: a Worker-based decode pool (fetch()+createImageBitmap() off
  // the main thread, js/story-worker.js) was built and measured here, on
  // the reasoning that WebKit's ~25ms/frame decode (3x Chromium's ~9ms)
  // might be blocking rAF. Team lead's revised round-10 plan asked to
  // skip it unless a direct main-thread trace showed decode actually
  // blocking rAF in WebKit -- traced it (webkit-raf-trace.mjs, A/B: the
  // Worker path vs a temporarily-forced main-thread path, same scroll
  // pass, both viewports): rAF frame gaps stayed under ~48ms in BOTH
  // conditions, zero gaps over 50ms either way. Main-thread decode is
  // NOT meaningfully blocking rAF in WebKit -- the async fetch+decode
  // Promise chain already yields between awaits, so the ~25ms figure is
  // real wall-clock decode latency, not main-thread-blocking jank. The
  // Worker added real complexity (a whole message-queue priority
  // problem, root-caused and fixed this same round) without addressing
  // an actual rAF-blocking issue, so it's removed; decode is back on the
  // main thread, exactly as it was before round 10's Worker experiment.
  async function decodeOne(url) {
    try {
      const res = await fetch(versioned(url));
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
      const res = await fetch(versioned(url));
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

  // CS-03 memory ceiling: sweep is only ever composited as a soft, blended
  // "working light" overlay (see drawHold's sweepTex/sweepMix), never
  // shown at full opacity/detail the way arrive/close/open frames are — so
  // unlike those, it doesn't need full 1536x1024 decode resolution. All 24
  // sweep frames are PERMANENTLY protected (see pickDims's comment — the
  // full-cycle protection that made CS-02's accounting bug possible in the
  // first place), so they are the single largest fixed contributor to
  // total decoded memory (~6.29MB x24 = ~151MB uncapped). Capping their
  // decode size is a direct, bounded reduction of that fixed floor, unlike
  // the LRU byte budget (MAX_RESIDENT_BYTES) which only ever bounded the
  // non-protected slice. Formula intentionally more aggressive than
  // loadHoldLayers' hold-layer cap (0.75x + a 480px floor, vs hold's 1.25x
  // + 800px floor): a soft light glow tolerates more downscale than the
  // map layer's sharp cleaning-front edge does.
  function sweepCapDims() {
    const floor = 480, ceil = 1024;
    let w = Math.round((canvasEl.width || 1440) * 0.75);
    w = Math.max(floor, Math.min(ceil, w));
    const h = Math.round(w * (1024 / 1536)); // preserve the 1536x1024 source aspect
    return { w, h };
  }
  // `seg` here is the RAW (bare, un-namespaced) sequence name on disk, e.g.
  // "close" — bareSeg. `targetCache`/`cacheSeg` let a caller load into a
  // non-live cache instance under its own camera-namespaced key (see
  // switchCamera) without touching the currently-displayed frames.
  async function loadSeqFrame(base, bareSeg, i, count, targetCache = cache, cacheSeg = segKey(bareSeg)) {
    if (targetCache.has(cacheSeg, i)) return;
    // CS-03 hard ceiling: a background (non-essential) load is skipped once
    // total resident bytes hit MAX_TOTAL_BYTES. Protected/in-window frames
    // (endpoints, sweep, the actively-viewed neighborhood) are exempt —
    // they're load-bearing for correctness (see FrameCache._isProtected),
    // not optional prefetch. Skipped frames are simply retried by whichever
    // progressive/priority loader asked for them on its next pass, once
    // eviction of older non-protected frames frees room.
    const key = `${cacheSeg}:${i}`;
    if (!targetCache._isProtected(key) && targetCache.bytes >= MAX_TOTAL_BYTES) return;
    const idxStr = String(i).padStart(3, "0");
    const url = `${base}/${bareSeg}/${idxStr}.webp`;
    const bm = bareSeg === "sweep"
      ? await (() => { const { w, h } = sweepCapDims(); return decodeOneCapped(url, w, h); })()
      : await decodeOne(url);
    if (bm) {
      targetCache.set(cacheSeg, i, bm);
      // Live-site lag fix: upload to the GPU here, at decode time, instead
      // of leaving it for the first draw to pay for lazily (getFrameTexture
      // is idempotent — a bitmap already uploaded here is a cache hit when
      // drawCanvas calls it again). Moves the texImage2D cost off the
      // critical render-path frame and into the background loading flow,
      // where a few extra ms doesn't cost a dropped visual frame. Measured
      // upload cost was already small on average (0.65ms) but spiked to
      // 5ms+ on individual frames — this removes that spike from whatever
      // rAF happens to be the first one to draw a freshly-decoded frame.
      if (glCtx) glCtx.getFrameTexture(bm);
      if (targetCache === cache) requestRender();
    }
  }

  // Live-site lag fix (stream-a/lag/): this was a strictly SEQUENTIAL
  // single-stream loader (concurrency 1) despite three of these running
  // "in parallel" as separate async calls (arrive/close-remainder/open) —
  // each one individually could only ever have one decode in flight.
  // Diagnosed directly against the live site under realistic network
  // (20Mbps/40ms and 8Mbps/80ms CDP profiles, natural human scroll pace):
  // 20.5% of ready samples showed the engine holding a stale frame
  // (`resolveFrame`'s documented fallback), and 23 of 25 stalls had ZERO
  // requests in flight at that instant — the loader simply hadn't reached
  // that frame yet, a scheduling/throughput problem, not a bandwidth one
  // (near-identical stall counts on both network profiles confirms this).
  // Bounded-concurrency (default 6, tunable) fixes exactly that: same
  // "every Nth frame first" priority order, decoded in parallel instead
  // of one at a time, closing the gap between loader throughput and
  // natural scroll speed. See stream-a/lag/logs/*-summary.json for the
  // before numbers and the after re-measurement.
  // Round 9 fix: the "every 4th frame first" priority order was designed
  // to give a fast sparse overview of a segment the user hasn't reached
  // yet — but for the segment the user is ACTIVELY, continuously
  // scrolling through (confirmed to be `arrive`, loaded with top
  // priority right after readiness), it actively fights a steadily-
  // scrolling user, who needs frames in plain sequential order
  // (0,1,2,3,...), not (0,4,8,...,1,2,3,5,6,7,...). Measured directly
  // against the live site with page-side batched rAF sampling
  // (qa/.../stream-a/lag/release4/): natural-pace scrolling produced a
  // single CONTINUOUS 1.8s hold spanning arrive frames 7 through 34 (out
  // of 36) — not brief gaps, a sustained "always a few frames behind"
  // state through nearly the whole segment, exactly what a user would
  // call "laggy". Switched to plain sequential order, and raised default
  // concurrency 6 -> 8 (team lead's own originally-suggested 6-8 range)
  // for additional headroom given how much the segment still needs to
  // outrun natural scroll speed.
  async function loadSeqProgressive(base, bareSeg, count, targetCache = cache, cacheSeg = segKey(bareSeg), concurrency = 8) {
    if (!count) return;
    const order = Array.from({ length: count }, (_, i) => i);
    let next = 0;
    async function worker() {
      while (next < order.length) {
        if (farOffscreen) return; // stop background fetch once we've scrolled far away
        const i = order[next++];
        await loadSeqFrame(base, bareSeg, i, count, targetCache, cacheSeg);
      }
    }
    const n = Math.max(1, Math.min(concurrency, order.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
  }

  // CS-03 fix: readiness previously awaited each frame sequentially
  // (concurrency 1) via a plain `for` + `await` loop, serializing what are
  // independent network+decode operations. Bounded-concurrency pool (default
  // 5, tunable) — same total work, decoded in parallel, cutting readiness
  // wall-clock roughly by the concurrency factor on any connection where
  // requests aren't already saturating a single-connection bottleneck.
  async function loadSeqFramesConcurrent(base, bareSeg, count, targetCache = cache, concurrency = 5, cacheSeg = segKey(bareSeg)) {
    if (!count) return;
    let next = 0;
    async function worker() {
      while (next < count) {
        const i = next++;
        await loadSeqFrame(base, bareSeg, i, count, targetCache, cacheSeg);
      }
    }
    const n = Math.max(1, Math.min(concurrency, count));
    await Promise.all(Array.from({ length: n }, () => worker()));
  }

  // Priority re-fetch: called when drawCanvas needs a frame that isn't
  // resident and isn't within the bounded nearest-frame window (see
  // nearestProtected/WINDOW_RADIUS below). Fire-and-forget — loadSeqFrame's
  // own cache.has() check makes this idempotent against the regular
  // progressive/readiness loaders also converging on the same frame.
  function priorityFetch(bareSeg, i, count) {
    if (!currentBase || !count) return;
    loadSeqFrame(currentBase, bareSeg, i, count);
  }

  // Round 10: demand-driven priority queue, replacing the fixed loader
  // order (arrive->close->sweep->open / arrive+close concurrent). Team
  // lead's read of the raw natural-pace numbers found the holds occur at
  // fixed scroll points where a fixed loader order hasn't reached the
  // segment the user is actually in — true regardless of which exact
  // magnitude is right, and the 1280x720 reversal bug independently
  // confirmed a fixed order can leave the WRONG segment unloaded when the
  // user reverses. A priority queue keyed by distance from the CURRENTLY
  // requested frame — recomputed on every pick, so it naturally re-
  // prioritizes on every scroll update — generalizes and replaces both
  // the ad hoc ordering and the round-9 patches.
  //
  // Priority: the frame within the ACTIVE segment closest to the current
  // frame ranks best (0 = exact frame, 1 = one away, ...; "expanding
  // forward then backward" falls out naturally from plain absolute
  // distance). Frames in other segments rank behind all active-segment
  // frames, ordered by their segment's position in the viewing timeline
  // (arrive first, open last) as a reasonable fallback for a segment the
  // user hasn't reached yet. In-flight fetches are never cancelled —
  // `pending` items are simply removed once claimed by a worker and
  // stay claimed until that fetch resolves; a persistent worker pool
  // (bounded concurrency) just keeps picking whatever currently ranks
  // best among what's left.
  const SEG_VIEW_ORDER = { arrive: 0, close: 1, sweep: 2, open: 3 };
  // Round 10 (revised plan, item 2): expanding forward first at equal
  // distance -- a frame AHEAD of the current position (the direction a
  // user is most likely to keep scrolling in, and the direction any
  // fresh page load starts moving) wins over an equidistant frame
  // behind it, while still never beating a genuinely closer frame in
  // either direction. Encoded as rank = 2*distance for forward, +1 for
  // backward, so 2d < 2d+1 < 2(d+1): closer always wins regardless of
  // direction, direction only breaks a tie at the same distance.
  function distRank(idx, center) {
    const d = idx - center;
    return d >= 0 ? d * 2 : -d * 2 + 1;
  }
  function priorityRank(bareSeg, idx) {
    const cur = computeState(lastState.p);
    if (cur.seg === bareSeg) return distRank(idx, cur.frame);
    if (cur.seg === "hold" && bareSeg === "sweep") return distRank(idx, cur.sweepFrame);
    return 100000 + SEG_VIEW_ORDER[bareSeg] * 1000;
  }
  // Loads every not-yet-resident frame across arrive/close/sweep/open for
  // one camera (`camPrefix` = "d_"/"p_", `d` = that camera's manifest
  // dims), via a persistent worker pool that always picks the
  // currently-highest-priority remaining item. `keyFn(bareSeg)` lets the
  // caller target either the live `cache` (segKey, default) or a
  // switchCamera() shadow cache under its own prefix.
  async function priorityLoadAll(base, targetCache, d, concurrency = 8, keyFn = segKey) {
    const pending = [];
    const addSeg = (bareSeg, count) => {
      if (!count) return;
      for (let i = 0; i < count; i++) if (!targetCache.has(keyFn(bareSeg), i)) pending.push({ bareSeg, i });
    };
    addSeg("arrive", d.arrive); addSeg("close", d.close); addSeg("sweep", d.sweep); addSeg("open", d.open);
    const claimed = new Set();
    async function worker() {
      for (;;) {
        if (farOffscreen) return;
        let bestIdx = -1, bestRank = Infinity, anyPending = false;
        for (let k = 0; k < pending.length; k++) {
          const item = pending[k];
          if (!item) continue;
          anyPending = true;
          const key = `${item.bareSeg}:${item.i}`;
          if (claimed.has(key)) continue;
          const rank = priorityRank(item.bareSeg, item.i);
          if (rank < bestRank) { bestRank = rank; bestIdx = k; }
        }
        if (bestIdx === -1) {
          // Root-caused a persistent hold that survived every earlier fix
          // in this round (the byte-budget raise included): this used to
          // `return` here unconditionally, permanently retiring the
          // worker whenever everything currently unclaimed happened to
          // be in flight on OTHER workers at that instant. Workers exit
          // one by one as the queue drains, and since in-flight fetches
          // are deliberately never cancelled, a later requeue (below,
          // when a load completes but the frame still isn't resident --
          // e.g. evicted by budget pressure) can land with ZERO workers
          // left alive to ever notice it. Confirmed directly: a specific
          // viewport's `close` segment stabilized on exactly the frames
          // that happened to load before its last worker exited (cache
          // endpoints + two incidental survivors), while the actively-
          // needed frame sat re-queued and orphaned for the rest of the
          // pass -- a ~1.1s hold once the user actually reached it,
          // rescued only by resolveFrame()'s slow on-demand fetch.
          // Fix: only exit once the queue is truly, structurally empty
          // (no live entries at all); if items remain but are all
          // momentarily claimed, wait briefly and re-poll instead of
          // retiring, so a later requeue is always still being watched.
          if (!anyPending) return;
          await new Promise((resolve) => setTimeout(resolve, 40));
          continue;
        }
        const item = pending[bestIdx];
        const key = `${item.bareSeg}:${item.i}`;
        claimed.add(key);
        pending[bestIdx] = null;
        await loadSeqFrame(base, item.bareSeg, item.i, d[item.bareSeg], targetCache, keyFn(item.bareSeg));
        claimed.delete(key);
        // Bug found while investigating a persistent hold that survived
        // this priority queue's introduction (a viewport-specific case
        // where `close` never got loaded before a reversal, even though
        // it should have ranked first): loadSeqFrame() can return without
        // the frame ever becoming resident (the MAX_TOTAL_BYTES ceiling
        // check skips a non-essential decode once the budget's full) --
        // but this loop unconditionally dropped it from `pending`
        // (`pending[bestIdx] = null` above), permanently abandoning it
        // for the rest of this pass. The ONLY thing that then ever
        // rescued it was resolveFrame()'s slow, reactive, one-frame-at-a-
        // time on-demand fetch once the user actually scrolled onto it --
        // exactly matching the observed hold shape (several consecutive
        // frames, each paying a full fetch+decode round trip in series).
        // Re-queue instead of abandoning: if it's still not resident,
        // push it back so a later pick (once eviction elsewhere frees
        // ceiling headroom, or once it becomes the active/windowed frame
        // and exempt from the ceiling) can retry it. A short backoff
        // avoids the worker spinning tightly on a still-over-ceiling item.
        if (!targetCache.has(keyFn(item.bareSeg), item.i)) {
          pending.push(item);
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      }
    }
    const n = Math.max(1, Math.min(concurrency, pending.length || 1));
    await Promise.all(Array.from({ length: n }, () => worker()));
  }

  async function startLoading() {
    if (loadingStarted) return;
    loadingStarted = true;
    try {
      const res = await fetch(versioned(`${seqBase}/manifest.json`));
      manifest = await res.json();
    } catch (e) {
      loadFailed = true;
      goStatic("manifest-failed");
      return;
    }
    pickDims();
    measureHeaderHeight();
    positionRail(); // manifest.chamber is known now; the initial resizeCanvas() ran before this
    positionCaptions();
    const base = `${seqBase}/${cameraKey(useP, useLite)}`;
    currentBase = base;
    // Round 10: start the FULL priority-queue load (all four sequences)
    // as early as possible — `dims`/`base` are known as soon as
    // pickDims() above returns, well before hold layers or the close-
    // essential readiness fetch even start. This is round 9's "kick
    // arrive off early" generalized to every segment, via the priority
    // queue defined above: whichever frame is actually closest to the
    // current scroll position (arrive/frame 0 on a fresh load) naturally
    // wins priority regardless of segment, and re-prioritizes itself as
    // `lastState.p` changes — no separate per-segment kickoff logic
    // needed. `.then()` marks closeReady once the whole pass settles
    // (closeReady isn't read elsewhere, kept for parity with prior
    // rounds' semantics).
    const backgroundLoadPromise = priorityLoadAll(base, cache, dims, 8);
    backgroundLoadPromise.then(() => { closeReady = true; });

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
      // CS-03: hold-layer bitmaps are copied into fixed, reused GL textures
      // by setHoldLayer's texImage2D upload above — the CPU-side decoded
      // ImageBitmap is never read again after that, so release it
      // immediately (deterministic, not left to GC) rather than holding
      // both the GPU texture AND the CPU decode resident.
      Object.values(hold).forEach((bm) => { if (bm && bm.close) bm.close(); });
      holdBytesEstimate = 0; // freed above; hold-layer memory now lives only in the 6 fixed GL textures
      // real tileable mist noise (engine-level asset, not per-shot)
      Promise.all([
        decodeOne("assets/gl/noise-a.png"),
        decodeOne("assets/gl/noise-b.png"),
        decodeOne("assets/gl/noise-fine.png"),
      ]).then(([a, b, fine]) => { if (glCtx) glCtx.setNoiseTextures(a, b, fine); requestRender(); });
    } else {
      holdImgs2d = hold;
      holdImgs2d.baked = await loadBakedFallback(base);
      holdBytesEstimate = sumHoldBytes(hold) + sumHoldBytes(holdImgs2d.baked); // 2D fallback keeps these resident, unlike the GL path
    }

    // CS-03 retune: readiness previously gated on the FULL close (24
    // frames) AND FULL sweep (24 frames) sequences fully decoded before the
    // canvas could render anything — a multi-second synchronous wait on a
    // slow connection, even though most of those frames won't be seen for
    // many seconds of scroll (or a direction the user never takes). Now
    // that resolveFrame() (see below) holds the last coherent frame and
    // priority-refetches on any cache miss instead of ever jumping to a
    // distant frame, it's safe to gate readiness on a MUCH smaller set:
    // hold layers (already awaited above) plus a small neighborhood of
    // close frames around wherever the current scroll position actually
    // needs (usually 0/none on a fresh load — reload-with-restored-scroll
    // is the case where this matters) plus both continuity endpoints. The
    // remainder of close, all of sweep, arrive and open continue loading
    // in the background afterward, concurrently and non-blocking.
    if (dims.close) {
      const cur = computeState(lastState.p);
      const center = cur.seg === "close" ? cur.frame : 0;
      const essential = new Set([0, dims.close - 1]);
      for (let d = -WINDOW_RADIUS; d <= WINDOW_RADIUS; d++) {
        const i = center + d;
        if (i >= 0 && i < dims.close) essential.add(i);
      }
      await Promise.all(Array.from(essential, (i) => loadSeqFrame(base, "close", i, dims.close)));
    }
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
    // backgroundLoadPromise (started above, right after pickDims()) is
    // already running the full priority-queue load — nothing further to
    // kick off here.
  }

  function pickDims() {
    useP = computeUseP();
    useLite = computeUseLite();
    // If the manifest doesn't have a d1024 entry for any reason (e.g. an
    // older deployed manifest not yet regenerated), fall back to the
    // full-res "d" set rather than reading a missing dims object --
    // normalizing useLite itself here keeps every OTHER call site
    // (segKey, base URL, switchCamera) automatically consistent, since
    // they all derive from cameraKey(useP, useLite) too.
    if (useLite && !manifest.d1024) useLite = false;
    dims = manifest[cameraKey(useP, useLite)];
    texAspect = dims.w / dims.h;
    // protect the continuity-critical ends of each sequence from LRU
    // eviction — see the FrameCache constructor comment for why
    if (dims.arrive) cache.setProtected(segKey("arrive"), [0, dims.arrive - 1]);
    if (dims.close) cache.setProtected(segKey("close"), [0, dims.close - 1]);
    if (dims.open) cache.setProtected(segKey("open"), [0, dims.open - 1]);
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
    if (dims.sweep) cache.setProtected(segKey("sweep"), Array.from({ length: dims.sweep }, (_, i) => i));
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
      // raw linear scroll fraction, then the measured cumulative-distance
      // remap (CLOSE_CUM/frameForCumulative — see the constant's comment
      // above) — NOT range()'s smoothstep, which would add a second,
      // unwanted ease on top of the remap.
      const t = linFrac(p, SEG.closeStart, SEG.closeEnd);
      frame = d.close ? Math.round(frameForCumulative(CLOSE_CUM[useP ? "p" : "d"], t, d.close)) : 0;
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
  // zoomed in). `focus` here is a fraction in SCREEN space (0-1, same
  // convention as coverUvGl's own `focus` param: offset+screenUv*scale =
  // textureUv), not texture-UV space.
  function zoomUv(scale, offset, focus, zoom) {
    const sx = scale[0] / zoom, sy = scale[1] / zoom;
    return {
      scale: [sx, sy],
      offset: [offset[0] + (scale[0] - sx) * focus.x, offset[1] + (scale[1] - sy) * focus.y],
    };
  }

  // Round 4, item 3 (tightened in the addendum): convert a point derived
  // from manifest.chamber's rect (texture-UV-fraction [x,y,w,h]) into the
  // SCREEN-space focus fraction zoomUv expects, given the (pre-zoom) cover
  // scale/offset already in effect — inverts offset+screenUv*scale=
  // textureUv, i.e. screenUv=(textureUv-offset)/scale, clamped since the
  // point can fall slightly outside the visible crop at some aspect ratios.
  // `yBias` (0=chamber top edge, 0.5=chamber vertical centre) lets the
  // caller pull the vertical anchor toward the TOP of the chamber: in
  // zoomUv, a SMALLER focus.y produces a SMALLER new offset[1] (the crop
  // window's top-of-texture edge), which keeps more of what's ABOVE the
  // chamber (the cabinet top / logo band) and crops away more of what's
  // BELOW it (the counter/floor) — exactly the direction needed to shrink
  // the flat counter band without losing the cabinet top.
  function chamberFocusFrac(chamber, scale, offset, yBias = 0.5) {
    if (!chamber) return { x: 0.5, y: 0.5 };
    const cx = chamber[0] + chamber[2] / 2, cy = chamber[1] + chamber[3] * yBias;
    return {
      x: clamp((cx - offset[0]) / scale[0], 0, 1),
      y: clamp((cy - offset[1]) / scale[1], 0, 1),
    };
  }

  // Protects a small neighborhood around the frame actually being displayed
  // before asking for it — see FrameCache's windowKeys comment for why this
  // is necessary (background prefetch of the OTHER sequences would otherwise
  // race ahead and evict exactly what's on screen right now).
  // Live-site lag dig (round 8, stream-a/lag/after-live/dig-rootcause-
  // result.json): re-measured on release 3 with page-side batched rAF
  // sampling (ruling out the earlier per-step page.evaluate() harness as
  // an inflating factor — batched sampling found an equal-or-higher raw
  // stall fraction). Distance-from-nearest-resident-frame histogram on
  // every stall showed 349 of 364 (96%) within the ORIGINAL radius of 4 —
  // i.e. already-intended micro-holds, not the "distant jump" this
  // bounding exists to prevent. Of the remaining 15 genuinely-outside-
  // window stalls, every single one was at distance 5 or 6 — one or two
  // frames past the old boundary, never a real distant gap — so widening
  // to 6 directly closes that residual set (evidenced, not a guess) while
  // still bounding the "hold" to something well short of a real jump.
  const WINDOW_RADIUS = 6;
  // `bareSeg` is the on-disk sequence name ("arrive"/"close"/"open"/
  // "sweep"); internally namespaced by segKey() to the LIVE camera so a
  // background switchCamera() load (into a separate cache instance) can
  // never collide with what's actually on screen.
  function nearestProtected(bareSeg, frame, count) {
    if (!count) return null;
    const key = segKey(bareSeg);
    cache.setWindow(key, frame, WINDOW_RADIUS);
    // CS-02/CS-04 fix: bounded to WINDOW_RADIUS — see FrameCache.nearest's
    // comment. Previously unbounded, so a cache miss just past a segment
    // boundary could resolve to a frame from anywhere in the sequence
    // (the "distant nearest-frame fallback" named in the contract).
    return cache.nearest(key, frame, count, WINDOW_RADIUS);
  }
  function getCachedFrame(bareSeg, frame, count) {
    const idx = nearestProtected(bareSeg, frame, count);
    return idx != null ? cache.get(segKey(bareSeg), idx) : null;
  }
  // CS-02/CS-04/CS-05: resolves the bitmap to draw for a monotonic
  // sequence (arrive/close/open). If the requested frame (or something
  // within WINDOW_RADIUS of it) isn't resident, this NEVER falls back to a
  // distant/arbitrary frame — it prioritizes a direct fetch of the exact
  // missing frame and returns the last frame that WAS successfully drawn
  // for this segment, so the caller redraws that (holding a coherent
  // visual) instead of jumping or going blank. Returns null only when
  // nothing has ever been drawn for this segment yet (first paint before
  // any frame has loaded), in which case the caller's existing hold-only
  // degrade applies.
  //
  // Round 10: this docstring's "prioritizes a direct fetch of the exact
  // missing frame" was NOT actually true whenever a WINDOW_RADIUS-nearby
  // substitute existed -- the early `if (bitmap) return bitmap` below
  // returned the substitute WITHOUT ever calling priorityFetch for the
  // real requested frame, since `bitmap` (from getCachedFrame's bounded-
  // nearest lookup) is truthy as soon as ANY frame within radius 6 is
  // resident. Root-caused a persistent, exactly-reproducible ~1.1s hold
  // this way: a segment's permanently-protected endpoint (always
  // resident) sits within radius 6 of several frames, so the engine
  // silently substituted it and NEVER asked for the real one -- and
  // since the one-shot background priority queue (priorityLoadAll) had
  // already finished its pass by the time the user reached that
  // position, nothing else was ever going to fetch it either. Fix:
  // always fetch the EXACT frame on demand when it isn't resident,
  // independent of whether a nearby substitute was found for display --
  // "what to show right now" and "what to make resident" are separate
  // concerns; conflating them is what caused this.
  function resolveFrame(bareSeg, frame, count) {
    if (!cache.has(segKey(bareSeg), frame)) priorityFetch(bareSeg, frame, count);
    const bitmap = getCachedFrame(bareSeg, frame, count);
    if (bitmap) { lastGood[bareSeg] = bitmap; return bitmap; }
    return lastGood[bareSeg];
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
          if (sIdx != null) sweepTex = glCtx.getFrameTexture(cache.get(segKey("sweep"), sIdx));
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
        const bitmap = resolveFrame("arrive", state.frame, count);
        if (bitmap) {
          let uv = uvFor(bitmap);
          // Phone camera only: the wide "p" arrive frame, cover-fit into a
          // tall phone stage, leaves the machine small in the middle with a
          // large plain counter band below it (live QA round 2, item 3).
          // Digital-zoom in on the chamber during arrive — the baked camera
          // is genuinely moving in over this segment, so a matching digital
          // zoom on top of the real footage reads as coherent, not fake.
          // t=0 (p at or before arriveStart, INCLUDING the whole
          // dirty-dissolve segment so frame 0 never "pops" to a different
          // zoom when arrive proper begins) -> 1.6x; eases smoothly (same
          // smoothstep `range()` the hold-degrade above already uses) to
          // 1.0x by arriveEnd. Desktop ("d" camera) is untouched — its own
          // baked camera move already frames the chamber correctly.
          // Addendum: an initial 1.4x centred on the chamber still left a
          // ~36%-of-stage-height flat counter band below the cabinet
          // (measured directly, after/F/phone-arrive-zoom/band.json) —
          // raised to 1.6x AND biased the vertical focus up toward the
          // chamber's own top edge (yBias 0.18, not 0.5/centre) so the
          // extra zoom crops away more of the counter below the fascia
          // than it crops off the cabinet top/logo above the compartments.
          if (useP) {
            const t = range(state.p, SEG.arriveStart, SEG.arriveEnd);
            const zoom = lerp(1.6, 1.0, t);
            const focus = chamberFocusFrac(dims.chamber, uv.scale, uv.offset, 0.18);
            uv = zoomUv(uv.scale, uv.offset, focus, zoom);
          }
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
        const bitmap = resolveFrame("close", state.frame, count);
        if (bitmap) {
          const uv = uvFor(bitmap);
          glCtx.drawFrame(glCtx.getFrameTexture(bitmap), uv.scale, uv.offset, [0.059, 0.106, 0.09]);
        } else if (holdReady) {
          // hold-only degrade: dirty-off, static — the lock/ring UI (fading
          // in as the door "seats") carries the sense of the door closing.
          glCtx.drawHold({ L: 0, c: 0, ringMix: 0, mist: 0, time: 0, uvScale: scale, uvOffset: offset, winRect: dims.chamber });
        }
      } else if (state.seg === "open" || state.seg === "clean-dissolve") {
        const count = dims.open;
        const bitmap = resolveFrame("open", state.frame, count);
        if (bitmap) {
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
    const drawSeqFrame = (bareSeg, count) => {
      drawImg(resolveFrame(bareSeg, state.frame, count));
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
      const bitmap = resolveFrame("arrive", state.frame, dims.arrive);
      if (bitmap) drawImg(bitmap);
      else if (holdImgs2d["dirty-off"]) drawImg(holdImgs2d["dirty-off"]);
    } else if (state.seg === "close") {
      const bitmap = resolveFrame("close", state.frame, dims.close);
      if (bitmap) drawImg(bitmap);
      else if (holdImgs2d["dirty-off"]) drawImg(holdImgs2d["dirty-off"]);
    } else {
      const bitmap = resolveFrame("open", state.frame, dims.open);
      if (bitmap) drawImg(bitmap);
      else if (holdImgs2d["clean-off"]) drawImg(holdImgs2d["clean-off"]);
    }
  }

  const LOADING_TEXT = "Loading the demonstration…";

  function updateUI(state) {
    // stage tone and captions run identically whether or not the heavy
    // assets are ready (captions are just text/timing, no dependency on the
    // canvas or hold layers being loaded).
    // Rescaled with the F. pin/hold rebalance (see SEG/HOLD comment above):
    // 0.13/0.30 -> 0.1795/0.4143 (pre-hold zone, x1.38095); 0.90/0.97 ->
    // 0.8619/0.9586 (post-hold zone, same transform anchored at holdEnd).
    const toneIn = range(state.p, 0.1795, 0.4143);
    const toneOut = range(state.p, 0.8619, 0.9586);
    const tone = clamp(toneIn - toneOut, 0, 1);
    const mineral = [232, 238, 233], dark = [15, 26, 23];
    const mix = mineral.map((v, i) => Math.round(lerp(v, dark[i], tone)));
    stage.style.backgroundColor = `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
    stage.style.setProperty("--tone-op", tone.toFixed(3));

    captions.forEach((el) => {
      const a = Number(el.dataset.from);
      // Bug fix (CS-07): the last caption's data-to is 1.01, past the
      // scroll's actual max p of 1 — its fade-out window (b-w..b) then
      // never finishes inside the reachable range, so it stalls partway
      // (confirmed: opacity 0.5 at p=1, a permanent low-opacity ghost
      // rather than a clean removal). Clamp the fade-out target to 1 so
      // every caption, including one authored with to > 1, is fully gone
      // by the time scrolling actually ends.
      const b = Math.min(Number(el.dataset.to), 1);
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
    // All four thresholds below are rescaled with the F. pin/hold rebalance
    // (see SEG/HOLD comment): 0.12/0.16 -> 0.1657/0.2210 (pre-hold zone);
    // 0.93/0.95 -> 0.9033/0.9310 (post-hold zone); 0.30/0.32 -> 0.4143/0.4419
    // (pre-hold zone, ending exactly at the new holdStart); 0.84/0.845/
    // 0.895/0.90 -> 0.8185/0.8221/0.8583/0.8619 (hold zone).
    const railOp = range(state.p, 0.1657, 0.2210) * (1 - range(state.p, 0.9033, 0.9310));
    if (rail) rail.style.opacity = railOp.toFixed(3);
    // ring/readout: hidden entirely before the lock engages, then fades in
    // exactly as the door seats — before that the rail shows status text
    // only ("Compartment 2", etc).
    if (ringWrap) ringWrap.style.opacity = range(state.p, 0.4143, 0.4419).toFixed(3);
    if (unlockLine) {
      const uo = range(state.p, 0.8185, 0.8221) * (1 - range(state.p, 0.8583, 0.8619));
      unlockLine.style.opacity = uo.toFixed(3);
    }
    root.classList.toggle("in-cycle", state.locked);
    root.classList.toggle("is-done", state.p >= HOLD.timerEnd && state.p < SEG.openStart);
  }

  // D. Measure the real fixed header height (not a hard-coded assumption)
  // and expose it as --header-h on .story-pin, where css/story.css's
  // data-pos="top" caption fallback reads it via var(--header-h, 69px).
  function measureHeaderHeight() {
    const header = document.querySelector(".site-header");
    const target = pin || root;
    if (!header || !target) return;
    const bottom = header.getBoundingClientRect().bottom;
    target.style.setProperty("--header-h", `${Math.max(0, bottom)}px`);
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
    if (isPhone || isShortLandscape) { rail.removeAttribute("data-mode"); rail.style.left = ""; rail.style.top = ""; rail.style.transform = ""; return; }

    // Desktop: the rail defaults to sitting beside the chamber's right edge
    // (mode "side", pure CSS via the vars above). If that would push its own
    // right edge past the viewport (minus a 24px margin), pin it to the
    // viewport's right edge instead (mode "right"); if THAT then overlaps
    // the chamber, fall back to a compact strip above it (mode "above").
    const VIEWPORT_MARGIN = 24, GAP = 22; // 1.4rem @ 16px root
    const chamberViewport = { left: stageRect.left + c.left, top: stageRect.top + c.top, width: c.width, height: c.height };
    // D. Measure the rail's REAL rendered size (its worst-case content is
    // already on screen most of the time — the status text is long strings
    // like "Locked · cycle running" — rather than the previous hard-coded
    // 300x100 estimate, which could under- or over-estimate depending on the
    // current status string's actual wrapped height).
    rail.dataset.mode = "side";
    rail.style.left = ""; rail.style.top = ""; rail.style.transform = "";
    const measuredRail = rail.getBoundingClientRect();
    const railWidth = measuredRail.width || 300;
    const railHeight = measuredRail.height || 100;
    const sideLeft = chamberViewport.left + chamberViewport.width + GAP;
    const vw = window.innerWidth, vh = window.innerHeight;
    let mode = "side";
    if (sideLeft + railWidth > vw - VIEWPORT_MARGIN) {
      const rightModeLeft = vw - VIEWPORT_MARGIN - railWidth;
      mode = rightModeLeft < chamberViewport.left + chamberViewport.width ? "above" : "right";
    }
    rail.dataset.mode = mode;
    // Bug found in D. acceptance sweep: writing an absolute pin-local px
    // offset for the DEFAULT "side" mode (derived from a viewport-space
    // clamp) is only correct if `stageRect` was measured WHILE the section
    // is actually pinned. positionRail() can run (via resize/fonts.ready/
    // window.load) before the user has ever scrolled to the story section,
    // when `stageRect.top` is still its normal-flow document position (e.g.
    // +2000px) rather than its pinned-viewport position (~header height).
    // Baking a clamp computed from THAT snapshot into a fixed pin-local
    // `top`/`left` then renders wildly off-screen once the section is
    // actually pinned later (observed: rail top around -1250px). "side" mode
    // is pure CSS calc() off the --chamber-* custom properties (percentage-
    // based, so resolution/scroll-independent) precisely to avoid this class
    // of bug — restore that instead of overriding it with a stale px snapshot.
    let stale = false;
    if (mode === "side") {
      rail.style.left = ""; rail.style.top = ""; rail.style.transform = "";
    } else if (stageRect.bottom < 0 || stageRect.top > vh) {
      // "right"/"above" only trigger when the chamber is genuinely close to
      // a viewport edge, which only happens while the section is actually
      // near/in the viewport — but guard anyway: if the stage isn't
      // currently intersecting the viewport at all, this call's snapshot
      // can't be trusted (same staleness risk as above), so fall back to
      // unclamped pure-CSS positioning rather than bake in a bad value.
      rail.dataset.mode = "side";
      rail.style.left = ""; rail.style.top = ""; rail.style.transform = "";
      stale = true;
    } else {
      let railLeft, railTop, railTransform;
      if (mode === "right") {
        railLeft = vw - VIEWPORT_MARGIN - railWidth - stageRect.left;
        railTop = chamberViewport.top + chamberViewport.height * 0.55 - stageRect.top;
        railTransform = "translateY(-50%)";
      } else {
        // above: right-aligned to the viewport margin, sitting just above the chamber's top edge
        railLeft = vw - VIEWPORT_MARGIN - railWidth - stageRect.left;
        railTop = chamberViewport.top - stageRect.top - railHeight - GAP;
        railTransform = "none";
      }
      // D. safe-box clamp: pull the rail's final viewport-space rect fully
      // inside [headerBottom+16, vh-16] x [16, vw-16] — the "above" mode in
      // particular can otherwise land partly under a tall header on short
      // viewports. Convert to the rail's TOP-LEFT in viewport space first
      // (collapsing the translateY(-50%) centring into a plain top offset),
      // clamp that rect, then write it back as absolute left/top with no
      // transform. This is only trustworthy because we just confirmed above
      // that stageRect reflects the section's CURRENT on-screen position.
      const header = document.querySelector(".site-header");
      const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
      const safeTop = headerBottom + 16, safeBottom = vh - 16, safeLeft = 16, safeRight = vw - 16;
      const centred = railTransform === "translateY(-50%)";
      const railViewportLeft = stageRect.left + railLeft;
      const railViewportTop = stageRect.top + railTop - (centred ? railHeight / 2 : 0);
      const clampedLeft = clamp(railViewportLeft, safeLeft, Math.max(safeLeft, safeRight - railWidth));
      const clampedTop = clamp(railViewportTop, safeTop, Math.max(safeTop, safeBottom - railHeight));
      rail.style.left = `${clampedLeft - stageRect.left}px`;
      rail.style.top = `${clampedTop - stageRect.top}px`;
      rail.style.transform = "none";
    }

    // Gate-3 defect 3 fix: whichever mode landed the rail (including plain
    // CSS "side" positioning, which is chamber-relative and knows nothing
    // about the skip button), do one final measured check against the
    // actual rendered "Skip demonstration" button and push the rail clear
    // of it if they intersect. A full 1024-1440px x 700/800/900/1000px
    // sweep (Gate 3's own narrower report undersold the scope) found the
    // rail overlapping the skip button across nearly the whole width range
    // at height>=800, and overlapping the caption instead at height~700
    // (short-landscape layout) — a general, mode-independent corrective
    // check covers every case instead of chasing one more narrow band.
    if (!stale && skipBtn && !isPhone && !isShortLandscape) {
      const rr = rail.getBoundingClientRect();
      const sr = skipBtn.getBoundingClientRect();
      const intersects = !(rr.right < sr.left || sr.right < rr.left || rr.bottom < sr.top || sr.bottom < rr.top);
      if (intersects) {
        const stageRectNow = stage.getBoundingClientRect();
        const pushedTop = sr.bottom + 16; // clear of the skip button, viewport space
        const railViewportLeftNow = rr.left; // keep whatever horizontal placement the chosen mode already gave it
        const safeRight = vw - 16;
        const clampedLeftNow = clamp(railViewportLeftNow, 16, Math.max(16, safeRight - railWidth));
        rail.style.left = `${clampedLeftNow - stageRectNow.left}px`;
        rail.style.top = `${pushedTop - stageRectNow.top}px`;
        rail.style.transform = "none";
      }
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
  // D. Measure the tallest caption's real content height with ALL captions
  // temporarily made visible/static (so a wrapped-but-currently-hidden
  // caption isn't undercounted) — synchronous, no rAF between the class
  // toggle and the read, so there's nothing to paint in between.
  function measureTallestCaption() {
    if (!captionsBox) return 0;
    captionsBox.classList.add("se-captions--measuring");
    let maxH = 0;
    captions.forEach((el) => { maxH = Math.max(maxH, el.scrollHeight); });
    captionsBox.classList.remove("se-captions--measuring");
    return maxH;
  }

  function positionCaptions() {
    if (!dims || !captionsBox) return;
    if (isPhone || isShortLandscape) {
      // D. "make --se-caption-h fit the longest caption (measure on load and
      // resize, don't clip)": the CSS default (112px / 25vh) assumed a fixed
      // two-line caption; a long/injected caption at narrow widths can wrap
      // to 3 lines and overflow that fixed band (confirmed in the D.
      // acceptance sweep: phone captions overflowing the viewport bottom by
      // a few px near the end of the cycle). Measure the real tallest
      // caption and grow the band to fit, with the CSS value only as a floor.
      captionsBox.classList.remove("se-captions--tight");
      captionsBox.removeAttribute("data-pos");
      captionsBox.style.maxHeight = "";
      // Clear the desktop branch's inline height too: an inline style beats
      // any external stylesheet rule regardless of specificity, so a stale
      // px height set while desktop-sized would otherwise survive a resize
      // down into phone/short-landscape and override that layout's own
      // var(--se-caption-h)-driven height.
      captionsBox.style.height = "";
      // A sane minimum band (96px) rather than trying to read the CSS
      // default back out of getComputedStyle — a custom property's computed
      // value is returned as its literal token string (e.g. "25vh"), not a
      // resolved px number, so parsing it as a float would silently produce
      // nonsense (25) rather than an error.
      const MIN_CAPTION_H = 96;
      const tallest = measureTallestCaption();
      if (tallest > 0) root.style.setProperty("--se-caption-h", `${Math.max(MIN_CAPTION_H, tallest)}px`);
      // Gate-3 defect 3 fix (captions x rail): in short-landscape mode
      // css/story.css floats .se-rail on top of the caption row via
      // position:absolute (right/bottom) — the caption row itself is
      // `inset:0`, i.e. its OUTER box (solid --mineral background) always
      // spans the full band regardless of its own padding, so the rail's
      // opaque pill genuinely sits on top of the caption's opaque
      // background at that width x height range — confirmed by geometry
      // sweep, not just a text-reflow issue. Shrinking `right` alone did
      // NOT work: the base `.se-caption` rule (css/story.css) sets an
      // explicit `width: 100%`, which the short-landscape override never
      // redeclares, so the browser uses that explicit width outright and
      // ignores the auto-width-from-left/right computation `right` alone
      // relies on. A LIVE measurement of the rail's rendered width doesn't
      // work either: positionCaptions() only re-runs on resize/load/pin-
      // toggle, but the rail's own width changes every scroll tick as its
      // status text changes (short status vs. "Locked - cycle running"),
      // so a width baked in at the last structural event can go stale
      // mid-scroll and undershoot (confirmed: caption still overlapped the
      // rail by ~35px despite a nonzero reservation). Use the rail's own
      // CSS-declared worst case instead -- `.se-rail` is capped at
      // `max-width: 46%` in this mode -- so reserving the complementary
      // ~54% is correct regardless of the rail's current text and never
      // needs to track it live.
      captions.forEach((el) => { el.style.width = isShortLandscape ? "calc(54% - 16px)" : ""; });
      return;
    }
    captions.forEach((el) => { el.style.width = ""; });
    const stageRect = stage.getBoundingClientRect();
    const c = chamberToCss(stageRect.width, stageRect.height, dims.chamber, texAspect, getFocus());
    const chamberViewport = { left: stageRect.left + c.left, top: stageRect.top + c.top, right: stageRect.left + c.left + c.width, bottom: stageRect.top + c.top + c.height };

    const anyIntersects = () => captions.some((el) => {
      const r = el.getBoundingClientRect();
      return !(r.right < chamberViewport.left || chamberViewport.right < r.left || r.bottom < chamberViewport.top || chamberViewport.bottom < r.top);
    });

    // Safe box per spec D: [headerBottom+16, vh-16] x [16, vw-16]. The
    // captions box only ever grows upward (bottom-anchored, or top-anchored
    // in data-pos="top"), so a max-height keeps its top edge from crossing
    // out of view instead of letting long/injected text push it there.
    const header = document.querySelector(".site-header");
    const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
    const safeTop = headerBottom + 16, safeBottom = window.innerHeight - 16;
    const availableH = Math.max(80, safeBottom - safeTop);
    // Bug fix (CS-06): every .se-caption is position:absolute, so none of
    // them contribute to .se-captions's in-flow content height — max-height
    // alone caps a height that's already 0, it never GIVES the box a used
    // height, so overflow:hidden clips the active caption entirely (measured
    // at 1440x900: box 380x0px against a real ~380x116px active child).
    // Setting height (not just max-height) is what actually reserves the
    // space the absolutely-positioned active caption paints into.
    captionsBox.classList.remove("se-captions--tight");
    captionsBox.removeAttribute("data-pos");
    const applyHeight = () => {
      const tallest = measureTallestCaption();
      const boxH = Math.min(tallest, availableH);
      captionsBox.style.height = `${boxH}px`;
      captionsBox.style.maxHeight = `${boxH}px`;
      return tallest;
    };
    let tallest = applyHeight();
    // A short viewport (confirmed at 1193x800) can leave availableH smaller
    // than the default-size caption's real content height even with no
    // chamber overlap at all: capping height to availableH then still
    // clips the last ~4-5px of the caption. Escalate to the smaller font
    // step here too, the same way chamber overlap does below, whenever the
    // content itself doesn't fit the safe box — not only when it collides
    // with the chamber.
    if (tallest > availableH) {
      captionsBox.classList.add("se-captions--tight");
      tallest = applyHeight();
    }
    if (!anyIntersects()) return;
    captionsBox.classList.add("se-captions--tight");
    applyHeight();
    if (!anyIntersects()) return;
    captionsBox.setAttribute("data-pos", "top");
  }

  function render(p, force) {
    const state = computeState(p);
    lastState = state;
    drawCanvas(state, force);
    updateUI(state);
    if (!DIAG) return;
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
        return { scale, offset, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, chamber: dims && dims.chamber, holdW: dims && dims.hold && dims.hold.w, holdH: dims && dims.hold && dims.hold.h, seqBase, isPhone, useP, useLite, assetSet: cameraKey(useP, useLite) };
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
        nonProtectedLiveCount: cache._liveNonProtectedCount(),
        budget: cache.max,
        closeLoaded: (dims && dims.close ? Array.from({ length: dims.close }, (_, i) => cache.has(segKey("close"), i)) : []),
        openLoaded: (dims && dims.open ? Array.from({ length: dims.open }, (_, i) => cache.has(segKey("open"), i)) : []),
        arriveLoaded: (dims && dims.arrive ? Array.from({ length: dims.arrive }, (_, i) => cache.has(segKey("arrive"), i)) : []),
        sweepLoaded: (dims && dims.sweep ? Array.from({ length: dims.sweep }, (_, i) => cache.has(segKey("sweep"), i)) : []),
        protectedKeys: Array.from(cache.protectedKeys),
        switchingCamera,
        farOffscreen,
        useLite,
        assetSet: cameraKey(useP, useLite),
        // CS-03: explicit memory accounting — decoded FrameCache bitmap
        // bytes, the fixed hold-layer bitmap estimate (0 once uploaded to
        // GL and released — see loadHoldLayers callers), the byte budget,
        // and the live GL texture count (StoryGL self-caps at 24 for
        // sequence-frame textures; hold layers are a separate fixed 6).
        // NOTE: cacheBytes is the TOTAL decoded footprint (protected +
        // non-protected). nonProtectedMaxBytes only bounds the LRU
        // (non-protected) slice, same scope as the frame-count budget —
        // it does NOT bound the fixed protected overhead (all 24 sweep
        // frames + 6 endpoints, ~144MB+ at this resolution), which is a
        // known, unresolved limitation — see status/stream-a.md.
        cacheBytes: cache.bytes,
        nonProtectedBytes: cache._nonProtectedBytes(),
        nonProtectedMaxBytes: cache.maxBytes,
        holdBytesEstimate,
        glFrameTextureCount: glCtx ? glCtx.frameTexOrder.length : null,
        // CS-03 closure: real GPU-resident byte accounting (see
        // StoryGL.getGPUBytes), not just a texture count — sums
        // width*height*4 for every currently-live GL texture (sequence
        // frames + 6 hold layers + noise + sweep placeholder).
        gpuBytes: glCtx ? glCtx.getGPUBytes() : null,
      }),
      // test-only: draw whatever bitmap is actually stored in the cache for
      // (bareSeg,i) to a small canvas and return a pixel sample, to verify
      // the cached bitmap really is the frame it claims to be.
      debugCachedBitmapSample: (bareSeg, i) => {
        const seg = segKey(bareSeg);
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
    isShortLandscape = computeShortLandscape();
    root.classList.toggle("is-short-landscape", isShortLandscape);
    measureHeaderHeight();
    positionRail();
    positionCaptions();
    requestRender();
  }

  // CS-05 fix: switchCamera() double-buffers an asset-set (camera) change.
  // The previous implementation cleared the cache and set
  // holdReady/closeReady/ready to false SYNCHRONOUSLY on every camera
  // flip, which drove updateUI() into its "!ready" branch (canvas hidden,
  // opacity 0) for the entire reload — a real, reproducible blank stage on
  // resize/rotation across a breakpoint while pinned. Fix: load the new
  // camera's hold layers + close + sweep (the same set the initial
  // readiness gate waits on) into the SAME cache instance but under keys
  // namespaced to the NEW camera (see segKey/evictPrefix), while the live
  // useP/dims/texAspect/holdReady/ready stay pointed at the OLD camera the
  // whole time — the canvas keeps rendering the old camera, uninterrupted,
  // until the new one's essential assets are fully decoded. Only then does
  // an atomic swap flip useP/dims/texAspect/hold textures together in one
  // synchronous step, so no frame ever mixes old-camera geometry with
  // new-camera textures (or vice versa). The old camera's frames are
  // released (evictPrefix) only AFTER the new camera is live, bounding how
  // long two camera's worth of frames are ever resident at once.
  // targetUseLite is optional (defaults to the current useLite) so every
  // existing phone<->desktop call site (which only ever cares about the
  // useP axis) keeps working unchanged; the resize handler below passes
  // both explicitly when either axis crosses.
  async function switchCamera(targetUseP, targetUseLite = useLite) {
    if (!manifest || switchingCamera) return;
    if (targetUseLite && !manifest.d1024) targetUseLite = false;
    if (targetUseP === useP && targetUseLite === useLite) return; // no-op
    switchingCamera = true;
    try {
      const targetDims = manifest[cameraKey(targetUseP, targetUseLite)];
      if (!targetDims) return;
      const targetTexAspect = targetDims.w / targetDims.h;
      const targetBase = `${seqBase}/${cameraKey(targetUseP, targetUseLite)}`;
      const targetPrefix = cameraKey(targetUseP, targetUseLite) + "_";
      const oldPrefix = cameraKey(useP, useLite) + "_";

      const switchHold = await loadHoldLayers(targetBase);
      if (!switchHold) return; // keep showing the old camera; never blank on a failed switch

      if (targetDims.arrive) cache.setProtected(targetPrefix + "arrive", [0, targetDims.arrive - 1]);
      if (targetDims.close) cache.setProtected(targetPrefix + "close", [0, targetDims.close - 1]);
      if (targetDims.open) cache.setProtected(targetPrefix + "open", [0, targetDims.open - 1]);
      if (targetDims.sweep) cache.setProtected(targetPrefix + "sweep", Array.from({ length: targetDims.sweep }, (_, i) => i));
      // CS-03/CS-05 retune: mirror startLoading()'s reduced-readiness set —
      // only the close neighborhood around the CURRENT progress (the user
      // is actively mid-story during a live camera switch, so this matters
      // more here than on a fresh load) plus endpoints, not the full 24
      // frames, before the swap goes live. Sweep and the rest of close
      // continue in the background after the swap (below).
      if (targetDims.close) {
        const cur = computeState(lastState.p);
        const center = cur.seg === "close" ? cur.frame : 0;
        const essential = new Set([0, targetDims.close - 1]);
        for (let d = -WINDOW_RADIUS; d <= WINDOW_RADIUS; d++) {
          const i = center + d;
          if (i >= 0 && i < targetDims.close) essential.add(i);
        }
        await Promise.all(Array.from(essential, (i) => loadSeqFrame(targetBase, "close", i, targetDims.close, cache, targetPrefix + "close")));
      }

      // Atomic swap.
      useP = targetUseP;
      useLite = targetUseLite;
      dims = targetDims;
      texAspect = targetTexAspect;
      currentBase = targetBase;
      lastGood.arrive = null; lastGood.close = null; lastGood.open = null;
      if (glCtx) {
        glCtx.setHoldLayer("dirtyOff", switchHold["dirty-off"]);
        glCtx.setHoldLayer("dirtyOn", switchHold["dirty-on"]);
        glCtx.setHoldLayer("cleanOn", switchHold["clean-on"]);
        glCtx.setHoldLayer("cleanOff", switchHold["clean-off"]);
        glCtx.setHoldLayer("map", switchHold["map"]);
        glCtx.setHoldLayer("window", switchHold["window"]);
        // CS-03: same as startLoading() — free the CPU-side decode right
        // after the GL upload, not left to GC.
        Object.values(switchHold).forEach((bm) => { if (bm && bm.close) bm.close(); });
        holdBytesEstimate = 0;
      } else {
        // release the OLD camera's 2D-fallback bitmaps before dropping the reference
        Object.values(holdImgs2d).forEach((bm) => { if (bm && bm.close) bm.close(); else if (bm && typeof bm === "object") Object.values(bm).forEach((b) => b && b.close && b.close()); });
        holdImgs2d = switchHold;
        holdImgs2d.baked = await loadBakedFallback(targetBase);
        holdBytesEstimate = sumHoldBytes(switchHold) + sumHoldBytes(holdImgs2d.baked);
      }
      holdReady = true; ready = true;
      root.classList.add("is-ready");
      measureHeaderHeight(); positionRail(); positionCaptions();
      requestRender();

      // Bounded memory: release the old camera's frames now that the new
      // one is live, rather than holding both resident indefinitely.
      cache.evictPrefix(oldPrefix);

      // Round 10: same demand-driven priority queue as startLoading(),
      // targeted at this new camera's namespaced cache keys.
      priorityLoadAll(targetBase, cache, targetDims, 8, (bareSeg) => targetPrefix + bareSeg).then(() => { closeReady = true; });
    } finally {
      switchingCamera = false;
      // A resize/rotation that happened WHILE this switch was in flight is
      // dropped by the guard above (a second concurrent switch would race
      // the same cache/dims mutation) — catch up now if the live camera no
      // longer matches the current viewport.
      const recheckP = computeUseP();
      const recheckLite = computeUseLite();
      if (recheckP !== useP || recheckLite !== useLite) switchCamera(recheckP, recheckLite);
    }
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nowPhone = window.matchMedia("(max-width: 760px)").matches;
      isPhone = nowPhone; // layout breakpoint: always safe to update immediately
      const nowUseP = computeUseP();
      const nowUseLite = computeUseLite();
      if (nowUseP !== useP || nowUseLite !== useLite) {
        if (!manifest) {
          // Nothing has rendered yet — no "old camera" view to preserve,
          // so just flip; the in-flight startLoading()/pickDims() will
          // pick up this value once the manifest arrives.
          useP = nowUseP;
          useLite = nowUseLite;
        } else {
          switchCamera(nowUseP, nowUseLite); // async, double-buffered — see switchCamera()
        }
      }
      resizeCanvas();
      if (ScrollTrigger) ScrollTrigger.refresh();
    }, 150);
  });
  // D. acceptance requires re-positioning on load, fonts.ready, resize,
  // orientationchange and ScrollTrigger refresh. resize (above) covers most
  // browsers' orientation change too, but iOS Safari can fire
  // orientationchange without a matching resize, and a caption box measured
  // before the webfont swaps in can be the wrong height — both call the same
  // resizeCanvas() (which itself re-measures the header and repositions the
  // rail/captions) rather than duplicating that logic.
  window.addEventListener("orientationchange", () => resizeCanvas());
  window.addEventListener("load", () => resizeCanvas());
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => resizeCanvas()).catch(() => {});
  }

  // Round 10 (revised plan, item 1): start the full story load as soon as
  // the page is interactive after the hero paints, instead of waiting
  // for scroll proximity (the 150% IntersectionObserver below, kept as a
  // safety net -- startLoading() is itself idempotent via
  // `loadingStarted`, so having both fire is harmless). requestIdleCallback
  // runs once the main thread is free of higher-priority work -- in
  // practice, once the hero's own critical paint/layout work is done --
  // without needing to coordinate directly with the hero section's own
  // code (owned by other streams). Safari has no requestIdleCallback, so
  // falls back to a short setTimeout after `load` there; either path is
  // gated on `document.readyState !== "loading"` (DOM parsed) so this
  // never competes with the hero's own initial parse/paint.
  function kickoffEarlyLoad() {
    const go = () => startLoading();
    if ("requestIdleCallback" in window) {
      requestIdleCallback(go, { timeout: 2000 });
    } else {
      setTimeout(go, 0);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", kickoffEarlyLoad, { once: true });
  } else {
    kickoffEarlyLoad();
  }

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
    // F. pacing pass: pin length reduced from 5.5·vh to 4.0·vh (see the
    // SEG/HOLD rebalance comment above the constants for how the segment
    // boundaries were rescaled to match).
    end: () => "+=" + Math.round(window.innerHeight * 4.0),
    pin,
    pinSpacing: true,
    // CS-04 retune, round 2: measured settle time (last-wheel-event ->
    // rendered frame index/progress stops changing, via
    // window.__story.state(), not pixels) across scrub true/0.1/0.12/0.35,
    // both cameras, slow/flick/reverse/mid-burst-reversal, 5 repeats each
    // (qa/final-2026-09-21/stream-a/scripts/scrub-settle-by-frame.mjs).
    // Result: settle is ~0ms for slow/reverse bursts and ~11-16ms for
    // flick bursts across ALL FOUR values tested, including scrub:true —
    // i.e. indistinguishable from rAF-loop measurement quantization
    // (~16.7ms/frame), not a real scrub-driven lag, on this localhost
    // setup. No overshoot on reversal at any tested value (a mid-burst-
    // reversal check on the frame index confirmed p reverses smoothly and
    // monotonically; an earlier false "overshoot" reading was traced to
    // the detector not accounting for the close->hold segment boundary,
    // not an actual defect). With no measured downside to a shorter
    // value, retuned to 0.1s (previously 0.12s) per "take the lowest
    // stable value" — still inside the contract's 0.08-0.15s band. Real,
    // reported limitation: not validated against a working settle
    // measurement under real network/decode latency, or on physical
    // trackpad/touch hardware (unavailable in this environment).
    scrub: 0.1,
    anticipatePin: 1,
    invalidateOnRefresh: true,
    onUpdate: (self) => { render(self.progress); ensureLoop(); },
    onRefresh: (self) => { resizeCanvas(); render(self.progress); },
    // D. re-measure the moment the pin actually activates: any earlier
    // positionRail()/positionCaptions() call (window.load, fonts.ready) can
    // only have seen the section's un-pinned, normal-flow geometry, which is
    // meaningless for the rail's "right"/"above" viewport-clamped modes (see
    // the staleness comment in positionRail() above).
    onToggle: (self) => { pinActive = self.isActive; if (pinActive) { measureHeaderHeight(); positionRail(); positionCaptions(); } ensureLoop(); },
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
