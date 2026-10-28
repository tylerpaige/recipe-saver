import { limits } from "./config.ts";
import { add, clean, list, open, queue, showLog, status } from "./commands.ts";
import { preview, run } from "./run.ts";

// Flags whose value can follow as the next argument, whatever it looks like (others only take a number there).
const VALUED = new Set(["tag", "auto-tag"]);

/** Splits args into positionals and `--name value` / `--name=value` / bare `--name` flags. */
function parseArgs(args: string[]): { rest: string[]; flags: Record<string, string | true> } {
  const rest: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) rest.push(args[i]);
    else if (m[2] !== undefined) flags[m[1]] = m[2];
    else if (/^\d+$/.test(args[i + 1] ?? "") || (VALUED.has(m[1]) && i + 1 < args.length)) flags[m[1]] = args[++i];
    else flags[m[1]] = true;
  }
  return { rest, flags };
}

/** `--auto-tag`, `--auto-tag=true` or `--auto-tag=false`; null for anything else. */
function bool(v: string | true | undefined, fallback: boolean): boolean | null {
  if (v === undefined) return fallback;
  if (v === true || v === "true") return true;
  return v === "false" ? false : null;
}

function positiveInt(v: string | true | undefined, fallback: number): number | null {
  if (v === undefined || v === true) return fallback;
  return /^[1-9]\d*$/.test(v) ? Number(v) : null;
}

const [cmd = "run", arg] = Deno.args;
const { rest, flags } = parseArgs(Deno.args.slice(1));
const usage = `usage: recipe-saver <command>
  run                          drain the queue now
  queue                        show what's queued
  list [tag ...]               pick a saved recipe to open (newest first)
  list [tag ...] --plain [--page N]
                               print saved recipes, ${limits.recipesPerPage} per page (the default when piped)
  open <id | url>              open a saved recipe in iA Writer
  status [id | url]            app status, or one recipe's
  log [id] [--tail [N]]        the log; --tail shows the last N lines (default 20)
  clean                        clear the logs
  add <url> [--tag a,b] [--auto-tag=false]
                               queue a URL, with your own tags; --auto-tag=false skips Claude's
  preview <url>                run the pipeline and print the Markdown, saving nothing`;
const pageNo = positiveInt(flags.page, 1);
const autoTag = bool(flags["auto-tag"], true);
const tags = typeof flags.tag === "string" ? flags.tag.split(",").map((t) => t.trim()).filter(Boolean) : [];
const tail = flags.tail === undefined ? undefined : positiveInt(flags.tail, 20);
if (cmd === "run") await run();
else if (cmd === "queue") await queue();
else if (cmd === "list" && pageNo) await list(rest, pageNo, flags.plain === true || flags.page !== undefined);
else if (cmd === "open" && rest.length === 1) await open(rest[0]);
else if (cmd === "status" && rest.length <= 1) await status(rest[0]);
else if (cmd === "log" && rest.length <= 1 && tail !== null) await showLog(rest[0], tail);
else if (cmd === "clean" && !rest.length) await clean();
else if (cmd === "add" && rest.length === 1 && flags.tag !== true && autoTag !== null) await add(rest[0], { tags, autoTag });
else if (cmd === "preview" && arg) await preview(arg);
else {
  console.error(usage);
  Deno.exit(2);
}
