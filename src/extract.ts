import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { encodeBase64 } from "@std/encoding/base64";
import { bin, KEYCHAIN_SERVICE, MODEL } from "./config.ts";
import { SystemicError, TransientError } from "./errors.ts";

const Ingredient = z.object({
  group: z.string().nullable().describe('Sub-heading such as "For the sauce", or null'),
  text: z.string().describe("The ingredient line as it should be displayed, conversions applied"),
  quantity: z.string().nullable(),
  unit: z.string().nullable(),
  item: z.string(),
  prep: z.string().nullable(),
});

export const Recipe = z.object({
  is_recipe: z.boolean(),
  title: z.string().nullable(),
  servings: z.string().nullable(),
  prep_time: z.string().nullable(),
  cook_time: z.string().nullable(),
  total_time: z.string().nullable(),
  ingredients: z.array(Ingredient),
  steps: z.array(z.string()),
  notes: z.array(z.string()),
  tags: z.array(z.string()),
  linked_urls: z.array(z.string()).describe("Recipe/blog URLs mentioned in the source text"),
  status: z.enum(["complete", "partial", "needs-source"]),
  missing: z.array(z.string()),
  reason: z.string().nullable().describe("One line explaining a non-complete status"),
});
export type Recipe = z.infer<typeof Recipe>;

const SYSTEM = `You turn social-media recipe posts into clean, cookable recipes.

Use only what the source says. Never invent ingredients, quantities, times, or steps. Leave a field null (or a list empty) when the source doesn't give it.

is_recipe: true whenever the post shows a dish being made, even if the recipe itself lives elsewhere ("recipe on my blog", "comment RECIPE"). false only when the post isn't about cooking a dish at all (a restaurant review, a meme, a product ad). Even when the recipe text is absent, still fill in the title from the dish name.

Ingredients:
- Keep quantities exactly as the creator wrote them.
- Add a conversion in parentheses to the other measurement system (metric <-> US customary) only when the amount is a specific standard unit: "200 g (7 oz) flour", "1 cup (240 ml) stock", "400°F (200°C)".
- Every cup, fluid ounce, ml, liter, gram, kilogram, ounce, and pound amount gets a conversion. Teaspoon and tablespoon amounts never get a conversion, however they are spelled ("tsp", "tablespoons", "Tbsp"); they're the same in both systems.
- Same-dimension conversions (weight to weight, volume to volume, temperature, length) should be accurate and sensibly rounded.
- Weight <-> volume only for common pantry staples (flour, sugar, rice, butter...) and prefix it with "~": "200 g (~1⅔ cups) flour". Otherwise don't cross dimensions.
- Never convert casual amounts ("a glug", "a handful", "a pinch", "to taste") or container/package units ("1 can", "1 packet", "2 cloves", "1 bunch"). Leave those exactly as written.
- text is the final display line, with the conversion inline after the quantity.

Steps: imperative, one action-group per step, no numbering in the text. Keep oven temperatures and times with conversions as above.

Notes: only genuine tips from the creator that a cook would want: storage, substitutions, make-ahead, why a step matters. Never restate the title, tags, times, or diet ("plant-based recipe", "takes 20 minutes", "great for meal prep"). Drop promotion ("link in bio", "follow for more", "comment RECIPE"). An empty list is fine.

Tags: 3-6 lowercase kebab-case tags covering cuisine, course, main ingredient, and diet where clear (e.g. "korean", "main", "tofu", "vegetarian", "weeknight").

Status:
- complete: ingredients with quantities and steps are all present. Missing servings or times do NOT make a recipe partial.
- partial: cookable, but part of the recipe itself is missing (some ingredient quantities, a step, a component).
- needs-source: not cookable from this text (e.g. ingredients without amounts and no method, or "recipe in bio/comment").
List what's missing in missing, and summarize it in reason.

linked_urls: any URL in the source that likely leads to the full recipe.`;

let client: Anthropic | null = null;

async function apiKey(): Promise<string> {
  const env = Deno.env.get("ANTHROPIC_API_KEY");
  if (env) return env;
  const out = await new Deno.Command(bin.security, {
    args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const key = new TextDecoder().decode(out.stdout).trim();
  if (!out.success || !key) {
    throw new SystemicError(
      "api-key",
      `No Anthropic API key in Keychain (service "${KEYCHAIN_SERVICE}").`,
    );
  }
  return key;
}

export interface Signals {
  creator: string | null;
  caption: string;
  page?: { url: string; text: string };
  transcript?: string;
  frames?: Uint8Array[]; // JPEGs: video frames or carousel slides
}

async function getClient(): Promise<Anthropic> {
  client ??= new Anthropic({ apiKey: await apiKey() });
  return client;
}

function apiError(error: unknown): unknown {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new SystemicError("api-key", "The Anthropic API key was rejected.");
  }
  if (error instanceof Anthropic.BadRequestError) {
    // Usually billing ("credit balance too low") or a code bug; either way you need to look.
    return new SystemicError("api", `Anthropic API rejected the request: ${error.message}`);
  }
  if (error instanceof Anthropic.APIError) {
    return new TransientError(error.message); // 429 / 5xx / connection, after SDK retries
  }
  return error;
}

/** One extraction call over every signal gathered so far. */
export async function extract(s: Signals): Promise<Recipe> {
  const parts = [`Creator: ${s.creator ?? "unknown"}`, `<caption>\n${s.caption || "(no caption)"}\n</caption>`];
  if (s.page) {
    parts.push(`<recipe_page url="${s.page.url}">\n${s.page.text}\n</recipe_page>`);
  }
  if (s.transcript) parts.push(`<audio_transcript>\n${s.transcript}\n</audio_transcript>`);
  if (s.frames?.length) {
    parts.push("The images above are frames from the video (or carousel slides). Use any on-screen recipe text in them.");
  }
  parts.push(
    "Combine all sources. Prefer the recipe page for exact quantities when it matches the dish; use the caption, transcript, and images to fill gaps.",
  );

  const content: Anthropic.ContentBlockParam[] = [
    ...(s.frames ?? []).map((f) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/jpeg" as const, data: encodeBase64(f) },
    })),
    { type: "text", text: parts.join("\n\n") },
  ];

  try {
    const response = await (await getClient()).messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(Recipe) },
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      throw new TransientError(`Extraction returned no result (stop_reason: ${response.stop_reason})`);
    }
    return response.parsed_output;
  } catch (error) {
    throw apiError(error);
  }
}

/** Tier 2 fallback: ask Claude to web-search for the creator's recipe page. */
export async function searchRecipeUrl(creator: string | null, title: string, caption: string): Promise<string | null> {
  try {
    const response = await (await getClient()).messages.create({
      model: MODEL,
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{
        role: "user",
        content: `Find the web page with the full written recipe for "${title}" by the Instagram creator ${creator ?? "(unknown)"}. ` +
          `It's usually on their blog, Substack, or website. Their caption for context:\n<caption>\n${caption}\n</caption>\n\n` +
          `Only accept a page that is clearly this creator's recipe for this dish. ` +
          `End your answer with a final line "URL: <url>", or "URL: none" if you can't find it.`,
      }],
    });
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const url = text.match(/URL:\s*(https?:\/\/\S+)/)?.[1];
    return url ? url.replace(/[).,>\]]+$/, "") : null;
  } catch (error) {
    throw apiError(error);
  }
}
