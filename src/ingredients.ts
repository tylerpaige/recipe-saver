// `cook`: which saved recipes use the ingredients you have. Claude does two jobs, each once: it reads a recipe's
// Ingredients section into plain names when the recipe is saved (cached in ingredients.json), and it places each name
// it hasn't met before in the rulebook, ingredients.yaml (aliases, kinds, swaps), which you can edit.
// Matching and ranking are lookups in those two files, so `cook` only asks Claude about words it's never seen.
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { join } from "@std/path";
import type { Document } from "yaml";
import { z } from "zod";
import { EFFORT, MODEL, paths } from "./config.ts";
import { TransientError } from "./errors.ts";
import { apiError, getClient } from "./extract.ts";
import { readRecipes, type SavedRecipe } from "./library.ts";
import {
  deleteRule, joinSwapGroup, leaveSwapGroups, loadRules, Matcher, norm, RuleError, ruleNames, rulesFile, rulesOf, saveRules,
  writeAtomic,
} from "./rulebook.ts";

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
- When one of the names already in use means the same ingredient, use that name exactly.

staple: true only for what nearly every kitchen has and nobody shops for: salt, black pepper, cooking oils, water, ice, sugar, plain flour, baking powder and soda, and dried herbs and spices. Not fresh herbs, butter, vinegars, sauces, or spice pastes (gochujang, harissa, curry paste).

optional: true when the recipe marks it optional, it's only for garnish or serving ("to serve", "for topping"), or it's under a sub-heading marked optional.`;

const Placements = z.object({
  names: z.array(z.object({
    name: z.string(),
    alias_of: z.string().nullable(),
    kind_of: z.string().nullable(),
    swaps_with: z.array(z.string()),
  })).describe("One entry per new name"),
});
type Placement = z.infer<typeof Placements>["names"][number];

const PLACE_SYSTEM = `You keep a rulebook for matching the ingredients someone has against the ingredients recipes call for. Place each new name in it.

alias_of: when the name is just another name or spelling for one of the known names, including misspellings and plurals: courgette -> zucchini, garbanzo beans -> chickpeas, zuchini -> zucchini. Use the known name exactly. Otherwise null.

kind_of: when it's a specific kind of a more general ingredient a recipe might call for: red onion -> onion, kabocha -> winter squash, butternut squash -> winter squash, silken tofu -> tofu, cherry tomatoes -> tomatoes, tuscan kale -> kale. Use a known general name when there is one, else the plain general name. Not related ingredients (shallots and scallions aren't kinds of onion), and not products made from it (crispy onions, pickled red onions and onion flakes aren't kinds of onion; pumpkin puree isn't a kind of pumpkin). Otherwise null.

swaps_with: known or new names it can stand in for, and that can stand in for it, without really changing the dish: the swaps a cook makes without a second thought. Any winter squash for another (kabocha, butternut, honeynut, pumpkin); one white bean for another (cannellini, butter beans, great northern); one hearty green for another (kale, cavolo nero, chard); one fresh tomato for another. Not swaps that change the dish's character (tofu for chicken, feta for parmesan, lime for lemon), and not products made from it. Usually empty.

Keep each name exactly as given.`;

// Bump when every recipe's ingredients should be read again.
const INDEX_VERSION = 1;
// Recipes read at once when building the index.
const CONCURRENCY = 6;
// New names placed per call. One call at a time, so each sees what the last one added.
const PLACE_BATCH = 60;

interface IndexFile {
  version: number;
  recipes: Record<string, { hash: string; ingredients: Ingredient[] }>; // by recipe id (file path if it has none)
  placed: string[]; // names Claude has placed in the rulebook; never asked about again, even if you delete their rules
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
    if (index.version === INDEX_VERSION) return { ...index, placed: index.placed ?? [] };
  } catch { /* missing or unreadable: rebuild */ }
  return { version: INDEX_VERSION, recipes: {}, placed: [] };
}

const saveIndex = (index: IndexFile) => writeAtomic(indexFile(), JSON.stringify(index));


/** Adds Claude's placement of one name to the rulebook, leaving anything already there alone. */
function addPlacement(doc: Document, p: Placement, known: Set<string>) {
  const rules = rulesOf(doc);
  const name = norm(p.name);
  const alias = p.alias_of && norm(p.alias_of);
  if (alias && alias !== name && known.has(alias)) {
    if (!rules.aliases.has(name) && !rules.kinds.has(name)) doc.setIn(["aliases", name], alias);
    return;
  }
  const kind = p.kind_of && norm(p.kind_of);
  if (kind && kind !== name && !rules.kinds.has(name) && !rules.aliases.has(name)) {
    // Skip anything that would make a loop (onion is a kind of red onion).
    if (!new Matcher(rules, []).ancestors(kind).includes(name)) doc.setIn(["kinds", name], kind);
  }
  const swaps = [...new Set(p.swaps_with.map(norm))].filter((n) => n !== name && known.has(n));
  if (!swaps.length) return;
  joinSwapGroup(doc, [name, ...swaps]);
}

/** Has Claude place names it hasn't placed before in the rulebook, saving as it goes. Returns its placements. */
async function place(names: string[], doc: Document, index: IndexFile): Promise<Placement[]> {
  const out: Placement[] = [];
  for (let i = 0; i < names.length; i += PLACE_BATCH) {
    const batch = names.slice(i, i + PLACE_BATCH);
    const rules = rulesOf(doc);
    const known = new Set([...recipeNames(index), ...ruleNames(rules), ...batch]);
    const { names: placed } = await ask(
      Placements,
      PLACE_SYSTEM,
      `<rulebook>\n${doc.toString()}\n</rulebook>\n\n<known_names>\n${[...known].sort().join("\n")}\n</known_names>\n\n` +
        `New names:\n${batch.join("\n")}`,
    );
    for (const p of placed) if (batch.includes(norm(p.name))) addPlacement(doc, p, known);
    out.push(...placed);
    index.placed = [...new Set([...index.placed, ...batch])];
    await saveRules(doc);
    await saveIndex(index);
  }
  return out;
}

// ---- Reading recipes ----

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

const recipeNames = (index: IndexFile) =>
  new Set(Object.values(index.recipes).flatMap((r) => r.ingredients.flatMap((i) => i.options.map(norm))));

/** Reads the ingredients of recipes that are new or changed since last time, and drops recipes that are gone. */
async function indexRecipes(recipes: SavedRecipe[], index: IndexFile, doc: Document, say: (msg: string) => void) {
  const todo: { recipe: SavedRecipe; hash: string }[] = [];
  for (const recipe of recipes) {
    const hash = await sha1(recipe.ingredients);
    if (index.recipes[keyOf(recipe)]?.hash !== hash) todo.push({ recipe, hash });
  }
  const keep = new Set(recipes.map(keyOf));
  const gone = Object.keys(index.recipes).filter((k) => !keep.has(k));
  for (const key of gone) delete index.recipes[key];
  if (!todo.length) {
    if (gone.length) await saveIndex(index);
    return;
  }
  say(`Reading the ingredients of ${todo.length} new or edited recipe${todo.length === 1 ? "" : "s"}…`);
  const inUse = [...new Set([...recipeNames(index), ...ruleNames(rulesOf(doc))])].sort().join("\n");
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(async ({ recipe, hash }) => {
      const { ingredients } = await ask(
        IndexedRecipe,
        INDEX_SYSTEM,
        `<names_in_use>\n${inUse}\n</names_in_use>\n\n<ingredients>\n${recipe.ingredients}\n</ingredients>`,
      );
      index.recipes[keyOf(recipe)] = { hash, ingredients };
    }));
    await saveIndex(index); // keep what's done if a later batch fails
  }
}

/** Brings the index and rulebook up to date with the Recipes folder. Only calls Claude for new or edited recipes. */
async function prepare(say: (msg: string) => void) {
  const index = await loadIndex();
  const doc = await loadRules();
  const recipes = cookable(await readRecipes());
  await indexRecipes(recipes, index, doc, say);
  // A name that already has a rule of its own (yours, the starter's or Claude's) needs no placing.
  const rules = rulesOf(doc);
  const placed = new Set([...index.placed, ...rules.aliases.keys(), ...rules.kinds.keys(), ...rules.swaps.flat()]);
  const unplaced = [...recipeNames(index)].filter((n) => !placed.has(n));
  if (unplaced.length) {
    say(`Adding ${unplaced.length} new ingredient name${unplaced.length === 1 ? "" : "s"} to ${rulesFile()}…`);
    await place(unplaced, doc, index);
  }
  return { index, doc, recipes };
}

const matcherFor = (doc: Document, index: IndexFile) => new Matcher(rulesOf(doc), [...recipeNames(index), ...index.placed]);

/** Reads any new or edited recipes and places their names, so `cook` doesn't have to. Run after saving. */
export async function refreshIngredients(say: (msg: string) => void): Promise<void> {
  await prepare(say);
}

/** Every ingredient name to choose from: the recipes' and the rulebook's, under the names the rules use. */
export async function ingredientNames(say: (msg: string) => void): Promise<string[]> {
  const { index, doc } = await prepare(say);
  const m = matcherFor(doc, index);
  return [...new Set([...recipeNames(index), ...ruleNames(rulesOf(doc))].map((n) => m.canon(n)))].sort();
}

/** What the rulebook now says about a name, in a line. */
function describe(p: Placement): string {
  if (p.alias_of) return `${p.name}: another name for ${p.alias_of}`;
  const parts = [p.kind_of && `a kind of ${p.kind_of}`, p.swaps_with.length && `swaps with ${p.swaps_with.join(", ")}`];
  return `${p.name}: ${parts.filter(Boolean).join("; ") || "no rules"}`;
}

export interface CookMatch {
  recipe: SavedRecipe;
  uses: string[]; // your ingredients it uses, in the order you gave them: "kale", or "kabocha for butternut squash"
  missing: string[]; // what else it needs, leaving out staples, your pantry and optional extras
}

/**
 * Saved recipes using at least one of `have`, most of them first, then fewest still missing, then newest.
 * Hides recipes you can't cook from (needs-source). Asks Claude only about names it's never seen.
 */
export async function whatToCook(have: string[], pantry: string[], say: (msg: string) => void): Promise<CookMatch[]> {
  const { index, doc, recipes } = await prepare(say);
  let m = matcherFor(doc, index);
  const unknown = [...new Set([...have, ...pantry].map(norm))].filter((t) => !m.isKnown(t));
  if (unknown.length) {
    say(`Looking up ${unknown.join(", ")} (only needed the first time)…`);
    for (const p of await place(unknown, doc, index)) say(`  ${describe(p)}`);
    m = matcherFor(doc, index);
  }

  const wanted = [...new Set(have.map((t) => m.canon(t)))];
  const stocked = pantry.map((t) => m.canon(t));
  const out: CookMatch[] = [];
  for (const recipe of recipes) {
    const used = new Map<string, string>(); // your ingredient -> how it's used
    const missing = new Set<string>();
    for (const ing of index.recipes[keyOf(recipe)]?.ingredients ?? []) {
      const needs = ing.options.map((o) => m.canon(o));
      const term = wanted.find((t) => needs.some((n) => m.relation(t, n) === "same"));
      if (term) {
        used.set(term, term); // used as itself somewhere, so don't call it a swap
        continue;
      }
      const swap = wanted.map((t) => ({ t, i: needs.findIndex((n) => m.relation(t, n) === "swap") })).find((s) => s.i >= 0);
      if (swap) {
        if (!used.has(swap.t)) used.set(swap.t, `${swap.t} for ${norm(ing.options[swap.i])}`);
        continue;
      }
      const inPantry = stocked.some((p) => needs.some((n) => m.relation(p, n) === "same"));
      if (!ing.staple && !ing.optional && !inPantry) missing.add(ing.options.join(" or "));
    }
    if (used.size) out.push({ recipe, uses: wanted.filter((t) => used.has(t)).map((t) => used.get(t)!), missing: [...missing] });
  }
  // Stable sort, so ties stay newest first.
  return out.sort((a, b) => b.uses.length - a.uses.length || a.missing.length - b.missing.length);
}

// ---- Looking things up and editing rules by hand (`recipe-saver ingredient`; never calls Claude) ----

/** The rulebook and index as they stand, without reading new recipes. */
async function current() {
  const index = await loadIndex();
  const doc = await loadRules();
  return { index, doc, m: matcherFor(doc, index) };
}

/** Saves a hand edit, and marks its names placed so Claude leaves them alone from now on. */
async function saveEdit(doc: Document, index: IndexFile, names: string[]) {
  await saveRules(doc);
  index.placed = [...new Set([...index.placed, ...names])];
  await saveIndex(index);
}

export interface IngredientInfo {
  name: string; // the name the rules use
  typed: string; // what you asked about, when it's an alias
  kindOf: string[]; // what it's a kind of, then what that's a kind of, …
  kinds: string[]; // what's a kind of it, or a kind of a kind of it, …
  aliases: string[]; // other names for it
  swaps: string[]; // what it swaps with, directly or through what it's a kind of
  recipes: SavedRecipe[]; // cookable recipes using it, or a kind of it, or what it's a kind of
  swapRecipes: SavedRecipe[]; // the others it could go in as a swap
}

/** What the rulebook says about one name, and which recipes use it. Null if neither the rules nor any recipe mention it. */
export async function ingredientInfo(typed: string): Promise<IngredientInfo | null> {
  const { index, doc, m } = await current();
  const name = m.canon(typed);
  if (!m.isKnown(name)) return null;
  const rules = rulesOf(doc);
  const uses = (r: SavedRecipe, how: "same" | "swap") =>
    (index.recipes[keyOf(r)]?.ingredients ?? []).some((i) => i.options.some((o) => m.relation(name, m.canon(o)) === how));
  const cookableRecipes = cookable(await readRecipes());
  const recipes = cookableRecipes.filter((r) => uses(r, "same"));
  return {
    name,
    typed: norm(typed),
    kindOf: m.ancestors(name).slice(1),
    kinds: m.names().filter((n) => n !== name && m.ancestors(n).includes(name)),
    aliases: [...rules.aliases.keys()].filter((a) => a !== name && m.canon(a) === name).sort(),
    swaps: m.names().filter((n) => m.relation(n, name) === "swap"),
    recipes,
    swapRecipes: cookableRecipes.filter((r) => !recipes.includes(r) && uses(r, "swap")),
  };
}

/** The whole rulebook, grouped: aliases and kinds by the name they point to. */
export async function allRules() {
  const rules = rulesOf((await current()).doc);
  const byTarget = (map: Map<string, string>) => {
    const out = new Map<string, string[]>();
    for (const [from, to] of map) out.set(to, [...out.get(to) ?? [], from]);
    return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([to, from]) => ({ to, from: from.sort() }));
  };
  return { file: rulesFile(), aliases: byTarget(rules.aliases), kinds: byTarget(rules.kinds), swaps: rules.swaps };
}

/** Makes `name` another name for `target`. Returns lines to print. */
export async function addAlias(name: string, target: string): Promise<string[]> {
  const { index, doc, m } = await current();
  const [n, t] = [norm(name), m.canon(target)];
  if (n === norm(target)) throw new RuleError("Those are the same name.");
  // Following the target's aliases leads back here: courgette -> zucchini, then zucchini -> courgette.
  if (n === t) {
    throw new RuleError(`${norm(target)} is already another name for ${n}. To turn it round: recipe-saver ingredient unalias ${norm(target)}`);
  }
  const rules = rulesOf(doc);
  const was = rules.aliases.get(n);
  deleteRule(doc, "aliases", n);
  doc.setIn(["aliases", n], t);
  const out = [`${n}: another name for ${t}${was && was !== t ? ` (was ${was})` : ""}`];
  if (rules.kinds.has(n)) out.push(`Its kind (${rules.kinds.get(n)}) no longer applies; remove it with: recipe-saver ingredient unkind ${n}`);
  if (!m.isKnown(t)) out.push(`No recipe or rule mentions ${t} yet.`);
  await saveEdit(doc, index, [n]);
  return out;
}

/** Makes `name` a kind of `parent`. Returns lines to print. */
export async function addKind(name: string, parent: string): Promise<string[]> {
  const { index, doc, m } = await current();
  const [n, p] = [m.canon(name), m.canon(parent)];
  if (n === p) throw new RuleError(`${n} can't be a kind of itself.`);
  if (m.ancestors(p).includes(n)) throw new RuleError(`${p} is already a kind of ${n}, so that would go round in a circle.`);
  const was = rulesOf(doc).kinds.get(n);
  deleteRule(doc, "kinds", n);
  doc.setIn(["kinds", n], p);
  const out = [`${n}: a kind of ${p}${was && was !== p ? ` (was ${was})` : ""}`];
  if (!m.isKnown(p)) out.push(`No recipe or rule mentions ${p} yet.`);
  await saveEdit(doc, index, [n]);
  return out;
}

/** Puts these names in one swap group. Returns lines to print. */
export async function addSwaps(names: string[]): Promise<string[]> {
  const { index, doc, m } = await current();
  const members = [...new Set(names.map((n) => m.canon(n)))];
  if (members.length < 2) throw new RuleError("Name at least two different ingredients to swap.");
  const group = joinSwapGroup(doc, members);
  await saveEdit(doc, index, members);
  const unknown = members.filter((n) => !m.isKnown(n));
  return [`Swaps: ${group.join(" · ")}`, ...unknown.length ? [`No recipe or rule mentions ${unknown.join(", ")} yet.`] : []];
}

/** Removes one of `name`'s rules: its alias, its kind, or its place in swap groups. Returns lines to print. */
export async function removeRule(rule: "alias" | "kind" | "swap", name: string): Promise<string[]> {
  const { index, doc, m } = await current();
  const n = norm(name);
  let done: string;
  if (rule === "alias") {
    const was = rulesOf(doc).aliases.get(n);
    if (!deleteRule(doc, "aliases", n)) throw new RuleError(`${n} isn't an alias.`);
    done = `${n}: no longer another name for ${was}`;
  } else if (rule === "kind") {
    const c = m.canon(n);
    const was = rulesOf(doc).kinds.get(c);
    if (!deleteRule(doc, "kinds", c)) throw new RuleError(`${c} isn't a kind of anything.`);
    done = `${c}: no longer a kind of ${was}`;
  } else {
    const c = m.canon(n);
    const left = leaveSwapGroups(doc, c);
    if (!left) throw new RuleError(`${c} isn't in a swap group.`);
    done = `${c}: no longer swaps with anything`;
  }
  await saveEdit(doc, index, [n]);
  return [done];
}
