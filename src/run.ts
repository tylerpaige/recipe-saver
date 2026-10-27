// Draining the queue: what launchd runs.
import { limits, paths } from "./config.ts";
import { CookieJar } from "./cookies.ts";
import { SystemicError, TransientError } from "./errors.ts";
import { itemId } from "./ids.ts";
import { inboxItems } from "./inbox.ts";
import { findRecipe } from "./library.ts";
import { recipeFor } from "./pipeline.ts";
import { renderMarkdown, writeRecipe } from "./render.ts";
import {
  acquireLock, loadState, log, notifyOnce, pruneDebug, releaseLock, saveState, type State,
} from "./state.ts";

/**
 * Processes and saves one URL, unless it's already saved or known not to be a recipe.
 * Returns whether anything was fetched. Throws on retryable failures.
 */
async function saveUrl(url: string, cookies: () => Promise<string>, state: State): Promise<boolean> {
  const id = await itemId(url);
  if (state.notRecipes[id]) {
    await log(`${id}: already found not to be a recipe, skipping`);
    return false;
  }
  const existing = await findRecipe(id);
  if (existing) {
    await log(`${id}: already saved as ${existing.file}, skipping`);
    return false;
  }

  const input = await recipeFor(url, id, cookies);
  if (!input) {
    await log(`${id}: not a recipe, skipped`);
    state.notRecipes[id] = new Date().toISOString();
    return true;
  }
  const file = await writeRecipe(paths.recipes, input.recipe.title ?? `Recipe ${id}`, renderMarkdown(input));
  await log(`${id}: saved ${file} (${input.recipe.status}; ${input.extractedFrom.join(", ") || "nothing"})`);
  return true;
}

export async function run() {
  if (!(await acquireLock())) return; // another run is already draining the inbox
  const state = await loadState();
  const jar = new CookieJar();
  try {
    const items = (await inboxItems()).slice(0, limits.maxItemsPerRun);
    let fetched = false; // pause between fetches only; skips cost Instagram nothing
    for (const item of items) {
      const id = await itemId(item.url);
      if (fetched) await new Promise((r) => setTimeout(r, limits.secondsBetweenItems * 1000));
      fetched = true; // a failed attempt may have fetched too
      state.current = { id, since: new Date().toISOString() };
      await saveState(state);
      try {
        fetched = await saveUrl(item.url, () => jar.file(), state);
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

/** Runs the pipeline on one URL and prints the Markdown, saving nothing. Ignores whether it's been saved before. */
export async function preview(url: string) {
  const jar = new CookieJar();
  try {
    const id = await itemId(url);
    const input = await recipeFor(url, id, () => jar.file());
    console.log(input ? renderMarkdown(input) : `${id}: not a recipe`);
  } finally {
    await jar.cleanup();
  }
}
