// The outer page: up to two frames, each a copy of the app (frame.html) that scrolls and navigates on its own. Each
// frame has a strip on top: the active one holds the nav, the other just its ×. Frames report where they are with
// postMessage.
"use strict";

const framesEl = document.getElementById("frames");
const MAX_PANES = 2;
const PALETTES = 4; // colour pairs in app.css

/** A colour pair for a frame, never one in `avoid` (the other frame's, and its own when it changes). */
function pickPalette(...avoid) {
  const choices = [...Array(PALETTES).keys()].filter((n) => !avoid.includes(n));
  return choices[Math.floor(Math.random() * choices.length)];
}

/** New colours for a frame that has moved to another page: its strip and border here, and the page itself. */
function recolor(pane) {
  pane.palette = pickPalette(pane.palette, ...panes.filter((p) => p !== pane).map((p) => p.palette));
  pane.el.dataset.palette = pane.iframe.dataset.palette = String(pane.palette);
  pane.iframe.contentDocument.documentElement.dataset.palette = String(pane.palette);
}

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: fine, just not remembered */ }
  },
};

/** Which nav button a frame's hash belongs under (the same rule as the frame's router). */
function sectionOf(hash) {
  const first = hash.slice(1).split("?")[0].split("/").filter(Boolean)[0];
  return first === "r" || !first ? "recipes" : first;
}

let panes = []; // { el, iframe, hash, palette }
let active = 0;
let ratio = 0.5; // the first frame's share of the space when split

function save() {
  store.set("panes", { hashes: panes.map((p) => p.hash), active, ratio });
}

function draw() {
  const split = panes.length > 1;
  framesEl.classList.toggle("split", split);
  framesEl.style.setProperty("--split", String(ratio));
  // The safe areas around the frames take the first frame's colours.
  document.documentElement.dataset.palette = String(panes[0].palette);
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  panes.forEach((p, i) => {
    p.el.classList.toggle("on", i === active);
    // Same origin, so mark the page itself; it hides what only the active frame needs (the jump bar).
    p.iframe.contentDocument?.body?.classList.toggle("inactive", split && i !== active);
    const section = sectionOf(p.hash);
    p.el.querySelectorAll("[data-nav]").forEach((b) => b.classList.toggle("on", b.dataset.nav === section));
    const end = p.el.querySelector(".end");
    end.textContent = split ? "×" : "Split";
    end.setAttribute("aria-label", split ? "Close this frame" : "Split into two frames");
  });
}

function addPane(hash) {
  const palette = pickPalette(panes[0]?.palette);
  const el = document.createElement("section");
  el.className = "pane";
  el.dataset.palette = String(palette);
  el.innerHTML = `<div class="strip">
    <nav>
      <button data-go="#/" data-nav="recipes">Recipes</button>
      <button data-go="#/cook" data-nav="cook">Cook</button>
      <button data-go="#/swap" data-nav="swap">Swaps</button>
    </nav>
    <span class="strip-space"></span>
    <button class="end"></button>
  </div>`;
  const iframe = document.createElement("iframe");
  iframe.src = `/frame${hash}`;
  iframe.title = "Recipes";
  iframe.dataset.palette = String(palette); // frame.html reads it before drawing anything
  iframe.addEventListener("load", draw);
  el.append(iframe);
  const pane = { el, iframe, hash, palette };
  el.querySelector(".strip").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b?.classList.contains("end")) panes.length > 1 ? closePane(pane) : splitPane(pane);
    else if (b) iframe.contentWindow.location.hash = b.dataset.go;
    else focusPane(pane);
  });
  framesEl.append(el);
  panes.push(pane);
  return pane;
}

function focusPane(pane) {
  active = panes.indexOf(pane);
  save();
  draw();
}

function closePane(pane) {
  if (panes.length < 2) return;
  pane.el.remove();
  panes = panes.filter((p) => p !== pane);
  active = 0;
  save();
  draw();
}

/** The new frame opens on the same page, and takes the nav. */
function splitPane(pane) {
  if (panes.length >= MAX_PANES) return;
  addPane(pane.hash);
  active = panes.length - 1;
  save();
  draw();
}

// The seam between the frames: drag it to resize them. The frames ignore touches meanwhile, so they don't eat the drag.
{
  const divider = document.createElement("div");
  divider.className = "divider";
  divider.setAttribute("aria-hidden", "true");
  framesEl.append(divider);
  const MIN = 0.15;
  const wide = matchMedia("(orientation: landscape)");
  const move = (e) => {
    const box = framesEl.getBoundingClientRect();
    const r = wide.matches ? (e.clientX - box.left) / box.width : (e.clientY - box.top) / box.height;
    ratio = Math.min(1 - MIN, Math.max(MIN, r));
    framesEl.style.setProperty("--split", String(ratio));
  };
  divider.addEventListener("pointerdown", (e) => {
    divider.setPointerCapture(e.pointerId);
    framesEl.classList.add("dragging");
    divider.addEventListener("pointermove", move);
  });
  const done = () => {
    divider.removeEventListener("pointermove", move);
    framesEl.classList.remove("dragging");
    save();
  };
  divider.addEventListener("pointerup", done);
  divider.addEventListener("pointercancel", done);
}

/** Reloads the app, first fetching a new version from the Mac if there is one, so one pull is enough. */
async function refresh() {
  const giveUp = new Promise((resolve) => setTimeout(resolve, 3000)); // the Mac may be asleep
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await Promise.race([giveUp, reg.update().then(() => {
        const next = reg.installing;
        if (next) return new Promise((resolve) => next.addEventListener("statechange", () => {
          if (next.state === "activated" || next.state === "redundant") resolve();
        }));
      })]);
    }
  } catch { /* offline: reload the saved copy */ }
  location.reload();
}

addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  const pane = panes.find((p) => p.iframe.contentWindow === e.source);
  if (!pane) return;
  if (e.data?.type === "route") pane.hash = e.data.hash;
  else if (e.data?.type === "navigated") recolor(pane);
  else if (e.data?.type === "refresh") return void refresh();
  else if (e.data?.type === "focus") {
    active = panes.indexOf(pane);
  } else return;
  save();
  draw();
});

// Open as you left it: the same frames on the same pages. A link to a page (/#/r/…) opens just that.
{
  const saved = store.get("panes", null);
  const valid = (h) => typeof h === "string" && h.startsWith("#");
  let hashes = Array.isArray(saved?.hashes) ? saved.hashes.filter(valid).slice(0, MAX_PANES) : [];
  if (location.hash.length > 1) {
    hashes = [location.hash];
    history.replaceState(null, "", "/");
  }
  if (!hashes.length) hashes = ["#/"];
  hashes.forEach(addPane);
  active = Math.min(Math.max(0, Number(saved?.active) || 0), panes.length - 1);
  if (Number(saved?.ratio) > 0 && Number(saved?.ratio) < 1) ratio = Number(saved.ratio);
  draw();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
