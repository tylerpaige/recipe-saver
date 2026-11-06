// `cook`: which saved recipes use the ingredients you have. Claude turns each recipe's ingredient lines into plain names
// once (cached in ingredients.json until the section changes), and maps your words onto those names on each query.
// Counting and ranking is plain code, so the same question gets the same answer.
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { join } from "@std/path";
import { z } from "zod";
import { EFFORT, MODEL, paths } from "./config.ts";
import { TransientError } from "./errors.ts";
import { apiError, getClient } from "./extract.ts";
import { readRecipes, type SavedRecipe } from "./library.ts";

const Ingredient = z.object({
  options: z.array(z.string()).describe('Plain names; more than one only for "X or Y" lines'),
  staple: z.boolean(),
  optional: z.boolean(),
});
type Ingredient = z.infer<typeof Ingredient>;
const IndexedRecipe = z.object({ ingredients: z.array(Ingredient) });

const INDEX_SYSTEM = `You read a recipe's ingredient list and name each ingredient plainly, so it can be matched against what someone has in their kitchen.

One entry per ingredient line. Skip lines that aren't ingredients (equipment, "see notes").

options: the ingredient as a shopper would name it, lowercase, without quantity, size, brand, preparation or packaging.
- Keep words that change what you'd buy: "red lentils", "silken tofu", "smoked paprika", "cherry tomatoes", "white onion", "fresh basil".
- Drop the rest: "1 medium honeynut squash, halved" -> "honeynut squash"; "Diamond Crystal kosher salt" -> "salt"; "1 can chickpeas, drained" -> "chickpeas"; "270 g quartered cherry tomato or similar" -> "cherry tomatoes".
- A line offering a choice gets one option each: "3 tbsp ghee or avocado oil" -> ["ghee", "avocado oil"].
- Name the same ingredient the same way every time it appears.

staple: true only for what nearly every kitchen has and nobody shops for: salt, black pepper, cooking oils, water, ice, sugar, plain flour, baking powder and soda, and dried herbs and spices. Not fresh herbs, butter, vinegars, sauces, or spice pastes (gochujang, harissa, curry paste).

optional: true when the recipe marks it optional, it's only for garnish or serving ("to serve", "for topping"), or it's under a sub-heading marked optional.`;

const Matches = z.object({
  terms: z.array(z.object({
    term: z.string(),
    same: z.array(z.string()),
    kinds: z.array(z.string()),
    substitutes: z.array(z.string()),
  })).describe("One entry per ingredient asked about"),
});

const MATCH_SYSTEM = `Someone lists ingredients they have. For each one, pick the names from the recipes' ingredient list that it can be used as. Use names exactly as they appear in the list.

same: names that are this ingredient, allowing for spelling mistakes, plurals and regional names (zucchini/courgette, eggplant/aubergine, cilantro/coriander leaves, scallion/spring onion/green onion, beet/beetroot), plus more general names it satisfies (kabocha -> "winter squash"; cannellini beans -> "white beans"; cherry tomatoes -> "tomatoes"; yellow onion -> "onion").

kinds: names that are a more specific kind of it (onion -> "red onion", "white onion"; miso -> "white miso"; squash -> "butternut squash"). Not related ingredients (shallot is not a kind of onion) and not products made from it (crispy onions, pickled red onions, onion flakes, pumpkin puree).

substitutes: different ingredients it can stand in for without really changing the dish, the swaps a cook would make without a second thought. Any winter squash for any other (kabocha for butternut, honeynut, pumpkin); one white bean for another; one hearty green for another (kale for cavolo nero or chard); one fresh tomato for another. Not swaps that change the dish's character (tofu for chicken, feta for parmesan, lime for lemon), and not products made from it.

Include a name identical to the ingredient too. Any list may be empty. Repeat each ingredient exactly as given in term.`;

// Bump when INDEX_SYSTEM changes, so every recipe is read again.
const INDEX_VERSION = 1;
// Recipes read at once when building the index.
const CONCURRENCY = 6;

interface IndexFile {
  version: number;
  recipes: Record<string, { hash: string; ingredients: Ingredient[] }>; // by recipe id (file path if it has none)
}

const indexFile = () => join(paths.state, "ingredients.json");
const keyOf = (r: SavedRecipe) => r.id || r.file;

/** Recipes `cook` considers: ones with an ingredient list you could cook from. */
const cookable = (recipes: SavedRecipe[]) => recipes.filter((r) => r.status !== "needs-source" && r.ingredients);

async function sha1(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadIndex(): Promise<IndexFile> {
  try {
    const index: IndexFile = JSON.parse(await Deno.readTextFile(indexFile()));
    if (index.version === INDEX_VERSION) return index;
  } catch { /* missing or unreadable: rebuild */ }
  return { version: INDEX_VERSION, recipes: {} };
}

async function saveIndex(index: IndexFile): Promise<void> {
  await Deno.mkdir(paths.state, { recursive: true });
  const tmp = `${indexFile()}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(index));
  await Deno.rename(tmp, indexFile());
}

/** One structured-output call. */
async function ask<T extends z.ZodType>(schema: T, system: string, text: string): Promise<z.infer<T>> {
  try {
    const response = await (await getClient()).messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: text }],
      output_config: { format: zodOutputFormat(schema), effort: EFFORT },
    });
    if (!response.parsed_output) throw new TransientError(`Claude returned no result (stop_reason: ${response.stop_reason})`);
    return response.parsed_output;
  } catch (error) {
    throw apiError(error);
  }
}

/**
 * Each recipe's ingredients, reading any that are new or changed since last time. Drops recipes that are gone.
 * `onReading` is told how many recipes need reading, before any are.
 */
async function ingredientsOf(recipes: SavedRecipe[], onReading?: (n: number) => void): Promise<Map<string, Ingredient[]>> {
  const index = await loadIndex();
  const todo: { recipe: SavedRecipe; hash: string }[] = [];
  for (const recipe of recipes) {
    const hash = await sha1(recipe.ingredients);
    if (index.recipes[keyOf(recipe)]?.hash !== hash) todo.push({ recipe, hash });
  }
  const keep = new Set(recipes.map(keyOf));
  let changed = false;
  for (const key of Object.keys(index.recipes)) {
    if (!keep.has(key)) {
      delete index.recipes[key];
      changed = true;
    }
  }
  if (todo.length) onReading?.(todo.length);
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(async ({ recipe, hash }) => {
      const { ingredients } = await ask(IndexedRecipe, INDEX_SYSTEM, `<ingredients>\n${recipe.ingredients}\n</ingredients>`);
      index.recipes[keyOf(recipe)] = { hash, ingredients };
    }));
    await saveIndex(index); // keep what's done if a later batch fails
    changed = false;
  }
  if (changed) await saveIndex(index);
  return new Map(recipes.map((r) => [keyOf(r), index.recipes[keyOf(r)]?.ingredients ?? []]));
}

/** Reads the ingredients of any new or edited recipes, so `cook` doesn't have to. Run after saving. */
export async function refreshIngredients(): Promise<number> {
  let read = 0;
  await ingredientsOf(cookable(await readRecipes()), (n) => read = n);
  return read;
}

export interface CookMatch {
  recipe: SavedRecipe;
  uses: string[]; // your ingredients it uses, in the order you gave them: "kale", or "kabocha for butternut squash"
  missing: string[]; // what else it needs, leaving out staples, your pantry and optional extras
}

/**
 * Saved recipes using at least one of `have`, most of them first, then fewest still missing, then newest.
 * Hides recipes you can't cook from (needs-source).
 */
export async function whatToCook(have: string[], pantry: string[], onReading?: (n: number) => void): Promise<CookMatch[]> {
  const recipes = cookable(await readRecipes());
  const ingredients = await ingredientsOf(recipes, onReading);
  const vocabulary = [...new Set([...ingredients.values()].flat().flatMap((i) => i.options))].sort();
  if (!vocabulary.length) return [];

  const asked = [...new Set([...have, ...pantry].map((t) => t.toLowerCase()))];
  const { terms } = await ask(
    Matches,
    MATCH_SYSTEM,
    `<recipe_ingredients>\n${vocabulary.join("\n")}\n</recipe_ingredients>\n\nIngredients they have:\n${asked.join("\n")}`,
  );
  const known = new Set(vocabulary);
  const same = new Map<string, Set<string>>();
  const substitutes = new Map<string, Set<string>>();
  const names = (list?: string[]) => new Set((list ?? []).filter((n) => known.has(n)));
  const answers = new Map(terms.map((t) => [t.term.toLowerCase(), t]));
  for (const term of asked) {
    const answer = answers.get(term);
    // Claude tends to leave out exact matches, so add the term itself, and its plural or singular.
    const exact = [term, `${term}s`, `${term}es`, term.replace(/e?s$/, "")];
    // A more specific kind counts as a plain match: the tofu you have is the firm tofu a recipe wants.
    same.set(term, names([...exact, ...answer?.same ?? [], ...answer?.kinds ?? []]));
    substitutes.set(term, names(answer?.substitutes));
  }
  const wanted = [...new Set(have.map((t) => t.toLowerCase()))];
  // "onion" in your pantry covers red onion too.
  const inPantry = new Set(pantry.flatMap((t) => [...same.get(t.toLowerCase())!]));

  const out: CookMatch[] = [];
  for (const recipe of recipes) {
    const used = new Map<string, string>(); // term -> how it's used
    const missing = new Set<string>();
    for (const ing of ingredients.get(keyOf(recipe))!) {
      const term = wanted.find((t) => ing.options.some((o) => same.get(t)!.has(o)));
      if (term) {
        used.set(term, term); // used as itself somewhere, so don't call it a swap
        continue;
      }
      const swap = wanted.map((t) => ({ t, o: ing.options.find((o) => substitutes.get(t)!.has(o)) })).find((s) => s.o);
      if (swap) {
        if (!used.has(swap.t)) used.set(swap.t, `${swap.t} for ${swap.o}`);
        continue;
      }
      if (!ing.staple && !ing.optional && !ing.options.some((o) => inPantry.has(o))) missing.add(ing.options.join(" or "));
    }
    if (used.size) out.push({ recipe, uses: wanted.filter((t) => used.has(t)).map((t) => used.get(t)!), missing: [...missing] });
  }
  // Stable sort, so ties stay newest first.
  return out.sort((a, b) => b.uses.length - a.uses.length || a.missing.length - b.missing.length);
}
