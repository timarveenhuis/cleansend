# CleanSend

The landing page for CleanSend, a service that cleans climbing shoes on-site at
your gym. The page tells the story through a scroll-driven WebGL sequence of
a two-shoe cleaning chamber, paired with a lightweight vanilla JS/CSS site
shell (no build step, no framework).

## Preview locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/` in a browser.

## Cache-busting token

Every static reference (stylesheets, `js/site.js`, font preload links and
`@font-face` URLs, the favicon, vendor scripts, `<img>`/`<source srcset>`
references, and the `og:image` URL) carries a `?v=<token>` query string, and
`<html data-build="<token>">` exposes the same token to JavaScript — `js/story.js`
reads it to version the dynamically-fetched story sequence assets
(`assets/seq/v5/manifest.json` and its frames), which live outside `index.html`.

**Before a release that changes any asset**, bump the token in these places
together so a stale cached tab is guaranteed to re-fetch the new files:

1. `index.html`: the `data-build` attribute on `<html>`, and every `?v=`
   query string (search/replace the old token for the new one).
2. `js/site.js`: the `?v=` on the `import ... from "./story.js"` line.
3. `css/fonts.css`: the `?v=` on both `@font-face` `src: url(...)` pairs.
4. Wherever `js/story.js` reads `document.documentElement.dataset.build` for
   its own asset fetches (that file's own responsibility to keep in sync).
5. `js/story.js`: the `?v=` on the `import { StoryGL } from "./story-gl.js?v=..."`
   line at the top of the file. This one is a static (not dynamically read)
   specifier, by choice — see the comment above that import — so it needs
   the same manual bump the other static references above do.

The token itself is an opaque string (currently a date-based
`YYYYMMDD` + letter, e.g. `20260921f`) — any value works as long as it
changes on every release that changes assets.

## Notes

- The email signup form on this page is a local-only demo. It does not send
  data anywhere or store submissions server-side.
- All assets (fonts, images, and the WebGL story sequence frames) are
  self-contained in this repository, so the page works from a static file
  server with no external dependencies beyond loading Google-hosted assets
  it may reference.
