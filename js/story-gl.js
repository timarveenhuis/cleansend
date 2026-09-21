// CleanSend — story-gl.js (v5): WebGL1 compositor for the "chamber cinema"
// hold beat (locked -> cleaning -> done). Draws the arrive/close/open frame
// sequences too (as a single full-screen textured quad) so the whole story
// section shares one canvas / one draw call family and never layer-swaps.
//
// No extensions required. Procedural, tileable noise textures are generated
// on the CPU at init (small random luminance fields, wrapped REPEAT) rather
// than shipped as files — the mist is a low-opacity screen blend so seams in
// simple value noise are not perceptible; this keeps the engine dependency-free.

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  // Textures are uploaded without UNPACK_FLIP_Y (row 0 of the source image
  // lands at texcoord v=0), so screen-top (aPos.y=1) must sample v=1-... :
  // flip v here rather than at upload time.
  vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// uCoverUv maps screen UV -> texture UV for object-fit: cover with a focus point.
const FRAG_HOLD = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uDirtyOff, uDirtyOn, uCleanOn, uCleanOff, uMap, uWindow, uNoiseA, uNoiseB, uNoiseFine, uSweep;
uniform float uL, uC, uRingMix, uMist, uTime, uBandScale, uSweepMix;
uniform vec2 uUvScale, uUvOffset;
uniform vec4 uWinRect; // x,y,w,h — the compartment window in hold-frame UV fractions (manifest.chamber)

vec2 coverUv(vec2 uv) { return uv * uUvScale + uUvOffset; }

void main() {
  vec2 uv = coverUv(vUv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.055,0.102,0.09,1.0); return; }
  float c = uC;

  // L==0 happens for real, sustained stretches: the hold-only degrade for
  // the arrive/close fallback passes it as a hard constant, and it's exactly
  // 0 for the start of the hold phase too. Skip the ON textures and the
  // L-gated mix entirely rather than fetching and blending toward a weight
  // of zero.
  vec3 base_d, base_c;
  if (uL > 0.0) {
    base_d = mix(texture2D(uDirtyOff, uv).rgb, texture2D(uDirtyOn, uv).rgb, uL);
    base_c = mix(texture2D(uCleanOff, uv).rgb, texture2D(uCleanOn, uv).rgb, uL);
  } else {
    base_d = texture2D(uDirtyOff, uv).rgb;
    base_c = texture2D(uCleanOff, uv).rgb;
  }

  // The map is only needed when the mix is actually ambiguous (0<c<1) or the
  // band needs it (only while lit). c<=0 and c>=1 are both real, sustained
  // states (start of hold; the whole "done" hold and the open fallback).
  bool needMap = uL > 0.0 || (c > 0.0 && c < 1.0);
  float m = needMap ? texture2D(uMap, uv).r : 0.0;
  // Single shoe mask, used everywhere below: the map's card/background area
  // is not a clean 1.0 — it's ~253-254/255 near the card edge, with a soft
  // transition ring dipping lower still. A 0.99 cutoff let that ring through
  // as "shoe", so the sweep/glow (and, at the boundary, the dirty/clean mix)
  // painted a faint rectangle around the card. 0.985 clears it.
  float shoe = step(m, 0.985);

  // "White cloud at the end" fix (client, real Chrome, p=0.83 L=1 c=0.99):
  // the map's real shoe range is 0.02-0.98, but the card's transition ring
  // (between legitimate shoe pixels and the flat ~0.99-0.996 card margin)
  // sits at m~0.95-0.985 — inside the 'shoe' mask (<=0.985) but ABOVE the
  // map's own declared shoe ceiling. As real c pushes past ~0.95 toward 1.0,
  // the glow's |m-c| and the mix's smoothstep(c+/-0.035) both land squarely
  // on that ring, lighting the whole card-margin rectangle right at the very
  // end of the cycle. cEff caps how far the "cleaning front" comparison can
  // advance into that ring — used for every map<->c comparison below, not
  // the real uC (still used for the actual dirty/clean blend elsewhere).
  float cEff = min(c, 0.98);

  vec3 col;
  if (c <= 0.0) col = base_d;
  else if (c >= 1.0) col = base_c;
  else {
    // map convention (plans/spec-asset-prep-v5.md §2): m is the moment a
    // pixel becomes clean, so a pixel already reads clean once m < c (NOT
    // m > c — that inversion was a real bug: it made the pair appear to get
    // dirtier as the cycle progressed). clean_w -> 1 once cEff has passed m.
    // Gated by 'shoe': card/background pixels never read as "cleaning" —
    // they stay on base_d until c reaches 1, same as the render's own
    // dirty/clean states, which are identical outside the shoe anyway.
    float clean_w = (1.0 - smoothstep(cEff - 0.035, cEff + 0.035, m)) * shoe;
    col = mix(base_d, base_c, clean_w);
  }

  // Working light: a screen-space sweep travelling top-to-bottom across the
  // window as c advances (not a level-set of the map, which reads as an
  // outline along material edges) — reads as light moving over the surface.
  // A second, much fainter level-set glow gives the cleaning front itself
  // just a whisper of highlight. Both are confined to the shoe ('shoe')
  // and, since both are scaled by uL, only computed while the chamber is lit.
  if (uL > 0.0) {
    float winTop = uWinRect.y, winH = uWinRect.w;
    float yC = winTop + cEff * winH;
    float sweepSigma = max(0.001, 0.12 * winH);
    float sweep = exp(-pow((uv.y - yC) / sweepSigma, 2.0)) * uL * shoe;
    float glow = exp(-pow((m - cEff) / 0.10, 2.0)) * uL * shoe;
    vec3 bandColor = vec3(0.92, 0.98, 0.96);
    col += bandColor * (sweep * 0.22 + glow * 0.06) * uBandScale;
  }

  // Working-light sweep (real Blender pack): a rendered light-only sequence
  // (assets/seq/v5/<cam>/sweep, from the hold camera — an emissive band of
  // the lit shoe texture travelling across the pair, meant to be added).
  // uSweepMix already carries L (js/story.js), so it's 0 outside p
  // 0.32-0.86 — skip the fetch entirely then. Gated by the real window mask
  // (uWindow) so the light never leaks past the glass into the cabinet.
  //
  // Full RGB, not just .r: the frames already carry the shoe's own colour
  // (they're a real emissive render, not a greyscale mask), so a single-
  // channel read plus a fixed cool-white tint (the original approach, built
  // for the earlier synthetic stand-in) made the band barely perceptible on
  // the shoes' actual teal — confirmed in real Chrome. No separate tint.
  if (uSweepMix > 0.0) {
    float win = texture2D(uWindow, uv).r;
    vec3 s = texture2D(uSweep, uv).rgb;
    // Target is +85-95 sRGB on the uppers at <=1% clipped upper pixels,
    // floor 0.28. Measured directly (real sweep frames, restricted to
    // shoe-mask pixels — map value < 0.985 — so the window's own bright
    // ceiling-light/glass-reflection pixels, already >=250 even with the
    // sweep off, don't count against this): 0.28 gives +66-67 sRGB at
    // 0.20-1.27% clipped; reaching +85-95 needs ~0.36, which clips 2.6-2.9%.
    // No gain in that range hits both the brightness target and the <=1%
    // ceiling on this asset's actual headroom (the base texture already
    // peaks at 202/255 in-band before any sweep is added) — settled at the
    // floor, 0.28, as the closest compliant value; see the closing report
    // for the full gain/clip/brightness table.
    const float SWEEP_GAIN = 0.28;
    col += s * win * uSweepMix * SWEEP_GAIN;
  }

  // mist: "clean, luminous haze under the light", not smoke. Purely additive
  // (never darkens), whiter/cooler, low-contrast (blended toward a flat mid
  // value so it's a gentle modulation rather than high-contrast puffs with
  // dark gaps), finer-scaled and slower-drifting than the previous pass,
  // and strongly weighted to the top of the window (near the ceiling light)
  // fading to almost nothing at the shelf. Skipped entirely when mist is 0
  // (most of the timeline) — that's 4 texture fetches saved.
  if (uMist > 0.0) {
    float win = texture2D(uWindow, uv).r;
    // ~60s to drift one tile across the window (was ~40s)
    vec2 tA = uTime * vec2(0.0143, -0.0086);
    vec2 tB = uTime * vec2(-0.0103, 0.0132);
    vec2 tF = uTime * vec2(0.010, 0.0133);
    // finer-scaled lookups (x1.6) for calmer, smaller-scale structure
    float nA = texture2D(uNoiseA, uv * 3.2 + tA).r;
    float nB = texture2D(uNoiseB, uv * 4.8 + tB).r;
    float nRaw = nA * nB;
    float n = clamp((nRaw - 0.15) * 2.5, 0.0, 1.0);
    // blend 50/50 with a flat constant: halves the contrast between bright
    // wisps and dark gaps so the field reads as gentle modulation, not blobs
    n = mix(n, 0.5, 0.5);
    float f = texture2D(uNoiseFine, uv * 8.0 + tF).r;
    // strong vertical gradient: full density in the top 30% of the window
    // (under the ceiling strip), fading to ~0 by the shelf
    //
    // A round-2 attempt raised MIST_MAX_LIFT to 0.205 (with a steeper 22%/
    // 80% gradient) to hit a client-requested 6-7% rise. Reverted: at that
    // level the whole chamber read as grey fog and the pair looked paler —
    // the opposite of "seeing the machine work" — so this is back to the
    // original 0.11/~4.5% and stays there. The actual "seeing it work" cue
    // is meant to come from the working-light sweep's real footprint
    // (assets/seq/v5/<cam>/sweep, Blender render pending), not from mist.
    float winTop = uWinRect.y, winH = uWinRect.w;
    float winYFrac = clamp((uv.y - winTop) / max(0.001, winH), 0.0, 1.0);
    float vertFalloff = 1.0 - smoothstep(0.30, 0.95, winYFrac);
    // fine grain near-zero (0.03): a whisper of texture, not visible grain
    float fog = win * uMist * uL * (n * 0.97 + f * 0.03) * vertFalloff;
    const float MIST_MAX_LIFT = 0.11;
    col += vec3(0.94, 0.99, 1.0) * clamp(fog, 0.0, 1.0) * MIST_MAX_LIFT;
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// Simple full-screen textured quad, used for the baked arrive/close/open frames.
const FRAG_FRAME = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uUvScale, uUvOffset;
uniform vec3 uBg;
void main() {
  vec2 uv = vUv * uUvScale + uUvOffset;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(uBg,1.0); return; }
  gl_FragColor = texture2D(uFrame, uv);
}
`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("shader compile failed: " + log);
  }
  return sh;
}

function link(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error("program link failed: " + log);
  }
  return prog;
}

function makePlaceholderRepeatTexture(gl) {
  // mid-grey until the real noise PNG (assets/gl/noise-*.png) arrives
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([128]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

function makeEmptyTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 26, 23, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

export class StoryGL {
  constructor(canvas) {
    this.canvas = canvas;
    // preserveDrawingBuffer:false lets the browser skip retaining/copying the
    // backbuffer every frame (a real cost at this canvas size); antialias is
    // off since the canvas is a full-bleed photographic composite, not
    // vector content, so MSAA buys nothing visible. Test code that needs to
    // inspect rendered pixels must use gl.readPixels() (via readPixelsFull(),
    // below) called synchronously right after a draw — that reads the
    // framebuffer directly and does not depend on preserveDrawingBuffer,
    // unlike drawImage(canvas)/getImageData, which can read a blank buffer
    // once this is false.
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false })
      || canvas.getContext("experimental-webgl");
    if (!gl) throw new Error("no webgl");
    this.gl = gl;

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]);
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    this.holdProg = link(gl, VERT, FRAG_HOLD);
    this.frameProg = link(gl, VERT, FRAG_FRAME);

    this.holdLoc = this._locate(this.holdProg, [
      "aPos", "uDirtyOff", "uDirtyOn", "uCleanOn", "uCleanOff", "uMap", "uWindow",
      "uNoiseA", "uNoiseB", "uNoiseFine", "uSweep", "uL", "uC", "uRingMix", "uMist", "uTime", "uUvScale", "uUvOffset",
      "uWinRect", "uBandScale", "uSweepMix",
    ]);
    this.frameLoc = this._locate(this.frameProg, ["aPos", "uFrame", "uUvScale", "uUvOffset", "uBg"]);

    this.noiseA = makePlaceholderRepeatTexture(gl);
    this.noiseB = makePlaceholderRepeatTexture(gl);
    this.noiseFine = makePlaceholderRepeatTexture(gl);
    // Bound whenever no real sweep frame is available yet (uSweepMix gates
    // the shader's use of it, but some drivers still expect a valid,
    // complete texture on every active sampler regardless of the dynamic
    // branch) — black, so it would contribute nothing even if ever sampled.
    this.sweepPlaceholder = makeEmptyTexture(gl);

    this.holdTex = {
      dirtyOff: makeEmptyTexture(gl), dirtyOn: makeEmptyTexture(gl),
      cleanOn: makeEmptyTexture(gl), cleanOff: makeEmptyTexture(gl),
      map: makeEmptyTexture(gl), window: makeEmptyTexture(gl),
    };
    this.frameTexCache = new Map(); // bitmap -> WebGLTexture, small LRU-ish cache
    this.frameTexOrder = [];
  }

  _locate(prog, names) {
    const gl = this.gl;
    const loc = {};
    names.forEach((n) => {
      loc[n] = n === "aPos" ? gl.getAttribLocation(prog, n) : gl.getUniformLocation(prog, n);
    });
    return loc;
  }

  resize(w, h, dpr) {
    const gl = this.gl;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // Gate 3 fix: guards against an ImageBitmap that's been close()'d (its
  // backing pixel data detached) by the time this actually runs — the
  // caller-side fix (js/story.js's setLastGood/clearLastGood) prevents
  // the cache from closing a bitmap that's still in active use, but this
  // is a second, independent layer: even a caller-side bug or a future
  // regression should degrade to "skip this upload" rather than throw
  // ("WebGL: INVALID_VALUE: texImage2D: the ImageBitmap has been
  // detached", reproduced WebKit-only, intermittent). A detached
  // ImageBitmap reports width/height 0 per spec; texImage2D is also
  // wrapped defensively in case an implementation throws instead.
  // Returns false (upload skipped) or true (uploaded successfully).
  _uploadInto(tex, source) {
    const gl = this.gl;
    if (!source || !source.width || !source.height) return false;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    try {
      // No UNPACK_FLIP_Y: the vertex shader maps screen-top to v=1
      // directly (see VERT), which already matches the source image's
      // row order.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (e) {
      return false;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return true;
  }

  setHoldLayer(name, source) {
    if (!this.holdTex[name] || !source) return;
    this._uploadInto(this.holdTex[name], source);
  }

  // Real tileable noise (assets/gl/noise-{a,b,fine}.png), REPEAT-wrapped.
  setNoiseTextures(a, b, fine) {
    const gl = this.gl;
    const upload = (tex, source) => {
      if (!source) return;
      this._uploadInto(tex, source);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    };
    upload(this.noiseA, a);
    upload(this.noiseB, b);
    upload(this.noiseFine, fine);
  }

  // Returns (and caches) a texture for a decoded frame bitmap. Caller owns
  // bitmap lifetime; call dropFrameTexture when the bitmap is closed.
  getFrameTexture(bitmap) {
    if (this.frameTexCache.has(bitmap)) return this.frameTexCache.get(bitmap);
    const gl = this.gl;
    const tex = gl.createTexture();
    const uploaded = this._uploadInto(tex, bitmap);
    if (!uploaded) {
      // Detached/invalid bitmap: don't cache this failed attempt against
      // the bitmap object (a future, different bitmap reference for the
      // "same" frame — e.g. after a re-decode — must get a fresh upload
      // attempt, not silently reuse a failed one forever). Delete the
      // half-bound scratch texture and fall back to the existing blank
      // placeholder texture (already valid/initialized elsewhere in this
      // file) rather than handing callers a texture object with no valid
      // image data.
      gl.deleteTexture(tex);
      return this.sweepPlaceholder;
    }
    this.frameTexCache.set(bitmap, tex);
    this.frameTexOrder.push(bitmap);
    // keep at most 24 GL textures resident for sequence frames
    while (this.frameTexOrder.length > 24) {
      const old = this.frameTexOrder.shift();
      const t = this.frameTexCache.get(old);
      if (t) gl.deleteTexture(t);
      this.frameTexCache.delete(old);
    }
    return tex;
  }

  dropFrameTexture(bitmap) {
    const gl = this.gl;
    const t = this.frameTexCache.get(bitmap);
    if (t) { gl.deleteTexture(t); this.frameTexCache.delete(bitmap); }
    const i = this.frameTexOrder.indexOf(bitmap);
    if (i >= 0) this.frameTexOrder.splice(i, 1);
  }

  _bindQuad(loc) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);
  }

  // Draw one full-screen frame texture (arrive/close/open segments).
  drawFrame(tex, uvScale, uvOffset, bgRgb) {
    const gl = this.gl;
    gl.useProgram(this.frameProg);
    this._bindQuad(this.frameLoc);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.frameLoc.uFrame, 0);
    gl.uniform2f(this.frameLoc.uUvScale, uvScale[0], uvScale[1]);
    gl.uniform2f(this.frameLoc.uUvOffset, uvOffset[0], uvOffset[1]);
    gl.uniform3f(this.frameLoc.uBg, bgRgb[0], bgRgb[1], bgRgb[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Draw the composited hold beat. winRect = [x,y,w,h], the compartment
  // window in hold-frame UV fractions (manifest.chamber); bandScale (default
  // 1) lets tests turn the working-light sweep/glow off to isolate the pure
  // dirty/clean mix.
  drawHold({ L, c, ringMix, mist, time, uvScale, uvOffset, winRect = [0.2, 0.2, 0.6, 0.6], bandScale = 1, sweepTex = null, sweepMix = 0 }) {
    const gl = this.gl;
    gl.useProgram(this.holdProg);
    this._bindQuad(this.holdLoc);
    const tex = [this.holdTex.dirtyOff, this.holdTex.dirtyOn, this.holdTex.cleanOn, this.holdTex.cleanOff,
      this.holdTex.map, this.holdTex.window, this.noiseA, this.noiseB, this.noiseFine, sweepTex || this.sweepPlaceholder];
    const uniforms = ["uDirtyOff", "uDirtyOn", "uCleanOn", "uCleanOff", "uMap", "uWindow", "uNoiseA", "uNoiseB", "uNoiseFine", "uSweep"];
    tex.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(this.holdLoc[uniforms[i]], i);
    });
    gl.uniform1f(this.holdLoc.uL, L);
    gl.uniform1f(this.holdLoc.uC, c);
    gl.uniform1f(this.holdLoc.uRingMix, ringMix);
    gl.uniform1f(this.holdLoc.uMist, mist);
    gl.uniform1f(this.holdLoc.uTime, time);
    gl.uniform2f(this.holdLoc.uUvScale, uvScale[0], uvScale[1]);
    gl.uniform2f(this.holdLoc.uUvOffset, uvOffset[0], uvOffset[1]);
    gl.uniform4f(this.holdLoc.uWinRect, winRect[0], winRect[1], winRect[2], winRect[3]);
    gl.uniform1f(this.holdLoc.uBandScale, bandScale);
    gl.uniform1f(this.holdLoc.uSweepMix, sweepMix);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Test-only: read the whole canvas back synchronously, right after a draw
  // call, as top-left-origin RGBA (WebGL's readPixels is bottom-left; rows
  // are flipped here). Works regardless of preserveDrawingBuffer because it
  // reads the framebuffer directly rather than going through the canvas
  // element's presentation semantics — call it in the same synchronous task
  // as the draw, before any browser paint can occur.
  readPixelsFull() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(w * h * 4);
    const rowBytes = w * 4;
    for (let row = 0; row < h; row++) {
      const srcRow = h - 1 - row;
      out.set(raw.subarray(srcRow * rowBytes, (srcRow + 1) * rowBytes), row * rowBytes);
    }
    return { data: out, width: w, height: h };
  }

  dispose() {
    const gl = this.gl;
    this.frameTexOrder.forEach((b) => gl.deleteTexture(this.frameTexCache.get(b)));
    this.frameTexCache.clear();
    Object.values(this.holdTex).forEach((t) => gl.deleteTexture(t));
    gl.deleteTexture(this.noiseA); gl.deleteTexture(this.noiseB); gl.deleteTexture(this.noiseFine);
    gl.deleteProgram(this.holdProg); gl.deleteProgram(this.frameProg);
    gl.deleteBuffer(this.quadBuf);
  }
}

// object-fit: cover math: returns { scale: [sx,sy], offset: [ox,oy] } such
// that screenUv * scale + offset gives the texture UV, with texture (tw,th)
// covering a stage of (sw,sh), keeping (focusX,focusY) fraction visible.
// Matches the engine's vertex shader, whose vUv is top-down (0 at screen
// top) to line up with the no-UNPACK_FLIP_Y texture upload — so focusY is a
// plain fraction-from-the-top, same convention as CSS object-position.
export function coverUv(tw, th, sw, sh, focusX = 0.5, focusY = 0.5) {
  const texAspect = tw / th, stageAspect = sw / sh;
  let dispW, dispH;
  if (stageAspect > texAspect) { dispW = sw; dispH = sw / texAspect; }
  else { dispH = sh; dispW = sh * texAspect; }
  const scaleX = sw / dispW, scaleY = sh / dispH;
  const offX = (1 - scaleX) * focusX;
  const offY = (1 - scaleY) * focusY;
  return { scale: [scaleX, scaleY], offset: [offX, offY] };
}
