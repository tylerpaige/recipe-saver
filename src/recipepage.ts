// Tier 2: recipe pages. Most recipe sites embed schema.org Recipe JSON-LD for
// Google; when they don't (Substack, small blogs) we fall back to page text.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAX_TEXT = 60_000;

// Link-in-bio and social pages never hold the recipe themselves.
const SKIP_HOSTS = /(^|\.)(instagram\.com|facebook\.com|tiktok\.com|youtube\.com|youtu\.be|linktr\.ee|beacons\.ai|stan\.store|amzn\.to|amazon\.com|ltk\.app|liketoknow\.it|manychat\.com)$/i;

export function candidateUrls(text: string, extra: string[] = []): string[] {
  const found = [...extra, ...(text.match(/https?:\/\/[^\s)"'<>]+/g) ?? [])];
  const out = new Set<string>();
  for (const raw of found) {
    try {
      const u = new URL(raw.replace(/[.,!?]+$/, ""));
      if (!SKIP_HOSTS.test(u.hostname)) out.add(u.toString());
    } catch { /* not a URL */ }
  }
  return [...out];
}

// deno-lint-ignore no-explicit-any
type Json = any;

function findRecipe(node: Json): Json | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n);
      if (r) return r;
    }
    return null;
  }
  const type = node["@type"];
  if (type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"))) return node;
  return findRecipe(node["@graph"]) ?? findRecipe(node.mainEntity);
}

function instructionLines(node: Json): string[] {
  if (!node) return [];
  if (typeof node === "string") return [stripTags(node)];
  if (Array.isArray(node)) return node.flatMap(instructionLines);
  if (node["@type"] === "HowToSection") {
    return [`[${node.name ?? "Section"}]`, ...instructionLines(node.itemListElement)];
  }
  return node.text ? [stripTags(String(node.text))] : [];
}

function recipeToText(r: Json): string {
  const lines = [`Name: ${r.name ?? ""}`];
  const yieldVal = Array.isArray(r.recipeYield) ? r.recipeYield.join(", ") : r.recipeYield;
  if (yieldVal) lines.push(`Yield: ${yieldVal}`);
  for (const k of ["prepTime", "cookTime", "totalTime"]) if (r[k]) lines.push(`${k}: ${r[k]}`);
  lines.push("Ingredients:", ...(r.recipeIngredient ?? []).map((i: string) => `- ${stripTags(i)}`));
  lines.push("Instructions:", ...instructionLines(r.recipeInstructions).map((s, i) => `${i + 1}. ${s}`));
  return lines.join("\n");
}

function decodeEntities(s: string): string {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function pageText(html: string): string {
  const body = html
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return decodeEntities(body.replace(/<[^>]+>/g, " "))
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")
    .slice(0, MAX_TEXT);
}

/**
 * Fetches a page and returns recipe text: structured JSON-LD when present,
 * otherwise the readable page text. Null when unreachable or empty.
 */
export async function fetchRecipePage(url: string): Promise<{ url: string; text: string; structured: boolean } | null> {
  let html: string;
  let finalUrl = url;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, "accept": "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    finalUrl = res.url || url;
    if (SKIP_HOSTS.test(new URL(finalUrl).hostname)) return null;
    html = await res.text();
  } catch {
    return null;
  }

  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const recipe = findRecipe(JSON.parse(m[1].trim()));
      if (recipe?.recipeIngredient?.length) {
        return { url: finalUrl, text: recipeToText(recipe), structured: true };
      }
    } catch { /* malformed JSON-LD; keep looking */ }
  }
  const text = pageText(html);
  return text.length > 200 ? { url: finalUrl, text, structured: false } : null;
}
