// Round 10 (live-site lag): frame decode worker. fetch() + createImageBitmap()
// run off the main thread here; the resulting ImageBitmap is transferred
// back to the main thread (structured clone with a transfer list — zero-
// copy, not a duplicate allocation) so WebKit's measured ~25ms/frame
// decode time (vs Chromium's ~9ms) never blocks the main thread's rAF
// loop. js/story.js falls back to main-thread decoding if Worker or
// ImageBitmap-transfer support is unavailable (checked once at startup).
self.onmessage = async (e) => {
  const { id, url, maxW, maxH } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    let bitmap = await createImageBitmap(blob);
    if (maxW && maxH && (bitmap.width > maxW || bitmap.height > maxH)) {
      const scale = Math.min(maxW / bitmap.width, maxH / bitmap.height);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const resized = await createImageBitmap(bitmap, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
      bitmap.close();
      bitmap = resized;
    }
    self.postMessage({ id, ok: true, bitmap }, [bitmap]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
