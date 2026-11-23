import { join } from "@std/path";
import { parse } from "yaml";
import { paths } from "./config.ts";
import { hashtag } from "./render.ts";

export interface SavedRecipe {
  file: string;
  id: string;
  title: string;
  saved: string;
  tags: string[];
  status: string;
  ingredients: string; // the "## Ingredients" section as written, sub-headings included; "" if there isn't one
}

export const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
// From "## Ingredients" up to the next "## " heading or the end of the file.
const INGREDIENTS_RE = /^## Ingredients[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
// A #tag at the start of a line or after whitespace; "# Heading" and URL #fragments don't match.
const HASHTAG_RE = /(?<=^|\s)#([\p{L}\p{N}_-]+)/gmu;

/** Tags as iA Writer sees them: #hashtags anywhere in the file, including the frontmatter tags line. */
function hashtags(text: string): string[] {
  return [...new Set([...text.matchAll(HASHTAG_RE)].map((m) => hashtag(m[1])).filter(Boolean))];
}

/** Every recipe in the Recipes folder, newest first. This folder is the record of what's been saved. */
export async function readRecipes(): Promise<SavedRecipe[]> {
  const out: SavedRecipe[] = [];
  try {
    for await (const e of Deno.readDir(paths.recipes)) {
      // Skip hidden files and iCloud placeholders not yet downloaded.
      if (!e.isFile || e.name.startsWith(".") || !e.name.endsWith(".md")) continue;
      const file = join(paths.recipes, e.name);
      const text = await Deno.readTextFile(file);
      // deno-lint-ignore no-explicit-any
      let fm: any = {};
      const match = text.match(FRONTMATTER_RE);
      try {
        fm = parse(match?.[1] ?? "") ?? {};
      } catch { /* hand-edited frontmatter that no longer parses; list it by filename */ }
      const mtime = (await Deno.stat(file)).mtime ?? new Date(0);
      out.push({
        file,
        id: String(fm.id ?? ""),
        title: String(fm.title ?? e.name.replace(/\.md$/, "")),
        saved: String(fm.saved ?? mtime.toISOString().slice(0, 10)),
        tags: hashtags(text),
        status: String(fm.status ?? ""),
        ingredients: text.match(INGREDIENTS_RE)?.[1].trim() ?? "",
      });
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  // `saved` is "YYYY-MM-DD HH:MM", so it sorts as text.
  return out.sort((a, b) => b.saved.localeCompare(a.saved) || a.title.localeCompare(b.title));
}

// After the front-matter: the "# Title" line, then your note as a "> " blockquote (where `add -m` puts it).
const HEAD_RE = /^\s*(# [^\n]*\n)?\s*((?:>[^\n]*(?:\n|$))*)\s*/;

/** A recipe file in parts: front-matter (with its fences), the "# Title" line, your note as plain text, the rest. */
export function splitRecipe(text: string) {
  const frontmatter = text.match(FRONTMATTER_RE)?.[0] ?? "";
  const head = text.slice(frontmatter.length).match(HEAD_RE)!;
  return {
    frontmatter,
    titleLine: head[1]?.trimEnd() ?? "",
    note: head[2].split("\n").map((l) => l.replace(/^>\s?/, "")).join("\n").trim(),
    body: text.slice(frontmatter.length + head[0].length),
  };
}

/** The file with your note replaced; an empty note removes it. */
export function withNote(text: string, note: string): string {
  const { frontmatter, titleLine, body } = splitRecipe(text);
  const quote = note.trim().split("\n").map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">")).join("\n");
  const out = [frontmatter, titleLine, note.trim() && quote, body].filter(Boolean).join("\n\n");
  return out.endsWith("\n") ? out : out + "\n";
}

// #favorite anywhere iA Writer would see it, matched the way HASHTAG_RE and hashtag() read it.
const FAVORITE_RE = /(^|[ \t])#favorite(?![\p{L}\p{N}_-])/gimu;

/** The file with #favorite added to its tags line, or removed from wherever it appears. */
export function withFavorite(text: string, on: boolean): string {
  const has = [...text.matchAll(FAVORITE_RE)].length > 0;
  // Taking the space before it too leaves "tags: #a #b" from "tags: #a #favorite #b", and drops a tags line left empty.
  if (!on) return has ? text.replace(FAVORITE_RE, "").replace(/^tags:[ \t]*\n/m, "") : text;
  if (has) return text;
  const fm = text.match(FRONTMATTER_RE);
  if (!fm) return `---\ntags: #favorite\n---\n\n${text}`;
  let yaml = fm[1];
  if (/^tags:/m.test(yaml)) yaml = yaml.replace(/^tags:.*$/m, (line) => `${line.trimEnd()} #favorite`);
  else if (/^status:/m.test(yaml)) yaml = yaml.replace(/^status:/m, "tags: #favorite\nstatus:");
  else yaml += "\ntags: #favorite";
  return `---\n${yaml}\n---${text.slice(fm[0].length)}`;
}

/** The saved recipe with this id, wherever it is and whatever it's called now. */
export async function findRecipe(id: string): Promise<SavedRecipe | undefined> {
  return (await readRecipes()).find((r) => r.id === id);
}
