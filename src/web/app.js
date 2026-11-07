// The kitchen website: your recipes (kept on the phone for offline use), cook and swap lookups (asked of the Mac).
// Routes live in the URL hash: #/, #/r/<key>, #/cook?have=a&have=b, #/swap/<name>.
"use strict";

const view = document.getElementById("view");
const offline = document.getElementById("offline");
const TAGS_SHOWN = 12;

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
let chosenTags = [];
let allTagsShown = false;

const plain = (html) => html.replace(/<[^>]+>/g, " ");
const words = (s) => s.toLowerCase().split(/\s+/).filter(Boolean);

function filtered() {
  const q = words(query);
  return library.recipes
    .filter((r) => chosenTags.every((t) => r.tags.includes(t)))
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

function tagCounts() {
  const counts = new Map();
  for (const r of library.recipes) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderList() {
  const rows = filtered();
  const tags = tagCounts();
  const shown = allTagsShown ? tags : tags.slice(0, TAGS_SHOWN);
  for (const t of chosenTags) if (!shown.some(([s]) => s === t)) shown.unshift([t, 0]);
  const chips = shown.map(([t]) => `<button class="chip ${chosenTags.includes(t) ? "on" : ""}" data-tag="${esc(t)}">#${esc(t)}</button>`);
  if (tags.length > TAGS_SHOWN) chips.push(`<button class="chip more" data-more>${allTagsShown ? "fewer" : `all ${tags.length} tags`}</button>`);
  document.getElementById("chips").innerHTML = chips.join("");
  document.getElementById("rows").innerHTML = rows.length
    ? rows.map((r) => `<li><a href="#/r/${encodeURIComponent(r.key)}">
        <div class="title">${esc(r.title)}${badge(r.status)}</div>
        <div class="meta">${esc(shortDate(r.saved))}${r.tags.length ? " · " + r.tags.map((t) => "#" + esc(t)).join(" ") : ""}</div>
      </a></li>`).join("")
    : `<li class="muted" style="padding:14px 2px">No recipes match.</li>`;
  document.getElementById("count").textContent =
    `${rows.length} of ${library.recipes.length} recipe${library.recipes.length === 1 ? "" : "s"}`;
}

async function recipesView() {
  view.innerHTML = `
    <div class="search"><input id="q" type="search" placeholder="Search titles, tags, ingredients…" autocomplete="off" value="${esc(query)}"></div>
    <div id="chips" class="chips"></div>
    <p id="count" class="muted small" style="margin:0 0 4px"></p>
    <ul id="rows" class="list"><li class="muted" style="padding:14px 2px">Loading…</li></ul>`;
  await ensureLibrary();
  renderList();
  document.getElementById("q").addEventListener("input", (e) => { query = e.target.value; renderList(); });
  document.getElementById("chips").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-more")) allTagsShown = !allTagsShown;
    else {
      const t = b.dataset.tag;
      chosenTags = chosenTags.includes(t) ? chosenTags.filter((x) => x !== t) : [...chosenTags, t];
    }
    renderList();
  });
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
      ${r.tags.length ? `<div class="chips">${r.tags.map((t) => `<a class="chip" href="#/" data-tag="${esc(t)}">#${esc(t)}</a>`).join("")}</div>` : ""}
      <div class="tools">
        <button class="btn quiet" id="size">${big ? "Smaller text" : "Bigger text"}</button>
        <button class="btn quiet" id="reset">Uncross all</button>
      </div>
      <p class="muted small" style="margin:6px 0 0">Tap an ingredient or step to cross it off.${"wakeLock" in navigator ? " The screen stays on while a recipe is open." : ""}</p>
      <div class="body">${r.html}</div>
    </article>`;
  const reset = checkable(view.querySelector(".body"), key);
  document.getElementById("reset").addEventListener("click", reset);
  document.getElementById("size").addEventListener("click", (e) => {
    const now = !document.body.classList.contains("big");
    document.body.classList.toggle("big", now);
    store.set("big", now);
    e.target.textContent = now ? "Smaller text" : "Bigger text";
  });
  view.querySelectorAll(".chips a[data-tag]").forEach((a) =>
    a.addEventListener("click", () => { chosenTags = [a.dataset.tag]; query = ""; })
  );
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

// ---- Routing ----

async function route() {
  const hash = location.hash.slice(1) || "/";
  const [path, qs = ""] = hash.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const section = parts[0] === "r" || !parts[0] ? "recipes" : parts[0];
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === section));
  document.title = "Recipes";
  if (parts[0] !== "r") {
    keepAwake(false);
    document.body.classList.remove("big");
  }
  try {
    if (parts[0] === "r" && parts[1]) await recipeView(parts[1]);
    else if (parts[0] === "cook") await cookView(new URLSearchParams(qs));
    else if (parts[0] === "swap") await swapView(parts[1] ?? "");
    else await recipesView();
  } catch { /* already shown on the page */ }
}

addEventListener("hashchange", route);
route();
// Fetch the library in the background too, so the phone has every recipe saved before you need it offline.
if (!library) loadLibrary().catch(() => {});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
