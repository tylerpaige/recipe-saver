import { join } from "@std/path";
import { limits, paths } from "./config.ts";
import { CookieJar } from "./cookies.ts";
import { ItemError, SystemicError, TransientError } from "./errors.ts";
import { extract, type Recipe, searchRecipeUrl, type Signals } from "./extract.ts";
import { fetchInfo, instagramId } from "./fetch.ts";
import { downloadVideo, extractFrames, transcribe } from "./media.ts";
import { candidateUrls, fetchRecipePage } from "./recipepage.ts";
import { type RenderInput, renderMarkdown, type Source, writeRecipe } from "./render.ts";
import {
  acquireLock, loadState, log, notifyOnce, pruneDebug, releaseLock, saveDebug, saveState,
} from "./state.ts";

type State = Awaited<ReturnType<typeof loadState>>;

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

async function inboxItems(): Promise<{ path: string; url: string }[]> {
  const items: { path: string; url: string; mtime: number }[] = [];
  try {
    for await (const e of Deno.readDir(paths.inbox)) {
      // Skip hidden files and iCloud placeholders (".name.icloud") not yet downloaded.
      if (!e.isFile || e.name.startsWith(".") || e.name.endsWith(".icloud")) continue;
      const path = join(paths.inbox, e.name);
      const url = (await Deno.readTextFile(path)).match(URL_RE)?.[0];
      const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
      if (url) items.push({ path, url, mtime });
      else {
        await log(`${e.name}: no URL inside, removing`);
        await Deno.remove(path);
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return items.sort((a, b) => a.mtime - b.mtime);
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
      try {
        await processUrl(item.url, () => jar.file(), state);
        delete state.attempts[id];
        await Deno.remove(item.path);
      } catch (e) {
        if (e instanceof SystemicError) {
          await log(`${id}: ${e.kind}: ${e.message}`);
          await notifyOnce(state, e.kind, e.message);
          break; // every later item would fail the same way
        }
        const n = (state.attempts[id] ?? 0) + 1;
        state.attempts[id] = n;
        await log(`${id}: attempt ${n} failed: ${e instanceof Error ? e.message : e}`);
        if (n >= limits.maxTransientAttempts) {
          const kind = e instanceof TransientError ? "network" : "unexpected";
          await notifyOnce(state, kind, `Couldn't save a recipe after ${n} tries. See the log.`);
        }
      } finally {
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

/** Process one URL immediately and print the Markdown instead of saving it. */
async function preview(url: string) {
  const jar = new CookieJar();
  try {
    await processUrl(url, () => jar.file(), await loadState(), { stdout: true });
  } finally {
    await jar.cleanup();
  }
}

const [cmd = "run", arg] = Deno.args;
const usage = "usage: recipe-saver [run | add <url> | preview <url>]";
if (cmd === "run") await run();
else if (cmd === "add" && arg) await add(arg);
else if (cmd === "preview" && arg) await preview(arg);
else {
  console.error(usage);
  Deno.exit(2);
}
