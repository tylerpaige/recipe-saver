// The CLI commands other than `run` and `preview`. All read-only except `add` and `clean`.
import { join } from "@std/path";
import { bin, EDITOR_APP, limits, paths } from "./config.ts";
import { itemId } from "./ids.ts";
import { enqueue, inboxItems, pendingDownloads, type TagOptions, URL_RE } from "./inbox.ts";
import { findRecipe, readRecipes, type SavedRecipe } from "./library.ts";
import { hashtag } from "./render.ts";
import { loadState, logFile, runInProgress } from "./state.ts";

export async function add(url: string, opts: TagOptions) {
  const id = await itemId(url);
  await enqueue(url, id, opts);
  const tags = opts.tags.map((t) => `#${hashtag(t)}`).join(" ");
  const tagging = opts.autoTag ? (tags ? `, tagged ${tags} plus Claude's tags` : "") : tags ? `, tagged ${tags} only` : ", without tags";
  console.log(`Queued ${id}${tagging}`);
  const saved = await findRecipe(id);
  if (saved) console.log(`It's already saved as ${saved.file}, so it will be skipped.`);
}

export function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

/** Print the queue, oldest first (the order `run` processes it). Read-only. */
export async function queue() {
  const state = await loadState();
  const items = await inboxItems({ prune: false });
  const syncing = await pendingDownloads();
  if (!items.length && !syncing) {
    console.log("Queue is empty.");
    return;
  }
  if (items.length) console.log(`${items.length} queued (oldest first):`);
  for (const item of items) {
    const id = await itemId(item.url);
    const notes = [];
    const tries = state.attempts[id];
    if (tries) notes.push(`${tries} failed attempt${tries === 1 ? "" : "s"}`);
    if (item.tags.length) notes.push(item.tags.map((t) => `#${hashtag(t)}`).join(" "));
    if (!item.autoTag) notes.push("no Claude tags");
    if (state.notRecipes[id] || await findRecipe(id)) notes.push("already done, will be skipped");
    const suffix = notes.length ? `  (${notes.join("; ")})` : "";
    console.log(`  ${id.padEnd(16)} ${ago(item.mtime).padStart(7)}  ${item.url}${suffix}`);
  }
  if (syncing) console.log(`${syncing} more still downloading from iCloud.`);
}

const dim = (s: string) => Deno.stdout.isTerminal() ? `\x1b[2m${s}\x1b[0m` : s;

/** Opens a saved recipe (by id or shared URL) in iA Writer. */
export async function open(target: string) {
  const id = URL_RE.test(target) ? await itemId(target) : target;
  const recipe = await findRecipe(id);
  if (!recipe) {
    console.error(`No saved recipe with id ${id}`);
    Deno.exit(1);
  }
  await openFile(recipe.file);
}

async function openFile(file: string) {
  const { success } = await new Deno.Command(bin.open, { args: ["-a", EDITOR_APP, file] }).spawn().status;
  if (!success) Deno.exit(1);
}

const flagFor = (r: SavedRecipe) => r.status && r.status !== "complete" ? ` (${r.status})` : "";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const MAX_TITLE = 48;

/** "Oct 26", with the year only when it isn't this one. `saved` is "YYYY-MM-DD HH:MM". */
function shortDate(saved: string): string {
  const d = new Date(saved.slice(0, 10) + "T00:00");
  if (isNaN(d.getTime())) return saved;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** One picker row: the title in an aligned column, then the date and tags dimmed, cut at a whole tag to fit the terminal. */
function pickerRows(recipes: SavedRecipe[]): string[] {
  const titles = recipes.map((r) => {
    const t = r.title + flagFor(r);
    return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1) + "…" : t;
  });
  const titleWidth = Math.max(...titles.map((t) => t.length));
  const dates = recipes.map((r) => shortDate(r.saved));
  const dateWidth = Math.max(...dates.map((d) => d.length));
  // gum's cursor and padding take 2 columns.
  const room = Deno.consoleSize().columns - 2 - titleWidth - 2 - dateWidth - 2;
  return recipes.map((r, i) => {
    let tags = "";
    for (const t of r.tags.map((t) => `#${t}`)) {
      const next = tags ? `${tags} ${t}` : t;
      if (next.length > room) {
        if (tags) tags += " …";
        break;
      }
      tags = next;
    }
    return `${titles[i].padEnd(titleWidth)}  \x1b[2m${dates[i].padEnd(dateWidth)}  ${tags}\x1b[0m`.trimEnd();
  });
}

/** Lets you pick a recipe with `gum filter`. Undefined if you cancel. */
async function pick(recipes: SavedRecipe[], header: string): Promise<SavedRecipe | undefined> {
  const lines = pickerRows(recipes);
  const plain = lines.map((l) => l.replace(ANSI_RE, ""));
  const child = new Deno.Command(bin.gum, {
    args: ["filter", "--no-strip-ansi", "--header", header, "--placeholder", "Type to filter by title, tag or date…"],
    stdin: "piped", stdout: "piped", stderr: "inherit",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(lines.join("\n")));
  await writer.close();
  const { success, stdout } = await child.output();
  if (!success) return; // Esc / Ctrl-C
  const chosen = new TextDecoder().decode(stdout).replace(/\n$/, "").replace(ANSI_RE, "");
  return recipes[plain.indexOf(chosen)];
}

const interactive = async () =>
  Deno.stdin.isTerminal() && Deno.stdout.isTerminal() && await Deno.stat(bin.gum).then(() => true, () => false);

/**
 * Saved recipes, newest first. With tags, only recipes carrying all of them.
 * In a terminal, a `gum filter` picker that opens the chosen recipe; otherwise (or with `plain`) one page of text.
 */
export async function list(tags: string[], pageNo: number, plain = false) {
  const wanted = tags.map(hashtag).filter(Boolean);
  const all = await readRecipes();
  const recipes = all.filter((r) => wanted.every((t) => r.tags.includes(t)));
  const tagged = wanted.map((t) => `#${t}`).join(" ");
  if (!recipes.length) {
    console.log(all.length ? `No recipes tagged ${tagged}.` : "No recipes saved yet.");
    return;
  }
  if (!plain && await interactive()) {
    const noun = recipes.length === 1 ? "recipe" : "recipes";
    const chosen = await pick(recipes, `${recipes.length} ${noun}${wanted.length ? ` tagged ${tagged}` : ""}`);
    if (chosen) await openFile(chosen.file);
    return;
  }
  const size = limits.recipesPerPage;
  const pages = Math.ceil(recipes.length / size);
  if (pageNo > pages) {
    console.log(`There ${pages === 1 ? "is only 1 page" : `are only ${pages} pages`}.`);
    return;
  }
  const noun = recipes.length === 1 ? "recipe" : "recipes";
  const first = (pageNo - 1) * size;
  const shown = recipes.slice(first, first + size);
  const range = pages > 1 ? `, showing ${first + 1}–${first + shown.length}` : "";
  console.log(`${recipes.length} ${noun}${wanted.length ? ` tagged ${tagged}` : ""}${range}:`);
  for (const r of shown) {
    console.log(`\n${r.saved}  ${r.title}${flagFor(r)}`);
    console.log(dim(`            ${[r.id, r.tags.map((t) => `#${t}`).join(" ")].filter(Boolean).join("  ")}`));
  }
  if (pageNo < pages) {
    const next = ["recipe-saver list", ...tags.map((t) => t.includes(" ") ? `"${t}"` : t), `--page ${pageNo + 1}`];
    console.log(`\nPage ${pageNo} of ${pages}. Next: ${next.join(" ")}`);
  } else if (pages > 1) console.log(`\nPage ${pageNo} of ${pages}.`);
}

async function agentLoaded(): Promise<boolean> {
  const uid = Deno.uid();
  const { success } = await new Deno.Command(bin.launchctl, {
    args: ["print", `gui/${uid}/local.recipe-saver`], stdout: "null", stderr: "null",
  }).output();
  return success;
}

/** App status (no argument) or one recipe's status. First line is the status word; details follow. */
export async function status(target?: string) {
  const state = await loadState();
  const running = await runInProgress();
  const queued = await inboxItems({ prune: false });
  const queuedIds = await Promise.all(queued.map((q) => itemId(q.url)));
  const stuck = queuedIds.filter((id) => (state.attempts[id] ?? 0) >= limits.maxTransientAttempts);
  const say = (word: string, ...details: string[]) => {
    console.log(word);
    for (const d of details) console.log(`  ${d}`);
  };

  if (target) {
    const id = URL_RE.test(target) ? await itemId(target) : target;
    const tries = state.attempts[id] ?? 0;
    if (running && state.current?.id === id) return say("processing", `${id}, started ${ago(Date.parse(state.current.since))}`);
    if (queuedIds.includes(id)) {
      if (tries >= limits.maxTransientAttempts) return say("error", `${id} failed ${tries} times; still queued. See: recipe-saver log ${id}`);
      if (state.lastError?.id === id) return say("error", `${state.lastError.kind}: ${state.lastError.message}`);
      return say("waiting_to_start", tries ? `${id}, queued (${tries} failed attempt${tries === 1 ? "" : "s"}, will retry)` : `${id}, queued`);
    }
    const saved = await findRecipe(id);
    if (saved) return say("saved", `${saved.title} (${saved.status || "unknown"})`, saved.file);
    if (state.notRecipes[id]) return say("not_recipe", `${id} wasn't a recipe; nothing saved`);
    return say("not_found", `No queued or saved recipe with id ${id}`);
  }

  const errors: string[] = [];
  if (state.lastError) errors.push(`${state.lastError.id}: ${state.lastError.kind}: ${state.lastError.message} (${ago(Date.parse(state.lastError.at))})`);
  for (const id of stuck) if (state.lastError?.id !== id) errors.push(`${id} failed ${state.attempts[id]} times`);
  if (!(await agentLoaded())) errors.push("launchd agent isn't loaded, so nothing will process the queue (see README: Mac setup)");
  const waiting = `${queued.length} queued`;
  if (running) {
    const now = state.current ? `${state.current.id}, started ${ago(Date.parse(state.current.since))}` : "starting";
    return say("processing", now, waiting, ...errors.map((e) => `earlier error: ${e}`));
  }
  if (errors.length) return say("error", ...errors, ...(queued.length ? [waiting] : []));
  const syncing = await pendingDownloads();
  if (queued.length || syncing) return say("waiting_to_start", syncing ? `${waiting}, ${syncing} more downloading from iCloud` : waiting);
  return say("idle_no_queue");
}

/** The log, optionally just one recipe's lines and/or the last N. */
export async function showLog(id: string | undefined, tail: number | undefined) {
  let lines: string[];
  try {
    lines = (await Deno.readTextFile(logFile())).split("\n").filter(Boolean);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    lines = [];
  }
  // Lines look like "<ISO time> <id>: message".
  if (id) lines = lines.filter((l) => l.split(" ", 2)[1] === `${id}:`);
  if (tail !== undefined) lines = lines.slice(-tail);
  if (!lines.length) console.log(id ? `No log entries for ${id}.` : "Log is empty.");
  for (const l of lines) console.log(l);
}

/** Empties the app log and launchd's stdout/stderr log. Truncates rather than deletes, since launchd keeps its file open. */
export async function clean() {
  for (const file of [logFile(), join(paths.state, "launchd.log")]) {
    try {
      const { size } = await Deno.stat(file);
      await Deno.truncate(file);
      console.log(`Cleared ${file} (${Math.ceil(size / 1024)} KB)`);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}
