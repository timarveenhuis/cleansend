// CleanSend — site.js (ES module, v4). GSAP + ScrollTrigger are self-hosted
// UMD builds loaded as classic scripts before this module (index.html).
// CS-15 cache-busting: keep this token in sync with index.html's
// data-build attribute and the ?v= token on every other static reference
// (see README.md "Cache-busting token" for how to bump it before a release).
import { initStory } from "./story.js?v=20260921a";
const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (gsap && ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

// The public address of this page. Used for "Copy link" so a preview opened
// from localhost, a file, or an artifact container never shares a private URL.
const PUBLIC_URL = (document.querySelector('link[rel="canonical"]') || {}).href || "https://timarveenhuis.github.io/cleansend/";

/* ------------------------------------------------------------- header */
function initHeaderScroll() {
  const header = document.querySelector(".site-header");
  if (!header) return;
  const update = () => header.classList.toggle("is-scrolled", window.scrollY > 4);
  update();
  window.addEventListener("scroll", update, { passive: true });
}

/* --------------------------------------------------------- hash landings */
// J. navigation investigation (headed Chromium + WebKit) found history
// back/forward could leave an anchor target scrolled to y=0, PARTIALLY
// HIDDEN behind the fixed header — reproduced in WebKit specifically
// (measured ~-191px gap; the CSS scroll-margin-top fix on #top/#final/
// #privacy/#main/#outcomes already handles the forward "click a link" case
// in both engines, since that's native anchor navigation, but WebKit's
// scroll-position RESTORATION on popstate doesn't consistently reapply it).
// Re-run the same scroll-margin-aware landing manually whenever the hash
// changes for any reason, including back/forward.
function initHashScrollFix() {
  const landOnHash = () => {
    if (!location.hash) return;
    const target = document.getElementById(location.hash.slice(1));
    if (!target) return;
    // Let the browser's own (possibly wrong) restoration happen first, then
    // correct it on the next frame rather than fight it mid-navigation.
    requestAnimationFrame(() => target.scrollIntoView({ behavior: "auto", block: "start" }));
  };
  window.addEventListener("hashchange", landOnHash);
  window.addEventListener("popstate", landOnHash);
}

/* ------------------------------------------------------------- reveals */
function initReveals() {
  const els = document.querySelectorAll("[data-reveal]");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );
  els.forEach((el) => io.observe(el));
}

/* ---------------------------------------------------------- before/after */
function initBeforeAfter() {
  const frame = document.querySelector(".ba-frame");
  if (!frame) return;
  const range = frame.querySelector(".ba-range");
  const afterImg = frame.querySelector(".ba-after");
  const divider = frame.querySelector(".ba-divider");
  const handle = frame.querySelector(".ba-handle");
  const beforeLabel = frame.querySelector(".ba-label--before");
  const afterLabel = frame.querySelector(".ba-label--after");

  function update(val) {
    // the after image is clipped from the left by val%, so (100 - val)% of it is visible
    afterImg.style.clipPath = `inset(0 0 0 ${val}%)`;
    divider.style.left = `${val}%`;
    // H. clamp the handle's centre inside the frame (56px handle + a 6px
    // focus-ring allowance either side) so it — and its focus ring — are
    // never clipped by .ba-frame's overflow:hidden at the 0/100 endpoints.
    handle.style.left = `clamp(34px, ${val}%, calc(100% - 34px))`;
    range.setAttribute("aria-valuetext", `${100 - val}% of the after image visible`);
    // H. at val=0 the after image is fully visible (nothing clipped), so the
    // before photo underneath is entirely covered — its badge would be
    // claiming something not on screen; symmetric at val=100.
    if (beforeLabel) beforeLabel.classList.toggle("is-hidden-endpoint", val <= 0);
    if (afterLabel) afterLabel.classList.toggle("is-hidden-endpoint", val >= 100);
  }

  range.addEventListener("input", (e) => update(Number(e.target.value)));
  range.addEventListener("focus", () => frame.classList.add("is-focused"));
  range.addEventListener("blur", () => frame.classList.remove("is-focused"));
  range.addEventListener("pointerdown", () => frame.classList.add("is-dragging"));
  window.addEventListener("pointerup", () => frame.classList.remove("is-dragging"));
  update(Number(range.value));
}

/* --------------------------------------------------------------- form */
// Pre-launch demo: the signup is stored in this browser only (localStorage).
// No request is made and no email is sent; the copy in index.html says so.
function initForm() {
  const form = document.querySelector(".final-form");
  if (!form) return;
  const emailInput = form.querySelector("input[type=email]");
  const submitBtn = form.querySelector("button[type=submit]");
  const errorEl = form.querySelector(".form-error");
  const successEl = document.querySelector(".final-success");
  const freqButtons = document.querySelectorAll(".freq-options button");
  const freqThanks = document.querySelector(".freq-thanks");
  const copyBtn = document.querySelector(".share-copy");
  const copyStatus = document.querySelector(".copy-status");
  const copyFallback = document.querySelector(".copy-fallback");
  const STORAGE_KEY = "cleansend.signup";
  const startOverBtn = document.querySelector(".start-over");
  let submitting = false;

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  }
  function fail(msg) {
    errorEl.textContent = msg;
    emailInput.setAttribute("aria-invalid", "true");
    emailInput.focus();
  }
  function showSuccess({ focusHeading = true } = {}) {
    form.classList.add("is-hidden");
    successEl.classList.add("is-visible");
    if (focusHeading) successEl.querySelector("h3")?.focus?.();
  }
  function showForm() {
    successEl.classList.remove("is-visible");
    form.classList.remove("is-hidden");
    freqButtons.forEach((b) => b.setAttribute("aria-pressed", "false"));
    freqThanks.textContent = "";
    emailInput.value = "";
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (submitting) return; // ignore double taps
    const value = emailInput.value.trim();
    if (!value) return fail("Enter an email to save your spot.");
    if (!isValidEmail(value)) return fail("That doesn't look like an email. Check the @ and try again.");
    submitting = true;
    submitBtn.disabled = true;
    try {
      const record = { email: value, ts: Date.now() };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch (err) {
      submitting = false;
      submitBtn.disabled = false;
      return fail("Couldn't save that in this browser. Try again, or use a different browser.");
    }
    errorEl.textContent = "";
    emailInput.removeAttribute("aria-invalid");
    showSuccess();
  });
  emailInput.addEventListener("input", () => {
    if (emailInput.getAttribute("aria-invalid")) { emailInput.removeAttribute("aria-invalid"); errorEl.textContent = ""; }
  });

  freqButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      freqButtons.forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      const freq = btn.textContent.trim();
      let saved = true;
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const record = raw ? JSON.parse(raw) : {};
        record.frequency = freq;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
      } catch (err) {
        saved = false;
      }
      freqThanks.textContent = saved ? `Noted: ${freq}. Saved in this browser only.` : `Noted: ${freq}. Couldn't save it in this browser.`;
    });
  });

  if (startOverBtn) {
    startOverBtn.addEventListener("click", () => {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (err) { /* nothing more we can do; show the form regardless */ }
      showForm();
      emailInput.focus();
    });
  }

  // Round 3, item 4: a previous submit persists to localStorage, but a
  // reload always re-rendered the empty form — the copy says "saved in
  // this browser only" but the UI didn't reflect that it actually was.
  // On load, if a record with an email exists, render the success state
  // (without stealing focus — that's for an actual submit action, not a
  // page load) and restore the pressed frequency button if one was saved.
  // Guard the read: a throwing localStorage (private-mode edge cases, some
  // browser settings) must fall back to the ordinary empty-form state, not
  // break the page.
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const record = raw ? JSON.parse(raw) : null;
    if (record && record.email) {
      showSuccess({ focusHeading: false });
      if (record.frequency) {
        freqButtons.forEach((b) => {
          const match = b.textContent.trim() === record.frequency;
          b.setAttribute("aria-pressed", match ? "true" : "false");
        });
        freqThanks.textContent = `Noted: ${record.frequency}. Saved in this browser only.`;
      }
    }
  } catch (err) {
    // localStorage threw on read (e.g. disabled/blocked storage) — leave
    // the default empty-form state, which is already truthful.
  }

  if (copyBtn) {
    const showFallback = () => {
      copyFallback.hidden = false;
      copyFallback.value = PUBLIC_URL;
      copyFallback.select();
      copyStatus.textContent = "Couldn't copy automatically. Select the link and copy it yourself:";
    };
    copyBtn.addEventListener("click", () => {
      if (!navigator.clipboard || !navigator.clipboard.writeText) return showFallback();
      navigator.clipboard.writeText(PUBLIC_URL)
        .then(() => { copyStatus.textContent = "Link copied."; copyFallback.hidden = true; })
        .catch(showFallback);
    });
  }
}

/* ------------------------------------------------------------- privacy link */
function initPrivacyLink() {
  // A same-page anchor jump doesn't open a closed <details>; open it and move
  // focus so keyboard and screen-reader users land on visible content.
  const link = document.querySelector(".privacy-link");
  const details = document.getElementById("privacy");
  if (!link || !details) return;
  link.addEventListener("click", () => {
    details.open = true;
    const summary = details.querySelector("summary");
    window.requestAnimationFrame(() => summary && summary.focus());
  });
}

/* ------------------------------------------------------------------ init */
// Each init runs in isolation: a failure in one (e.g. a missing element, a
// third-party lib not loading) must not prevent the others from running.
function safeInit(name, fn) {
  try {
    fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[cleansend] ${name} failed to init:`, err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  safeInit("header", initHeaderScroll);
  safeInit("hashScrollFix", initHashScrollFix);
  safeInit("reveals", initReveals);
  safeInit("beforeAfter", initBeforeAfter);
  safeInit("privacyLink", initPrivacyLink);
  safeInit("form", initForm);
  // Story runs last: it's the heaviest init (WebGL/GSAP/ScrollTrigger) and
  // must not be able to block header/reveals/before-after/privacy/form.
  safeInit("story", initStory);
  window.addEventListener("load", () => {
    if (window.gsap && ScrollTrigger) safeInit("scrollTriggerRefresh", () => ScrollTrigger.refresh());
  });
});
