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
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
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
      });
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  // `saved` is "YYYY-MM-DD HH:MM", so it sorts as text.
  return out.sort((a, b) => b.saved.localeCompare(a.saved) || a.title.localeCompare(b.title));
}

/** The saved recipe with this id, wherever it is and whatever it's called now. */
export async function findRecipe(id: string): Promise<SavedRecipe | undefined> {
  return (await readRecipes()).find((r) => r.id === id);
}
