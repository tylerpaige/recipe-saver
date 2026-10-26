import { join } from "@std/path";
import { Document, isSeq } from "yaml";
import type { Recipe } from "./extract.ts";

export type Source = "caption" | "recipe-page" | "transcript" | "frames";

export interface RenderInput {
  recipe: Recipe;
  id: string;
  url: string;
  creator: string | null;
  recipeUrl?: string;
  extractedFrom: Source[];
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function renderMarkdown(r: RenderInput): string {
  const { recipe } = r;
  const title = recipe.title ?? (r.creator ? `Recipe from ${r.creator}` : `Recipe ${r.id}`);

  // Field order matches SPEC.md; missing fields are omitted, never guessed.
  const fm: Record<string, unknown> = {
    title,
    creator: r.creator ?? undefined,
    source: r.url,
    recipe_url: r.recipeUrl,
    reel_id: r.id,
    saved: today(),
    servings: recipe.servings ?? undefined,
    prep_time: recipe.prep_time ?? undefined,
    cook_time: recipe.cook_time ?? undefined,
    total_time: recipe.total_time ?? undefined,
    tags: recipe.tags.length ? recipe.tags : undefined,
    status: recipe.status,
    status_reason: recipe.status === "complete" ? undefined : recipe.reason ?? undefined,
    extracted_from: r.extractedFrom,
  };
  for (const k of Object.keys(fm)) if (fm[k] === undefined) delete fm[k];
  const doc = new Document(fm);
  // Short lists on one line, like the spec: tags: [a, b]
  for (const key of ["tags", "extracted_from"]) {
    const node = doc.get(key, true);
    if (isSeq(node)) node.flow = true;
  }
  const yaml = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });

  const out: string[] = [`---\n${yaml}---`, "", `# ${title}`, ""];
  const by = r.creator ? `From ${r.creator} · ` : "";
  const label = r.id.startsWith("url-") ? "Original recipe" : "Original post";
  out.push(`*${by}[${label}](${r.url})*`, "");

  if (recipe.ingredients.length) {
    out.push("## Ingredients", "");
    let group: string | null = null;
    for (const ing of recipe.ingredients) {
      if (ing.group && ing.group !== group) {
        group = ing.group;
        out.push("", `### ${group}`, "");
      }
      out.push(`- ${ing.text}`);
    }
    out.push("");
  }
  if (recipe.steps.length) {
    out.push("## Steps", "");
    recipe.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
    out.push("");
  }
  if (recipe.notes.length) {
    out.push("## Notes", "");
    for (const n of recipe.notes) out.push(`- ${n}`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function slugify(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "recipe";
}

/** Writes the recipe without ever overwriting an existing file. Returns the path. */
export async function writeRecipe(dir: string, title: string, markdown: string): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  const base = slugify(title);
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? `${base}.md` : `${base}-${n}.md`);
    try {
      await Deno.writeTextFile(path, markdown, { createNew: true });
      return path;
    } catch (e) {
      if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    }
  }
}
