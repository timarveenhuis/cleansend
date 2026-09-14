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

## Notes

- The email signup form on this page is a local-only demo. It does not send
  data anywhere or store submissions server-side.
- All assets (fonts, images, and the WebGL story sequence frames) are
  self-contained in this repository, so the page works from a static file
  server with no external dependencies beyond loading Google-hosted assets
  it may reference.
