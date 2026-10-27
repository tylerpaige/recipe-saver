// The queue: one text file per shared URL in iCloud Drive/Shortcuts/recipe-inbox.
import { join } from "@std/path";
import { paths } from "./config.ts";
import { log } from "./state.ts";

export const URL_RE = /https?:\/\/\S+/;

export interface InboxItem {
  path: string;
  url: string;
  mtime: number;
}

/** Inbox files in processing order, oldest first. With `prune`, files without a URL are deleted. */
export async function inboxItems({ prune = true } = {}): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  try {
    for await (const e of Deno.readDir(paths.inbox)) {
      // Skip hidden files and iCloud placeholders (".name.icloud") not yet downloaded.
      if (!e.isFile || e.name.startsWith(".") || e.name.endsWith(".icloud")) continue;
      const path = join(paths.inbox, e.name);
      const url = (await Deno.readTextFile(path)).match(URL_RE)?.[0];
      const mtime = (await Deno.stat(path)).mtime?.getTime() ?? 0;
      if (url) items.push({ path, url, mtime });
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

/** Queues a URL the same way the Shortcut does. */
export async function enqueue(url: string, name: string): Promise<void> {
  await Deno.mkdir(paths.inbox, { recursive: true });
  await Deno.writeTextFile(join(paths.inbox, `${name}.txt`), url + "\n");
}
