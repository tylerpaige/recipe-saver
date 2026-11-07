// The kitchen website: your recipes (kept on the phone for offline use), cook and swap lookups (asked of the Mac).
// Routes live in the URL hash: #/?q=<search>, #/r/<key>, #/cook?have=a&have=b, #/swap/<name>.
// It runs in a frame of the outer page (shell.js), which holds the nav bar; up to two frames run side by side.
"use strict";

const view = document.getElementById("view");
const offline = document.getElementById("offline");
const framed = parent !== window;
history.scrollRestoration = "manual";

/** Tells the outer page where this frame is, for the nav and for reopening it there. */
function report() {
  if (framed) parent.postMessage({ type: "route", hash: location.hash || "#/" }, location.origin);
}
// Touching a frame makes it the one the nav drives. iOS Safari doesn't send pointerdown for every tap inside a frame,
// so touchstart too, and focusin for a field reached without a tap.
for (const type of ["touchstart", "pointerdown", "focusin"]) {
  addEventListener(type, () => framed && parent.postMessage({ type: "focus" }, location.origin), { capture: true, passive: true });
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: fine, just not remembered */ }
  },
};

/** "Oct 26", with the year only when it isn't this one. `saved` is "YYYY-MM-DD HH:MM". */
function shortDate(saved) {
  const d = new Date(saved.slice(0, 10) + "T12:00");
  if (isNaN(d)) return saved;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

const badge = (status) =>
  status && status !== "complete" ? `<span class="badge ${esc(status)}">${esc(status.replace("-", " "))}</span>` : "";

// ---- The library: fetched once per visit, from the Mac or (via the service worker) the copy on the phone ----

let library = null; // { recipes, at }
let loading = null;

function loadLibrary() {
  loading ??= fetch("/api/library").then(async (res) => {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `The Mac answered ${res.status}`);
    library = await res.json();
    showOffline(res.headers.get("x-saved-copy") ? `Can't reach your Mac. Showing recipes as of ${new Date(library.at).toLocaleString()}.` : "");
    return library;
  }).finally(() => { loading = null; });
  return loading;
}

function showOffline(msg) {
  offline.hidden = !msg;
  offline.textContent = msg;
}

/** Asks the Mac a live question (cook, swap). Throws a readable message when it can't. */
async function ask(path) {
  let res;
  try {
    res = await fetch(path);
  } catch {
    throw new Error("Can't reach your Mac. Cook and swap lookups need it awake; your recipes still open.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `The Mac answered ${res.status}`);
  return body;
}

// ---- Recipes ----

let query = "";

const plain = (html) => html.replace(/<[^>]+>/g, " ");
const words = (s) => s.toLowerCase().split(/\s+/).filter(Boolean);

/** Words match titles, tags and text; a #word only matches that tag. */
function filtered() {
  const all = words(query);
  const tags = all.filter((w) => w.length > 1 && w.startsWith("#")).map((w) => w.slice(1));
  const q = all.filter((w) => !w.startsWith("#"));
  return library.recipes
    .filter((r) => tags.every((t) => r.tags.some((x) => x.toLowerCase() === t)))
    .map((r) => {
      const head = `${r.title} ${r.tags.join(" ")}`.toLowerCase();
      const all = `${head} ${plain(r.html).toLowerCase()}`;
      // Title and tag matches first, then recipes that only mention it in the text.
      return { r, rank: q.every((w) => head.includes(w)) ? 0 : q.every((w) => all.includes(w)) ? 1 : -1 };
    })
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.r);
}

function renderList() {
  const rows = filtered();
  document.getElementById("clear").disabled = !query;
  document.getElementById("rows").innerHTML = rows.length
    ? rows.map((r) => `<li><a href="#/r/${encodeURIComponent(r.key)}">
        <div class="title">${esc(r.title)}${badge(r.status)}</div>
        <div class="meta">${esc(shortDate(r.saved))}${r.tags.length ? " · " + r.tags.map((t) => "#" + esc(t)).join(" ") : ""}</div>
      </a></li>`).join("")
    : `<li class="muted" style="padding:14px 2px">No recipes match.</li>`;
  document.getElementById("count").textContent =
    `${rows.length} of ${library.recipes.length} recipe${library.recipes.length === 1 ? "" : "s"}`;
}

async function recipesView(params) {
  // The search lives in the hash, so a split copies it; plain #/ (the nav button) keeps the last one.
  if (params.has("q")) query = params.get("q");
  const search = (q) => {
    query = q;
    history.replaceState(null, "", query ? `#/?q=${encodeURIComponent(query)}` : "#/");
    report();
    renderList();
  };
  view.innerHTML = `
    <div class="search">
      <input id="q" type="search" placeholder="Search titles, #tags, ingredients…" autocomplete="off" autocapitalize="none" value="${esc(query)}">
      <button id="clear" class="btn" type="button">Clear</button>
    </div>
    <p id="count" class="muted small" style="margin:0 0 4px"></p>
    <ul id="rows" class="list"><li class="muted" style="padding:14px 2px">Loading…</li></ul>`;
  await ensureLibrary();
  search(query);
  const input = document.getElementById("q");
  input.addEventListener("input", () => search(input.value));
  document.getElementById("clear").addEventListener("click", () => { input.value = ""; search(""); });
}

async function ensureLibrary() {
  if (library) return library;
  try {
    return await loadLibrary();
  } catch (e) {
    view.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    throw e;
  }
}

// ---- One recipe, for cooking from ----

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch { /* low battery mode or unsupported: the screen just sleeps as usual */ }
}
// iOS drops the lock when you switch apps; take it back when you return to a recipe.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && location.hash.startsWith("#/r/")) keepAwake(true);
});

/** Lists under Ingredients and Steps (or Method, Instructions) become tap-to-cross-off. */
function checkable(body, key) {
  const done = new Set(store.get(`done:${key}`, []));
  let on = false;
  let n = 0;
  for (const el of body.children) {
    if (el.tagName === "H2") on = /ingredient|step|method|instruction|direction/i.test(el.textContent);
    else if (on) {
      for (const li of el.querySelectorAll("li")) {
        const id = n++;
        li.classList.add("check");
        li.classList.toggle("done", done.has(id));
        li.addEventListener("click", (e) => {
          if (e.target.closest("a")) return;
          li.classList.toggle("done");
          li.classList.contains("done") ? done.add(id) : done.delete(id);
          store.set(`done:${key}`, [...done]);
        });
      }
    }
  }
  return () => {
    store.set(`done:${key}`, []);
    body.querySelectorAll("li.done").forEach((li) => li.classList.remove("done"));
    done.clear();
  };
}

/**
 * The footer: jump to Ingredients or Steps, and Return to where you were. Return swaps places with the remembered
 * spot, so it flips between a step and its ingredient. Leaving the recipe remembers where you were reading.
 */
function jumpBar(body, key) {
  const heads = [...body.querySelectorAll("h2")];
  const targets = {
    ingredients: heads.find((h) => /ingredient/i.test(h.textContent)),
    steps: heads.find((h) => /step|method|instruction|direction/i.test(h.textContent)),
  };
  const bar = view.querySelector(".jump");
  const back = bar.querySelector('[data-jump="back"]');
  let mark = store.get(`mark:${key}`, null);
  let jumpedTo = null; // where the last jump landed; a second jump from there keeps the first mark
  const remember = (y) => {
    mark = y;
    store.set(`mark:${key}`, mark);
    back.disabled = mark === null;
  };
  for (const [name, h] of Object.entries(targets)) bar.querySelector(`[data-jump="${name}"]`).disabled = !h;
  back.disabled = mark === null;
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const here = scrollY;
    if (b.dataset.jump === "back") {
      if (mark === null) return;
      scrollTo(0, mark);
      remember(here);
      jumpedTo = null;
    } else {
      if (jumpedTo === null || Math.abs(here - jumpedTo) > 2) remember(here);
      targets[b.dataset.jump].scrollIntoView();
      jumpedTo = scrollY;
    }
  });
  return () => {
    if (scrollY > 40 && (jumpedTo === null || Math.abs(scrollY - jumpedTo) > 2)) remember(scrollY);
  };
}

let leaveRecipe = null;
addEventListener("pagehide", () => leaveRecipe?.());

async function recipeView(key) {
  await ensureLibrary();
  const r = library.recipes.find((x) => x.key === key);
  if (!r) {
    view.innerHTML = `<p class="error">That recipe isn't in your library any more.</p><p><a href="#/">All recipes</a></p>`;
    return;
  }
  document.title = r.title;
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "link"; } };
  const facts = [
    r.servings && `Serves ${esc(r.servings)}`,
    r.prep_time && `Prep ${esc(r.prep_time)}`,
    r.cook_time && `Cook ${esc(r.cook_time)}`,
    r.source && `<a href="${esc(r.source)}" target="_blank" rel="noopener">${esc(host(r.source))}</a>`,
    r.recipe_url && `<a href="${esc(r.recipe_url)}" target="_blank" rel="noopener">${esc(host(r.recipe_url))}</a>`,
  ].filter(Boolean);
  const big = store.get("big", false);
  document.body.classList.toggle("big", big);
  view.innerHTML = `
    <article class="recipe">
      <h1>${esc(r.title)}${badge(r.status)}</h1>
      ${facts.length ? `<div class="facts">${facts.join("")}</div>` : ""}
      ${r.status_reason ? `<p class="reason error small">${esc(r.status_reason)}</p>` : ""}
      ${r.tags.length ? `<div class="facts">${r.tags.map((t) => `<a href="#/?q=${encodeURIComponent("#" + t)}">#${esc(t)}</a>`).join("")}</div>` : ""}
      <div class="tools">
        <button class="btn quiet" id="size">${big ? "Smaller text" : "Bigger text"}</button>
        <button class="btn quiet" id="reset">Uncross all</button>
      </div>
      <p class="muted small" style="margin:6px 0 0">Tap an ingredient or step to cross it off.${"wakeLock" in navigator ? " The screen stays on while a recipe is open." : ""}</p>
      <div class="body">${r.html}</div>
      <nav class="jump">
        <button data-jump="ingredients">Ingredients</button>
        <button data-jump="steps">Steps</button>
        <button data-jump="back">Return</button>
      </nav>
    </article>`;
  const body = view.querySelector(".body");
  const reset = checkable(body, key);
  leaveRecipe = jumpBar(body, key);
  document.getElementById("reset").addEventListener("click", reset);
  document.getElementById("size").addEventListener("click", (e) => {
    const now = !document.body.classList.contains("big");
    document.body.classList.toggle("big", now);
    store.set("big", now);
    e.target.textContent = now ? "Smaller text" : "Bigger text";
  });
  keepAwake(true);
  scrollTo(0, 0);
}

// ---- What can I cook? ----

let ingredientList = null; // names for autocomplete, from the Mac

async function names() {
  if (!ingredientList) ingredientList = ask("/api/ingredients").catch((e) => { ingredientList = null; throw e; });
  return ingredientList;
}

/** A text field that suggests ingredient names the rulebook knows. */
function nameField(id, placeholder) {
  return `<input id="${id}" class="field" list="${id}-names" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="none" enterkeyhint="go">
    <datalist id="${id}-names"></datalist>`;
}

function fillNames(id) {
  names().then(({ names }) => {
    document.getElementById(`${id}-names`)?.replaceChildren(...names.map((n) => Object.assign(document.createElement("option"), { value: n })));
  }).catch(() => { /* suggestions are a nicety; the lookup itself reports the problem */ });
}

async function cookView(params) {
  let have = params.getAll("have");
  view.innerHTML = `
    <h2 class="section" style="margin-top:4px">What do you have?</h2>
    <form id="add" class="search">${nameField("ing", "kabocha, kale, chickpeas…")}<button class="btn">Add</button></form>
    <div id="have" class="chips"></div>
    <div id="results"></div>`;
  fillNames("ing");
  const input = document.getElementById("ing");
  const drawHave = () => {
    document.getElementById("have").innerHTML = have
      .map((h, i) => `<button class="chip on" data-i="${i}">${esc(h)}<span class="x">×</span></button>`).join("");
  };
  const search = () => {
    const hash = have.length ? `#/cook?${have.map((h) => `have=${encodeURIComponent(h)}`).join("&")}` : "#/cook";
    history.replaceState(null, "", hash);
    report();
    runCook(have);
  };
  document.getElementById("add").addEventListener("submit", (e) => {
    e.preventDefault();
    const typed = input.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    input.value = "";
    if (!typed.length) return;
    have = [...new Set([...have, ...typed])];
    drawHave();
    search();
  });
  document.getElementById("have").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    have.splice(Number(b.dataset.i), 1);
    drawHave();
    search();
  });
  drawHave();
  if (have.length) runCook(have);
  else document.getElementById("results").innerHTML =
    `<p class="muted">Add what's in the fridge. Recipes using the most of it come first, then the ones needing least else.</p>`;
}

async function runCook(have) {
  const out = document.getElementById("results");
  if (!have.length) return void (out.innerHTML = "");
  out.innerHTML = `<p class="muted">Asking your Mac…</p>`;
  try {
    const res = await ask(`/api/cook?${have.map((h) => `have=${encodeURIComponent(h)}`).join("&")}`);
    if (document.getElementById("results") !== out) return; // you've moved on
    const notes = res.notes.length ? `<ul class="notes">${res.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
    const pantry = res.pantry.length ? `<p class="muted small">Assuming you have ${esc(res.pantry.join(", "))} (your pantry) and the usual staples.</p>` : "";
    out.innerHTML = notes + (res.matches.length
      ? `<p class="muted small">${res.matches.length} recipe${res.matches.length === 1 ? " uses" : "s use"} ${esc(have.join(", "))}.</p>${pantry}
         <ul class="list">${res.matches.map((m) => `<li><a href="#/r/${encodeURIComponent(m.key)}">
           <div class="title"><span class="score">${m.count}/${have.length}</span>${esc(m.title)}${badge(m.status)}</div>
           <div class="meta">${esc(m.uses.join(", "))} · ${m.missing.length ? `needs ${esc(m.missing.join(", "))}` : "needs nothing else"}</div>
         </a></li>`).join("")}</ul>`
      : `<p>No saved recipes use ${esc(have.join(", "))}.</p>`);
    ingredientList = null; // a new word may have been learned
  } catch (e) {
    out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ---- Swaps: what can stand in for an ingredient ----

async function swapView(name) {
  view.innerHTML = `
    <h2 class="section" style="margin-top:4px">What can I use instead of…</h2>
    <form id="ask" class="search">${nameField("sw", "buttermilk, shallot, gochujang…")}<button class="btn">Look up</button></form>
    <div id="swap"></div>`;
  fillNames("sw");
  const input = document.getElementById("sw");
  input.value = name;
  document.getElementById("ask").addEventListener("submit", (e) => {
    e.preventDefault();
    const n = input.value.trim().toLowerCase();
    if (n) location.hash = `#/swap/${encodeURIComponent(n)}`;
  });
  if (name) runSwap(name);
  else document.getElementById("swap").innerHTML =
    `<p class="muted">Swaps, related kinds, and how to make it from other things. The first lookup of a new ingredient asks Claude, so it takes a few seconds.</p>`;
}

async function runSwap(name) {
  const out = document.getElementById("swap");
  out.innerHTML = `<p class="muted">Asking your Mac…</p>`;
  try {
    const { info, notes } = await ask(`/api/swap?name=${encodeURIComponent(name)}`);
    if (document.getElementById("swap") !== out) return;
    const row = (label, value) => value ? `<dt>${esc(label)}</dt><dd>${value}</dd>` : "";
    const list = (xs) => xs.length ? xs.map((x) => `<a href="#/swap/${encodeURIComponent(x)}">${esc(x)}</a>`).join(", ") : "";
    const makes = info.makes.map((w) =>
      `${esc(w.from)}${w.of === info.name ? "" : ` <span class="muted">(as ${esc(w.of)})</span>`}${w.how ? `<span class="how">${esc(w.how)}</span>` : ""}`
    ).join("<br>");
    const nothing = !info.swaps.length && !info.kinds.length && !info.kindOf.length && !info.makes.length;
    const recipes = (title, rs) => rs.length
      ? `<h2 class="section">${esc(title)}</h2><ul class="list">${rs.map((r) =>
        `<li><a href="#/r/${encodeURIComponent(r.key)}"><div class="title">${esc(r.title)}${badge(r.status)}</div></a></li>`).join("")}</ul>`
      : "";
    out.innerHTML = `
      ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      ${info.typed !== info.name ? `<p class="muted small">${esc(info.typed)} is another name for ${esc(info.name)}.</p>` : ""}
      ${nothing
        ? `<p>Nothing in the rulebook stands in for ${esc(info.name)}. On the Mac: <code>recipe-saver ingredient swap ${esc(info.name)}, &lt;name&gt;</code></p>`
        : `<p>Instead of <strong>${esc(info.name)}</strong>, you can use:</p>
           <dl class="facts-table">
             ${row("swaps", list(info.swaps))}
             ${row("kinds of it", list(info.kinds))}
             ${row("more general", list(info.kindOf))}
             ${row(info.kindOf.length ? `other ${info.kindOf[0]}` : "", list(info.siblings))}
             ${row("make it from", makes)}
           </dl>`}
      ${recipes(`Recipes using ${info.name}`, info.recipes)}
      ${recipes(`Could go in as a swap`, info.swapRecipes)}`;
    ingredientList = null;
  } catch (e) {
    out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ---- Refresh, at the bottom of every page: a home-screen app has no reload button ----

document.getElementById("refresh").addEventListener("click", (e) => {
  e.target.disabled = true;
  e.target.textContent = "Refreshing…";
  // The whole app reloads, from the outer page, so every frame comes back as it was.
  if (framed) parent.postMessage({ type: "refresh" }, location.origin);
  else location.reload();
});

// ---- Routing ----

async function route() {
  const hash = location.hash.slice(1) || "/";
  const [path, qs = ""] = hash.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  leaveRecipe?.();
  leaveRecipe = null;
  document.title = { cook: "Cook", swap: parts[1] ? `Swaps: ${parts[1]}` : "Swaps" }[parts[0]] ?? "Recipes";
  if (parts[0] !== "r") {
    keepAwake(false);
    document.body.classList.remove("big");
  }
  try {
    if (parts[0] === "r" && parts[1]) await recipeView(parts[1]);
    else if (parts[0] === "cook") await cookView(new URLSearchParams(qs));
    else if (parts[0] === "swap") await swapView(parts[1] ?? "");
    else await recipesView(new URLSearchParams(qs));
  } catch { /* already shown on the page */ }
  report();
}

// Moving to another page (a link, a tab, Back) gives the frame new colours; the outer page picks them.
addEventListener("hashchange", () => {
  if (framed) parent.postMessage({ type: "navigated" }, location.origin);
  else document.documentElement.dataset.palette = String((Number(document.documentElement.dataset.palette) + 1 + Math.floor(Math.random() * 3)) % 4);
  route();
});
route();
// Fetch the library in the background too, so the phone has every recipe saved before you need it offline.
if (!library) loadLibrary().catch(() => {});
