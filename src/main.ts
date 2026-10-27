import { join } from "@std/path";
import { bin, limits, paths } from "./config.ts";
import { CookieJar } from "./cookies.ts";
import { ItemError, SystemicError, TransientError } from "./errors.ts";
import { extract, type Recipe, searchRecipeUrl, type Signals } from "./extract.ts";
import { fetchInfo, instagramId } from "./fetch.ts";
import { downloadVideo, extractFrames, transcribe } from "./media.ts";
import { readRecipes } from "./library.ts";
import { candidateUrls, fetchRecipePage } from "./recipepage.ts";
import { hashtag, type RenderInput, renderMarkdown, type Source, writeRecipe } from "./render.ts";
import {
  acquireLock, loadState, log, logFile, notifyOnce, pruneDebug, releaseLock, runInProgress, saveDebug,
  saveState, type State,
} from "./state.ts";

const URL_RE = /https?:\/\/\S+/;

function emptyRecipe(reason: string): Recipe {
  return {
    is_recipe: true, title: null, servings: null, prep_time: null, cook_time: null,
    total_time: null, ingredients: [], steps: [], notes: [], tags: [], linked_urls: [],
    status: "needs-source", missing: [], reason,
  };
}

const RANK = { "needs-source": 0, partial: 1, complete: 2 } as const;

/** Tiers 1–3 for an Instagram post. Returns null for non-recipes. */
async function instagramRecipe(url: string, cookiesFile: string): Promise<RenderInput | null> {
  const id = instagramId(url)!;
  const info = await fetchInfo(url, cookiesFile);
  await saveDebug(id, "info.json", info.raw);
  const signals: Signals = { creator: info.creator, caption: info.caption };
  const from: Source[] = ["caption"];
  let recipeUrl: string | undefined;

  // Tier 1: caption only.
  let recipe = await extract(signals);
  await saveDebug(id, "extraction-1.json", recipe);
  if (!recipe.is_recipe) return null;
  const take = (next: Recipe) => {
    if (next.is_recipe && RANK[next.status] >= RANK[recipe.status]) recipe = next;
  };

  // Tier 2: a linked recipe page, or one found by web search.
  if (recipe.status !== "complete") {
    let page = null;
    for (const candidate of candidateUrls(info.caption, recipe.linked_urls).slice(0, 3)) {
      page = await fetchRecipePage(candidate);
      if (page) break;
    }
    if (!page) {
      const found = await searchRecipeUrl(info.creator, recipe.title ?? "", info.caption);
      await log(`${id}: web search -> ${found ?? "nothing"}`);
      if (found) page = await fetchRecipePage(found);
    }
    if (page) {
      signals.page = page;
      const before = recipe;
      take(await extract(signals));
      await saveDebug(id, "extraction-2.json", recipe);
      if (recipe !== before) {
        from.push("recipe-page");
        recipeUrl = page.url;
      } else {
        delete signals.page; // didn't help; don't confuse tier 3
      }
    }
  }

  // Tier 3: what's said and shown in the video (or carousel slides).
  if (recipe.status !== "complete") {
    const dir = await Deno.makeTempDir({ prefix: "recipe-saver-media-" });
    try {
      const video = await downloadVideo(url, cookiesFile, dir);
      if (video) {
        const transcript = await transcribe(video, dir);
        if (transcript) {
          signals.transcript = transcript;
          await saveDebug(id, "transcript.txt", transcript);
        }
        signals.frames = await extractFrames(video, dir);
      } else {
        signals.frames = await downloadSlides(info.raw, dir);
      }
      if (signals.transcript || signals.frames.length) {
        const before = recipe;
        take(await extract(signals));
        await saveDebug(id, "extraction-3.json", recipe);
        if (recipe !== before) {
          if (signals.transcript) from.push("transcript");
          if (signals.frames.length) from.push("frames");
        }
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  }

  return { recipe, id, url, creator: info.creator, recipeUrl, extractedFrom: from };
}

/** Carousel/photo posts: download the slide images. */
async function downloadSlides(raw: unknown, dir: string): Promise<Uint8Array[]> {
  // deno-lint-ignore no-explicit-any
  const info = raw as any;
  // deno-lint-ignore no-explicit-any
  const entries: any[] = info.entries?.length ? info.entries : [info];
  const urls = entries.map((e) => e.thumbnail ?? e.thumbnails?.at(-1)?.url).filter(Boolean).slice(0, 10);
  const out: Uint8Array[] = [];
  for (const [i, u] of urls.entries()) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) out.push(new Uint8Array(await res.arrayBuffer()));
    } catch { /* skip slide */ }
    await Deno.writeFile(join(dir, `slide${i}.jpg`), out.at(-1) ?? new Uint8Array());
  }
  return out;
}

/** Tier 2 only: a recipe page shared directly. */
async function pageRecipe(url: string, id: string): Promise<RenderInput> {
  const page = await fetchRecipePage(url);
  if (!page) {
    return { recipe: emptyRecipe("Couldn't read a recipe from this page."), id, url, creator: null, extractedFrom: [] };
  }
  const recipe = await extract({ creator: null, caption: "", page });
  await saveDebug(id, "extraction-2.json", recipe);
  return { recipe, id, url, creator: null, recipeUrl: page.url, extractedFrom: ["recipe-page"] };
}

async function itemId(url: string): Promise<string> {
  const ig = instagramId(url);
  if (ig) return ig;
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(url));
  return "url-" + [...new Uint8Array(hash)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Processes one URL end to end. Throws SystemicError / TransientError for retryable failures. */
async function processUrl(url: string, cookies: () => Promise<string>, state: State, opts: { stdout?: boolean } = {}) {
  const id = await itemId(url);
  if (state.processed[id] && !opts.stdout) {
    await log(`${id}: already saved, skipping`);
    return;
  }

  let input: RenderInput | null;
  try {
    input = instagramId(url) ? await instagramRecipe(url, await cookies()) : await pageRecipe(url, id);
  } catch (e) {
    if (!(e instanceof ItemError)) throw e;
    // This post can't be fetched at all; leave a placeholder you can finish by hand.
    input = { recipe: emptyRecipe(`Couldn't fetch the post: ${e.message}`), id, url, creator: null, extractedFrom: [] };
  }
  if (!input) {
    await log(`${id}: not a recipe, skipped`);
    if (!opts.stdout) state.processed[id] = { file: null, status: "not-recipe", at: new Date().toISOString() };
    return;
  }

  const markdown = renderMarkdown(input);
  if (opts.stdout) {
    console.log(markdown);
    return;
  }
  const file = await writeRecipe(paths.recipes, input.recipe.title ?? `Recipe ${id}`, markdown);
  state.processed[id] = { file, status: input.recipe.status, at: new Date().toISOString() };
  await log(`${id}: saved ${file} (${input.recipe.status}; ${input.extractedFrom.join(", ") || "nothing"})`);
}

/** Inbox files in processing order. With `prune`, files without a URL are deleted. */
async function inboxItems(
  { prune = true } = {},
): Promise<{ path: string; url: string; mtime: number }[]> {
  const items: { path: string; url: string; mtime: number }[] = [];
  try {
    for await (const e of Deno.readDir(paths.inbox)) {
      // Skip hidden files and iCloud placeholders (".name.icloud") not yet downloaded.
      if (!e.isFile || e.name.startsWith(".") || e.name.endsWith(".icloud")) continue;
      const path = join(paths.inbox, e.name);
      const url = (await Deno.readTextFile(path)).match(URL_RE)?.[0];
      const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
      if (url) items.push({ path, url, mtime });
      else if (prune) {
        await log(`${e.name}: no URL inside, removing`);
        await Deno.remove(path);
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return items.sort((a, b) => a.mtime - b.mtime);
}

/** iCloud placeholders in the inbox: shared from the phone but not yet downloaded to this Mac. */
async function pendingDownloads(): Promise<number> {
  let n = 0;
  try {
    for await (const e of Deno.readDir(paths.inbox)) {
      if (e.isFile && e.name.startsWith(".") && e.name.endsWith(".icloud")) n++;
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return n;
}

async function run() {
  if (!(await acquireLock())) return; // another run is already draining the inbox
  const state = await loadState();
  const jar = new CookieJar();
  try {
    const items = (await inboxItems()).slice(0, limits.maxItemsPerRun);
    for (const [i, item] of items.entries()) {
      const id = await itemId(item.url);
      if (i > 0) await new Promise((r) => setTimeout(r, limits.secondsBetweenItems * 1000));
      state.current = { id, since: new Date().toISOString() };
      await saveState(state);
      try {
        await processUrl(item.url, () => jar.file(), state);
        delete state.attempts[id];
        delete state.lastError;
        await Deno.remove(item.path);
      } catch (e) {
        const at = new Date().toISOString();
        if (e instanceof SystemicError) {
          await log(`${id}: ${e.kind}: ${e.message}`);
          state.lastError = { id, kind: e.kind, message: e.message, at };
          await notifyOnce(state, e.kind, e.message);
          break; // every later item would fail the same way
        }
        const n = (state.attempts[id] ?? 0) + 1;
        state.attempts[id] = n;
        const message = e instanceof Error ? e.message : String(e);
        await log(`${id}: attempt ${n} failed: ${message}`);
        if (n >= limits.maxTransientAttempts) {
          const kind = e instanceof TransientError ? "network" : "unexpected";
          state.lastError = { id, kind, message: `failed ${n} times: ${message}`, at };
          await notifyOnce(state, kind, `Couldn't save a recipe after ${n} tries. See the log.`);
        }
      } finally {
        delete state.current;
        await saveState(state);
      }
    }
    await pruneDebug();
  } finally {
    await jar.cleanup();
    await saveState(state);
    await releaseLock();
  }
}

async function add(url: string) {
  await Deno.mkdir(paths.inbox, { recursive: true });
  const name = await itemId(url);
  await Deno.writeTextFile(join(paths.inbox, `${name}.txt`), url + "\n");
  console.log(`Queued ${name}`);
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

/** Print the queue, oldest first (the order `run` processes it). Read-only. */
async function queue() {
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
    if (state.processed[id]) notes.push("already saved, will be skipped");
    const suffix = notes.length ? `  (${notes.join("; ")})` : "";
    console.log(`  ${id.padEnd(16)} ${ago(item.mtime).padStart(7)}  ${item.url}${suffix}`);
  }
  if (syncing) console.log(`${syncing} more still downloading from iCloud.`);
}

const dim = (s: string) => Deno.stdout.isTerminal() ? `\x1b[2m${s}\x1b[0m` : s;

/** One page of saved recipes, newest first. With tags, only recipes carrying all of them. */
async function list(tags: string[], pageNo: number) {
  const wanted = tags.map(hashtag).filter(Boolean);
  const all = await readRecipes();
  const recipes = all.filter((r) => wanted.every((t) => r.tags.includes(t)));
  const tagged = wanted.map((t) => `#${t}`).join(" ");
  if (!recipes.length) {
    console.log(all.length ? `No recipes tagged ${tagged}.` : "No recipes saved yet.");
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
    const flag = r.status && r.status !== "complete" ? ` (${r.status})` : "";
    console.log(`\n${r.saved}  ${r.title}${flag}`);
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
async function status(target?: string) {
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
    const done = state.processed[id];
    if (done?.status === "not-recipe") return say("not_recipe", `${id} wasn't a recipe; nothing saved`);
    // The file may have moved or been renamed since; find it by its id.
    const saved = (await readRecipes()).find((r) => r.id === id);
    if (saved) return say("saved", `${saved.title} (${saved.status || "unknown"})`, saved.file);
    if (done) return say("saved", `${done.status}, but the file is gone (was ${done.file})`);
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
async function showLog(id: string | undefined, tail: number | undefined) {
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

/** Process one URL immediately and print the Markdown instead of saving it. */
async function preview(url: string) {
  const jar = new CookieJar();
  try {
    await processUrl(url, () => jar.file(), await loadState(), { stdout: true });
  } finally {
    await jar.cleanup();
  }
}

/** Empties the app log and launchd's stdout/stderr log. Truncates rather than deletes, since launchd keeps its file open. */
async function clean() {
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

/** Splits args into positionals and `--name value` / `--name=value` / bare `--name` flags. */
function parseArgs(args: string[]): { rest: string[]; flags: Record<string, string | true> } {
  const rest: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) rest.push(args[i]);
    else if (m[2] !== undefined) flags[m[1]] = m[2];
    else if (/^\d+$/.test(args[i + 1] ?? "")) flags[m[1]] = args[++i];
    else flags[m[1]] = true;
  }
  return { rest, flags };
}

function positiveInt(v: string | true | undefined, fallback: number): number | null {
  if (v === undefined || v === true) return fallback;
  return /^[1-9]\d*$/.test(v) ? Number(v) : null;
}

const [cmd = "run", arg] = Deno.args;
const { rest, flags } = parseArgs(Deno.args.slice(1));
const usage = `usage: recipe-saver <command>
  run                          drain the queue now
  queue                        show what's queued
  list [tag ...] [--page N]    saved recipes, newest first, ${limits.recipesPerPage} per page
  status [id | url]            app status, or one recipe's
  log [id] [--tail [N]]        the log; --tail shows the last N lines (default 20)
  clean                        clear the logs
  add <url>                    queue a URL
  preview <url>                run the pipeline and print the Markdown, saving nothing`;
const pageNo = positiveInt(flags.page, 1);
const tail = flags.tail === undefined ? undefined : positiveInt(flags.tail, 20);
if (cmd === "run") await run();
else if (cmd === "queue") await queue();
else if (cmd === "list" && pageNo) await list(rest, pageNo);
else if (cmd === "status" && rest.length <= 1) await status(rest[0]);
else if (cmd === "log" && rest.length <= 1 && tail !== null) await showLog(rest[0], tail);
else if (cmd === "clean" && !rest.length) await clean();
else if (cmd === "add" && arg) await add(arg);
else if (cmd === "preview" && arg) await preview(arg);
else {
  console.error(usage);
  Deno.exit(2);
}
