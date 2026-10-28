// The queue: one text file per shared URL in iCloud Drive/Shortcuts/recipe-inbox.
import { join } from "@std/path";
import { paths } from "./config.ts";
import { log } from "./state.ts";

export const URL_RE = /https?:\/\/\S+/;

/** Set by `recipe-saver add`; the Shortcut's files have neither, so Claude's tags are used alone. */
export interface TagOptions {
  tags: string[]; // added to the recipe as well as (or, without autoTag, instead of) Claude's
  autoTag: boolean;
}

export interface InboxItem extends TagOptions {
  path: string;
  url: string;
  mtime: number;
}

/** The URL, then optional "tags: a, b" and "auto-tag: false" lines. */
function parseItem(text: string): (TagOptions & { url: string }) | undefined {
  const url = text.match(URL_RE)?.[0];
  if (!url) return;
  const tags = text.match(/^tags:(.*)$/m)?.[1].split(",").map((t) => t.trim()).filter(Boolean) ?? [];
  const autoTag = text.match(/^auto-tag:\s*(\S+)/m)?.[1] !== "false";
  return { url, tags, autoTag };
}

/** Inbox files in processing order, oldest first. With `prune`, files without a URL are deleted. */
export async function inboxItems({ prune = true } = {}): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  try {
    for await (const e of Deno.readDir(paths.inbox)) {
      // Skip hidden files and iCloud placeholders (".name.icloud") not yet downloaded.
      if (!e.isFile || e.name.startsWith(".") || e.name.endsWith(".icloud")) continue;
      const path = join(paths.inbox, e.name);
      const item = parseItem(await Deno.readTextFile(path));
      const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
      if (item) items.push({ path, mtime, ...item });
      else if (prune) {
        await log(`${e.name}: no URL inside, removing`);
        await Deno.remove(path);
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return items.sort((a, b) => a.mtime - b.mtime);
}

/** iCloud placeholders in the inbox: shared from the phone but not yet downloaded to this Mac. */
export async function pendingDownloads(): Promise<number> {
  let n = 0;
  try {
    for await (const e of Deno.readDir(paths.inbox)) {
      if (e.isFile && e.name.startsWith(".") && e.name.endsWith(".icloud")) n++;
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return n;
}

/** Queues a URL the same way the Shortcut does, plus any tag options. */
export async function enqueue(url: string, name: string, opts: TagOptions = { tags: [], autoTag: true }): Promise<void> {
  const lines = [url];
  if (opts.tags.length) lines.push(`tags: ${opts.tags.join(", ")}`);
  if (!opts.autoTag) lines.push("auto-tag: false");
  await Deno.mkdir(paths.inbox, { recursive: true });
  await Deno.writeTextFile(join(paths.inbox, `${name}.txt`), lines.join("\n") + "\n");
}
