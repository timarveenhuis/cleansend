// CleanSend — site.js (ES module, v4). GSAP + ScrollTrigger are self-hosted
// UMD builds loaded as classic scripts before this module (index.html).
import { initStory } from "./story.js";
const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (gsap && ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

// The public address of this page. Used for "Copy link" so a preview opened
// from localhost, a file, or an artifact container never shares a private URL.
const PUBLIC_URL = (document.querySelector('link[rel="canonical"]') || {}).href || "https://timarveenhuis.github.io/cleansend-v4/";

/* ------------------------------------------------------------- header */
function initHeaderScroll() {
  const header = document.querySelector(".site-header");
  if (!header) return;
  const update = () => header.classList.toggle("is-scrolled", window.scrollY > 4);
  update();
  window.addEventListener("scroll", update, { passive: true });
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

  function update(val) {
    // the after image is clipped from the left by val%, so (100 - val)% of it is visible
    afterImg.style.clipPath = `inset(0 0 0 ${val}%)`;
    divider.style.left = `${val}%`;
    handle.style.left = `${val}%`;
    range.setAttribute("aria-valuetext", `${100 - val}% of the after image visible`);
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
  let submitting = false;

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  }
  function fail(msg) {
    errorEl.textContent = msg;
    emailInput.setAttribute("aria-invalid", "true");
    emailInput.focus();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (submitting) return; // ignore double taps
    const value = emailInput.value.trim();
    if (!value) return fail("Enter your email to join the list.");
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
    form.classList.add("is-hidden");
    successEl.classList.add("is-visible");
    successEl.querySelector("h3")?.focus?.();
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
      freqThanks.textContent = saved ? `Noted: ${freq}. Saved in this browser.` : `Noted: ${freq}. (Couldn't save it in this browser.)`;
    });
  });

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
document.addEventListener("DOMContentLoaded", () => {
  initHeaderScroll();
  initReveals();
  initStory();
  initBeforeAfter();
  initPrivacyLink();
  initForm();
  window.addEventListener("load", () => ScrollTrigger && ScrollTrigger.refresh());
});
