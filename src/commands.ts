// The CLI commands other than `run` and `preview`. All read-only except `add`, `clean`, `config set` and `config unset`.
import { join } from "@std/path";
import { bin, EDITOR_APP, limits, paths } from "./config.ts";
import { SystemicError, TransientError } from "./errors.ts";
import { itemId } from "./ids.ts";
import { type AddOptions, enqueue, inboxItems, pendingDownloads, URL_RE } from "./inbox.ts";
import {
  addAlias, addKind, addSwaps, allRules, type CookMatch, ingredientInfo, ingredientNames, removeRule, whatToCook,
} from "./ingredients.ts";
import { findRecipe, readRecipes, type SavedRecipe } from "./library.ts";
import { RuleError } from "./rulebook.ts";
import { hashtag } from "./render.ts";
import { mask, pantry, settings } from "./settings.ts";
import { loadState, logFile, runInProgress } from "./state.ts";

export async function add(url: string, opts: AddOptions) {
  const id = await itemId(url);
  await enqueue(url, id, opts);
  const tags = opts.tags.map((t) => `#${hashtag(t)}`).join(" ");
  const tagging = opts.autoTag ? (tags ? `, tagged ${tags} plus Claude's tags` : "") : tags ? `, tagged ${tags} only` : ", without tags";
  console.log(`Queued ${id}${tagging}${opts.message ? ", with your note" : ""}`);
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
    if (item.message) notes.push("with a note");
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

/** Runs `gum filter` over `lines`. The chosen lines, or undefined if you cancel. */
async function gumFilter(lines: string[], args: string[]): Promise<string[] | undefined> {
  const child = new Deno.Command(bin.gum, { args: ["filter", ...args], stdin: "piped", stdout: "piped", stderr: "inherit" }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(lines.join("\n")));
  await writer.close();
  const { success, stdout } = await child.output();
  if (!success) return; // Esc / Ctrl-C
  return new TextDecoder().decode(stdout).split("\n").filter(Boolean);
}

/** Lets you pick a recipe with `gum filter`, one row per recipe. Undefined if you cancel. */
async function pick(recipes: SavedRecipe[], lines: string[], header: string): Promise<SavedRecipe | undefined> {
  const plain = lines.map((l) => l.replace(ANSI_RE, ""));
  const chosen = await gumFilter(lines, ["--no-strip-ansi", "--header", header, "--placeholder", "Type to filter by title, tag or date…"]);
  return chosen && recipes[plain.indexOf(chosen[0].replace(ANSI_RE, ""))];
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
    const chosen = await pick(recipes, pickerRows(recipes), `${recipes.length} ${noun}${wanted.length ? ` tagged ${tagged}` : ""}`);
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

/** "2/3": how many of your ingredients a recipe uses. */
const score = (m: CookMatch, of: number) => `${m.uses.length}/${of}`;
const cookDetails = (m: CookMatch) =>
  [m.uses.join(", "), m.missing.length ? `needs ${m.missing.join(", ")}` : "needs nothing else"].join(" · ");

/** One picker row: score, title, then what it uses and needs, dimmed and cut to fit the terminal. */
function cookRows(matches: CookMatch[], of: number): string[] {
  const titles = matches.map(({ recipe: r }) => {
    const t = r.title + flagFor(r);
    return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1) + "…" : t;
  });
  const titleWidth = Math.max(...titles.map((t) => t.length));
  const scoreWidth = `${of}/${of}`.length;
  const room = Deno.consoleSize().columns - 2 - scoreWidth - 2 - titleWidth - 2;
  return matches.map((m, i) => {
    const details = cookDetails(m);
    const shown = details.length > room ? details.slice(0, Math.max(room - 1, 0)) + "…" : details;
    return `${score(m, of).padStart(scoreWidth)}  ${titles[i].padEnd(titleWidth)}  \x1b[2m${shown}\x1b[0m`;
  });
}

/**
 * Saved recipes that use the ingredients you have, those using the most first. With none given, you pick them from a list.
 * In a terminal, a `gum filter` picker that opens the chosen recipe; otherwise (or with `plain`) the whole list.
 */
export async function cook(have: string[], plain = false) {
  const say = (msg: string) => console.error(msg);
  const tty = !plain && await interactive();
  let matches: CookMatch[];
  try {
    if (!have.length) {
      if (!tty) {
        console.error("Name the ingredients you have: recipe-saver cook kabocha, kale, chickpeas");
        Deno.exit(2);
      }
      const header = "What do you have? Tab to choose each one, Enter when done";
      have = await gumFilter(await ingredientNames(say), ["--no-limit", "--header", header, "--placeholder", "Type to filter…"]) ?? [];
      if (!have.length) return;
    }
    matches = await whatToCook(have, await pantry(), say);
  } catch (e) {
    if (!(e instanceof SystemicError || e instanceof TransientError)) throw e;
    console.error(e.message);
    Deno.exit(1);
  }
  const asked = have.join(", ");
  if (!matches.length) {
    console.log(`No saved recipes use ${asked}.`);
    return;
  }
  const noun = matches.length === 1 ? "recipe uses" : "recipes use";
  if (tty) {
    const chosen = await pick(matches.map((m) => m.recipe), cookRows(matches, have.length), `${matches.length} ${noun} ${asked}`);
    if (chosen) await openFile(chosen.file);
    return;
  }
  console.log(`${matches.length} ${noun} ${asked}:`);
  for (const m of matches) {
    console.log(`\n${score(m, have.length)}  ${m.recipe.title}${flagFor(m.recipe)}`);
    console.log(dim(`      ${cookDetails(m)}`));
  }
}

/** Ingredient names from the command line: split on commas if there are any, else one per argument. */
export const splitNames = (args: string[]) =>
  (args.some((a) => a.includes(",")) ? args.join(" ").split(",") : args).map((t) => t.trim()).filter(Boolean);

const INGREDIENT_USAGE = `usage: recipe-saver ingredient [name]           the rulebook, or what it says about one ingredient
       recipe-saver ingredient alias <name>, <name it's another name for>
       recipe-saver ingredient kind <name>, <what it's a kind of>
       recipe-saver ingredient swap <name>               what can stand in for it
       recipe-saver ingredient swap <name>, <name>, ...
       recipe-saver ingredient unalias|unkind|unswap <name>`;

/**
 * `recipe-saver ingredient`: shows the rulebook, or one ingredient's rules and recipes, or changes a rule.
 * Names with spaces need commas between them (kind red onion, onion) or quotes.
 */
export async function ingredient(args: string[]) {
  const [verb, ...rest] = args;
  const one = rest.join(" ").trim();
  const two = splitNames(rest);
  const fail = (): never => {
    console.error(INGREDIENT_USAGE);
    Deno.exit(2);
  };
  try {
    let lines: string[];
    if (!args.length) return await showRules();
    else if (verb === "alias") lines = two.length === 2 ? await addAlias(two[0], two[1]) : fail();
    else if (verb === "kind") lines = two.length === 2 ? await addKind(two[0], two[1]) : fail();
    else if (verb === "swap" && two.length === 1) return await showSwaps(two[0]);
    else if (verb === "swap") lines = two.length >= 2 ? await addSwaps(two) : fail();
    else if (verb === "unalias" || verb === "unkind" || verb === "unswap") {
      lines = one ? await removeRule(verb.slice(2) as "alias" | "kind" | "swap", one) : fail();
    } else return await showIngredient(args.join(" "));
    for (const l of lines) console.log(l);
  } catch (e) {
    if (!(e instanceof RuleError || e instanceof SystemicError)) throw e;
    console.error(e.message);
    Deno.exit(1);
  }
}

async function showIngredient(name: string) {
  const info = await ingredientInfo(name);
  if (!info) {
    console.error(`Neither the rulebook nor any recipe mentions ${name}. (recipe-saver cook ${name} would look it up.)`);
    Deno.exit(1);
  }
  if (info.typed !== info.name) console.log(dim(`${info.typed} is another name for ${info.name}`));
  console.log(info.name);
  const rows: [string, string[]][] = [
    ["also called", info.aliases],
    ["a kind of", info.kindOf.length ? [info.kindOf.join(", a kind of ")] : []],
    ["kinds of it", info.kinds],
    ["swaps with", info.swaps],
  ];
  for (const [label, values] of rows) if (values.length) console.log(`  ${label.padEnd(12)} ${values.join(", ")}`);
  for (const [label, recipes] of [["recipes", info.recipes], ["as a swap", info.swapRecipes]] as const) {
    if (!recipes.length && label === "as a swap") continue;
    console.log(`  ${label.padEnd(12)} ${recipes.length || "none"}`);
    for (const r of recipes) console.log(dim(`    ${r.title}`));
  }
}

/** What you can use instead of one ingredient. */
async function showSwaps(name: string) {
  const info = await ingredientInfo(name);
  if (!info) {
    console.error(`Neither the rulebook nor any recipe mentions ${name}.`);
    Deno.exit(1);
  }
  if (!info.swaps.length && !info.kinds.length && !info.kindOf.length) {
    console.log(`Nothing in the rulebook stands in for ${info.name}. Add some: recipe-saver ingredient swap ${info.name}, <name>`);
    return;
  }
  console.log(`Instead of ${info.name}, you can use:`);
  if (info.swaps.length) console.log(`  ${"swaps".padEnd(13)} ${info.swaps.join(", ")}`);
  if (info.kinds.length) console.log(`  ${"kinds of it".padEnd(13)} ${info.kinds.join(", ")}`);
  if (info.kindOf.length) console.log(`  ${"more general".padEnd(13)} ${info.kindOf.join(", ")}`);
}

async function showRules() {
  const { file, aliases, kinds, swaps } = await allRules();
  const grouped = (title: string, rows: { to: string; from: string[] }[], arrow: string) => {
    console.log(`\n${title} (${rows.reduce((n, r) => n + r.from.length, 0)})`);
    const width = Math.min(Math.max(0, ...rows.map((r) => r.to.length)), 24);
    for (const r of rows) console.log(`  ${r.to.padEnd(width)}  ${dim(arrow)} ${r.from.join(", ")}`);
  };
  console.log(dim(file));
  grouped("Aliases: other names", aliases, "←");
  grouped("Kinds", kinds, "⊃");
  console.log(`\nSwaps (${swaps.length} groups)`);
  for (const g of swaps) console.log(`  ${g.join(" · ")}`);
  console.log(dim(`\nOne ingredient: recipe-saver ingredient <name>. Change a rule: recipe-saver ingredient alias|kind|swap …`));
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

/** Prints every setting, secrets masked. */
export async function showConfig() {
  const width = Math.max(...Object.keys(settings).map((k) => k.length));
  for (const [key, setting] of Object.entries(settings)) {
    const current = await setting.get();
    const shown = current ? `${setting.secret ? mask(current.value) : current.value}  ${dim(`(${current.source})`)}` : dim("not set");
    console.log(`${key.padEnd(width)}  ${shown}`);
  }
}

/** Prints the settings `config set` accepts, with what each is for. */
export function listConfig() {
  const width = Math.max(...Object.keys(settings).map((k) => k.length));
  for (const [key, setting] of Object.entries(settings)) console.log(`${key.padEnd(width)}  ${setting.description}`);
}

/** Sets one setting. Without a value, asks for it (hidden for secrets) or reads it from stdin when piped. */
export async function setConfig(key: string, value?: string) {
  const setting = findSetting(key);
  value ??= Deno.stdin.isTerminal() ? await ask(`${setting.description}:`, setting.secret) : await new Response(Deno.stdin.readable).text();
  value = value.trim();
  if (!value) {
    console.error("Nothing entered; unchanged.");
    Deno.exit(1);
  }
  try {
    const warning = await setting.set(value);
    if (warning) console.error(warning);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    Deno.exit(1);
  }
  console.log(`Saved ${key}${setting.secret ? ` (${mask(value)})` : ` = ${value}`}`);
}

/** Prints one setting's value, and nothing (exit 1) if it's unset. Secrets are masked unless `reveal`. */
export async function getConfig(key: string, reveal: boolean) {
  const setting = findSetting(key);
  const current = await setting.get();
  if (!current) {
    console.error(`${key} is not set.`);
    Deno.exit(1);
  }
  console.log(setting.secret && !reveal ? mask(current.value) : current.value);
}

/** Removes one setting's stored value. */
export async function unsetConfig(key: string) {
  const setting = findSetting(key);
  console.log(await setting.unset() ? `Removed ${key}` : `${key} wasn't set.`);
  const current = await setting.get();
  if (current?.source === "default") console.log(`Back to the default: ${current.value}`);
  else if (current) console.error(`It's still set by ${current.source}.`);
}

function findSetting(key: string) {
  const setting = settings[key];
  if (!setting) {
    console.error(`Unknown setting "${key}". See: recipe-saver config list`);
    Deno.exit(2);
  }
  return setting;
}

async function ask(message: string, hidden: boolean): Promise<string> {
  const stty = (arg: string) => new Deno.Command("/bin/stty", { args: [arg], stdin: "inherit" }).output();
  if (hidden) await stty("-echo");
  try {
    return prompt(message) ?? "";
  } finally {
    if (hidden) {
      await stty("echo");
      console.log();
    }
  }
}
