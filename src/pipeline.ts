// Getting a recipe out of a URL: the tiered extraction for Instagram posts, and recipe pages shared directly.
import { join } from "@std/path";
import { extract, type Recipe, searchRecipeUrl, type Signals } from "./extract.ts";
import { ItemError } from "./errors.ts";
import { fetchInfo, instagramId } from "./fetch.ts";
import { downloadVideo, extractFrames, transcribe } from "./media.ts";
import { candidateUrls, fetchRecipePage } from "./recipepage.ts";
import type { RenderInput, Source } from "./render.ts";
import { log, saveDebug } from "./state.ts";

function emptyRecipe(reason: string): Recipe {
  return {
    is_recipe: true, title: null, servings: null, prep_time: null, cook_time: null,
    total_time: null, ingredients: [], steps: [], notes: [], tags: [], linked_urls: [],
    status: "needs-source", missing: [], reason,
  };
}

const RANK = { "needs-source": 0, partial: 1, complete: 2 } as const;

/** Tiers 1–3 for an Instagram post. Returns null for non-recipes. */
async function instagramRecipe(url: string, id: string, cookiesFile: string): Promise<RenderInput | null> {
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

/**
 * The recipe for one URL, or null when it isn't a recipe. A post that can't be fetched at all
 * becomes a needs-source placeholder you can finish by hand. Throws SystemicError / TransientError.
 */
export async function recipeFor(url: string, id: string, cookies: () => Promise<string>): Promise<RenderInput | null> {
  try {
    return instagramId(url) ? await instagramRecipe(url, id, await cookies()) : await pageRecipe(url, id);
  } catch (e) {
    if (!(e instanceof ItemError)) throw e;
    return { recipe: emptyRecipe(`Couldn't fetch the post: ${e.message}`), id, url, creator: null, extractedFrom: [] };
  }
}
