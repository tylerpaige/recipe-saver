// `recipe-saver serve`: the kitchen website. Reads the Recipes folder on every request (so iA Writer edits show up at
// once) and answers `cook` and `ingredient swap` with the same code as the CLI. Writes nothing the CLI wouldn't.
// Listens on localhost only; `tailscale serve` puts it on HTTPS for your own devices (see README).
import { basename } from "@std/path";
import { encodeBase64, decodeBase64 } from "@std/encoding";
import { marked } from "marked";
import { parse } from "yaml";
import { SystemicError, TransientError } from "./errors.ts";
import { ingredientNames, standIns, whatToCook } from "./ingredients.ts";
import { FRONTMATTER_RE, readRecipes, type SavedRecipe } from "./library.ts";
import { pantry } from "./settings.ts";
// The web app, bundled into the binary like the starter rulebook.
import INDEX_HTML from "./web/index.html" with { type: "text" };
import FRAME_HTML from "./web/frame.html" with { type: "text" };
import SHELL_JS from "./web/shell.js" with { type: "text" };
import APP_JS from "./web/app.js" with { type: "text" };
import APP_CSS from "./web/app.css" with { type: "text" };
import SW_JS from "./web/sw.js" with { type: "text" };
import MANIFEST from "./web/manifest.webmanifest" with { type: "text" };
import ICON_PNG_B64 from "./web/icon.png.b64" with { type: "text" };

export const DEFAULT_PORT = 8787;

// Changes whenever the app does, so phones drop their cached copy of the old one.
const VERSION = encodeBase64(
  await crypto.subtle.digest("SHA-1", new TextEncoder().encode(INDEX_HTML + FRAME_HTML + SHELL_JS + APP_JS + APP_CSS + SW_JS + MANIFEST + ICON_PNG_B64)),
).replace(/[^a-z0-9]/gi, "").slice(0, 10);

const STATIC: Record<string, [string, BodyInit]> = {
  "/": ["text/html; charset=utf-8", INDEX_HTML],
  "/frame": ["text/html; charset=utf-8", FRAME_HTML],
  "/shell.js": ["text/javascript; charset=utf-8", SHELL_JS],
  "/app.js": ["text/javascript; charset=utf-8", APP_JS],
  "/app.css": ["text/css; charset=utf-8", APP_CSS],
  "/sw.js": ["text/javascript; charset=utf-8", SW_JS.replace("__VERSION__", VERSION)],
  "/manifest.webmanifest": ["application/manifest+json", MANIFEST],
  "/icon.png": ["image/png", decodeBase64(ICON_PNG_B64.trim())],
};

/** A recipe as the website shows it: the front-matter fields worth reading, and the body as HTML. */
interface WebRecipe {
  key: string; // the id, or the filename for a hand-made file without one
  title: string;
  saved: string;
  tags: string[];
  status: string;
  status_reason?: string;
  servings?: string;
  prep_time?: string;
  cook_time?: string;
  source?: string;
  recipe_url?: string;
  html: string;
}

const keyOf = (r: SavedRecipe) => r.id || basename(r.file, ".md");

async function webRecipe(r: SavedRecipe): Promise<WebRecipe> {
  const text = await Deno.readTextFile(r.file);
  const match = text.match(FRONTMATTER_RE);
  // deno-lint-ignore no-explicit-any
  let fm: any = {};
  try {
    fm = parse(match?.[1] ?? "") ?? {};
  } catch { /* hand-edited front-matter that no longer parses; show the body anyway */ }
  // The page shows the title itself, so drop the body's own "# Title".
  const body = text.slice(match?.[0].length ?? 0).replace(/^\s*# [^\n]*\n/, "");
  const field = (k: string) => (fm[k] === undefined || fm[k] === null ? undefined : String(fm[k]));
  return {
    key: keyOf(r),
    title: r.title,
    saved: r.saved,
    tags: r.tags,
    status: r.status,
    status_reason: field("status_reason"),
    servings: field("servings"),
    prep_time: field("prep_time"),
    cook_time: field("cook_time"),
    source: field("source"),
    recipe_url: field("recipe_url"),
    html: await marked.parse(body),
  };
}

// cook and swap can ask Claude and save the rulebook and ingredient cache, so one at a time.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const recipeRef = (r: SavedRecipe) => ({ key: keyOf(r), title: r.title, status: r.status });

async function api(url: URL): Promise<Response> {
  const notes: string[] = [];
  const say = (msg: string) => notes.push(msg.trim());
  switch (url.pathname) {
    case "/api/library": {
      const recipes = await Promise.all((await readRecipes()).map(webRecipe));
      return json({ recipes, at: new Date().toISOString() });
    }
    case "/api/ingredients":
      return json(await oneAtATime(async () => ({ names: await ingredientNames(say), pantry: await pantry(), notes })));
    case "/api/cook": {
      const have = url.searchParams.getAll("have").map((t) => t.trim()).filter(Boolean);
      if (!have.length) return json({ error: "Name at least one ingredient." }, 400);
      const matches = await oneAtATime(async () => whatToCook(have, await pantry(), say));
      return json({
        have,
        pantry: await pantry(),
        notes,
        matches: matches.map((m) => ({ ...recipeRef(m.recipe), count: m.count, uses: m.uses, missing: m.missing })),
      });
    }
    case "/api/swap": {
      const name = url.searchParams.get("name")?.trim();
      if (!name) return json({ error: "Name an ingredient." }, 400);
      const info = await oneAtATime(() => standIns(name, say));
      return json({
        notes,
        info: { ...info, recipes: info.recipes.map(recipeRef), swapRecipes: info.swapRecipes.map(recipeRef) },
      });
    }
  }
  return json({ error: "Not found" }, 404);
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "GET") return new Response("Read-only", { status: 405 });
  if (url.pathname.startsWith("/api/")) {
    try {
      return await api(url);
    } catch (e) {
      // No API key, Claude unreachable: say so on the page, as the CLI would in the terminal.
      if (e instanceof SystemicError || e instanceof TransientError) return json({ error: e.message }, 503);
      console.error(e);
      return json({ error: "Something went wrong on the Mac. See: recipe-saver log --tail" }, 500);
    }
  }
  const file = STATIC[url.pathname];
  if (!file) return new Response("Not found", { status: 404 });
  // The service worker does the caching; the browser should always ask for these.
  return new Response(file[1], { headers: { "content-type": file[0], "cache-control": "no-cache" } });
}

export function serve(port: number) {
  // Localhost only: other devices reach it through `tailscale serve`, never the open network.
  Deno.serve({ hostname: "127.0.0.1", port, onListen: () => console.log(`Serving recipes on http://localhost:${port}`) }, handle);
}
