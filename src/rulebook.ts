// The rulebook, ingredients.yaml: how `cook` decides that what you have covers what a recipe needs.
// Aliases (courgette -> zucchini), kinds (red onion -> onion) and swap groups ([butternut squash, kabocha]).
// Claude adds to it (see ingredients.ts); you edit it by hand or with `recipe-saver ingredient`.
import { join } from "@std/path";
import { type Document, isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import { paths } from "./config.ts";
import { SystemicError } from "./errors.ts";
// What you start with: general rules, bundled into the binary. Becomes your ingredients.yaml the first time it's saved,
// and yours from then on: later versions of this file never replace it.
import STARTER_RULES from "./ingredients.default.yaml" with { type: "text" };

/** A rule edit that doesn't make sense (a loop, a name that isn't there). The message is for you. */
export class RuleError extends Error {}

export const rulesFile = () => join(paths.state, "ingredients.yaml");
export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export async function writeAtomic(file: string, text: string): Promise<void> {
  await Deno.mkdir(paths.state, { recursive: true });
  await Deno.writeTextFile(`${file}.tmp`, text);
  await Deno.rename(`${file}.tmp`, file);
}

const SECTIONS = { aliases: {}, kinds: {}, swaps: [] } as const;

export async function loadRules(): Promise<Document> {
  let doc: Document;
  try {
    doc = parseDocument(await Deno.readTextFile(rulesFile()));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    doc = parseDocument(STARTER_RULES);
  }
  if (doc.errors.length) throw new SystemicError("rules", `${rulesFile()} isn't valid YAML: ${doc.errors[0].message}`);
  for (const [key, empty] of Object.entries(SECTIONS)) {
    const node = doc.get(key, true);
    if (node === undefined || (isScalar(node) && node.value === null)) doc.set(key, doc.createNode(empty));
    else if (Array.isArray(empty) ? !isSeq(node) : !isMap(node)) {
      throw new SystemicError("rules", `In ${rulesFile()}, ${key} should be a ${Array.isArray(empty) ? "list" : "map"}.`);
    }
  }
  return doc;
}

export async function saveRules(doc: Document): Promise<void> {
  for (const key of Object.keys(SECTIONS)) (doc.get(key, true) as { flow?: boolean }).flow = false;
  for (const group of (doc.get("swaps", true) as YAMLSeq).items) if (isSeq(group)) group.flow = true;
  await writeAtomic(rulesFile(), doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
}

export interface Rules {
  aliases: Map<string, string>;
  kinds: Map<string, string>;
  swaps: string[][];
}

export function rulesOf(doc: Document): Rules {
  const js = doc.toJS() ?? {};
  const pairs = (o: unknown) => new Map(Object.entries(o ?? {}).map(([k, v]) => [norm(k), norm(String(v))]));
  const swaps = Array.isArray(js.swaps) ? js.swaps.filter(Array.isArray) : [];
  return { aliases: pairs(js.aliases), kinds: pairs(js.kinds), swaps: swaps.map((g: unknown[]) => g.map((n) => norm(String(n)))) };
}

/** Every name the rules mention. */
export const ruleNames = (r: Rules) => [...r.aliases.keys(), ...r.aliases.values(), ...r.kinds.keys(), ...r.kinds.values(), ...r.swaps.flat()];

/** Answers "does having X cover a recipe's Y?" from the rules alone. */
export class Matcher {
  private known: Set<string>;
  private groups = new Map<string, Set<number>>(); // name -> the swap groups it's in

  constructor(private rules: Rules, names: Iterable<string>) {
    this.known = new Set([...names].map(norm).concat(ruleNames(rules)));
    rules.swaps.forEach((group, i) => {
      for (const n of group) {
        const c = this.canon(n);
        this.groups.set(c, (this.groups.get(c) ?? new Set()).add(i));
      }
    });
  }

  private alias(n: string): string {
    for (let i = 0; i < 5 && this.rules.aliases.has(n); i++) n = this.rules.aliases.get(n)!;
    return n;
  }

  /** The name the rules use: lowercased, aliases followed, and singular or plural when only that one is known. */
  canon(name: string): string {
    const n = this.alias(norm(name));
    if (this.known.has(n)) return n;
    const other = [`${n}s`, `${n}es`, n.replace(/e?s$/, "")].find((v) => v !== n && this.known.has(v));
    return other ? this.alias(other) : n;
  }

  isKnown = (name: string) => this.known.has(this.canon(name));

  /** Every name it knows, as the rules name them. */
  names = () => [...new Set([...this.known].map((n) => this.canon(n)))].sort();

  /** The name and what it's a kind of, and what that's a kind of, … */
  ancestors(name: string): string[] {
    const out = [name];
    for (let n = name, i = 0; i < 10; i++) {
      const parent = this.rules.kinds.get(n);
      if (!parent) break;
      n = this.canon(parent);
      if (out.includes(n)) break;
      out.push(n);
    }
    return out;
  }

  /** "same" when one is the other or a kind of it (either way round), "swap" when they share a swap group. Takes canon names. */
  relation(have: string, need: string): "same" | "swap" | null {
    const h = this.ancestors(have), n = this.ancestors(need);
    if (h.includes(need) || n.includes(have)) return "same";
    const groups = new Set(h.flatMap((x) => [...this.groups.get(x) ?? []]));
    return n.some((x) => [...this.groups.get(x) ?? []].some((g) => groups.has(g))) ? "swap" : null;
  }
}

/** Puts these names in one swap group: the existing group sharing the most of them, else a new one. Returns the group. */
export function joinSwapGroup(doc: Document, names: string[]): string[] {
  const groups = rulesOf(doc).swaps;
  let best = -1, overlap = 0;
  groups.forEach((group, i) => {
    const shared = names.filter((n) => group.includes(n)).length;
    if (shared > overlap) [best, overlap] = [i, shared];
  });
  const seq = doc.get("swaps", true) as YAMLSeq;
  if (best < 0) {
    seq.add(doc.createNode(names));
    return names;
  }
  for (const n of names) if (!groups[best].includes(n)) (seq.items[best] as YAMLSeq).add(n);
  return [...new Set([...groups[best], ...names])];
}

/** Takes a name out of every swap group, dropping groups left with one member. Returns how many groups it was in. */
export function leaveSwapGroups(doc: Document, name: string): number {
  const seq = doc.get("swaps", true) as YAMLSeq;
  let left = 0;
  for (const group of [...seq.items]) {
    if (!isSeq(group)) continue;
    const i = group.items.findIndex((item) => norm(String(isScalar(item) ? item.value : item)) === name);
    if (i < 0) continue;
    group.items.splice(i, 1);
    left++;
    if (group.items.length < 2) seq.items.splice(seq.items.indexOf(group), 1);
  }
  return left;
}

/** Removes `name` from the aliases or kinds map, matching it however it's capitalised. False if it wasn't there. */
export function deleteRule(doc: Document, section: "aliases" | "kinds", name: string): boolean {
  const map = doc.get(section, true) as YAMLMap;
  const i = map.items.findIndex((pair) => norm(String(isScalar(pair.key) ? pair.key.value : pair.key)) === name);
  if (i < 0) return false;
  map.items.splice(i, 1);
  return true;
}
