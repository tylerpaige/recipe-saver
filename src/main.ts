import { limits } from "./config.ts";
import {
  add,
  clean,
  cook,
  getConfig,
  ingredient,
  list,
  listConfig,
  open,
  pantryCommand,
  queue,
  setConfig,
  showConfig,
  showLog,
  splitNames,
  status,
  unsetConfig,
} from "./commands.ts";
import { preview, run } from "./run.ts";
import { DEFAULT_PORT, serve } from "./serve.ts";

// Flags whose value can follow as the next argument, whatever it looks like (others only take a number there).
const VALUED = new Set(["tag", "auto-tag", "message"]);
const SHORT: Record<string, string> = { m: "message" };

/** Splits args into positionals and `--name value` / `--name=value` / bare `--name` flags. */
function parseArgs(args: string[]): { rest: string[]; flags: Record<string, string | true> } {
  const rest: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--([a-z-]+)(?:=(.*))?$/) ??
      (SHORT[args[i].slice(1)] && args[i].startsWith("-") ? [args[i], SHORT[args[i].slice(1)]] : null);
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
  cook [ingredient, ...] [--plain]
                               pick a recipe using what you have, most of it first; separate with
                               commas, or quote each one ("butternut squash" kale); with none, pick
                               them from a list
  ingredient [name]            the rules cook matches by, or one ingredient's rules and recipes
  ingredient alias|kind <name>, <name>
                               courgette is another name for zucchini; red onion is a kind of onion
  ingredient swap <name>       what can stand in for it
  ingredient swap <name>, <name>, ...
                               these stand in for each other
  ingredient unalias|unkind|unswap <name>
                               remove one of an ingredient's rules
  pantry [list]                what cook assumes you always have (never counted as missing)
  pantry add|remove <item>, ...
                               change it
  open <id | url>              open a saved recipe in iA Writer
  status [id | url]            app status, or one recipe's
  log [id] [--tail [N]]        the log; --tail shows the last N lines (default 20)
  clean                        clear the logs
  add <url> [--tag a,b] [--auto-tag=false] [-m "note"]
                               queue a URL, with your own tags; --auto-tag=false skips Claude's;
                               -m/--message adds your note under the title
  preview <url>                run the pipeline and print the Markdown, saving nothing
  serve [--port N]             the kitchen website, on localhost (default port ${DEFAULT_PORT})
  config                       show settings
  config list                  list the settings you can change
  config get <key> [--reveal]  print one setting; secrets are masked unless --reveal
  config set <key> [value]     change a setting; leave out the value to be asked for it (hidden for secrets)
  config unset <key>           remove a setting`;
const pageNo = positiveInt(flags.page, 1);
const autoTag = bool(flags["auto-tag"], true);
const tags = typeof flags.tag === "string" ? flags.tag.split(",").map((t) => t.trim()).filter(Boolean) : [];
// `cook kabocha, kale` splits on commas; without any, each argument is one ingredient.
const have = splitNames(rest);
const port = positiveInt(flags.port, DEFAULT_PORT);
const tail = flags.tail === undefined ? undefined : positiveInt(flags.tail, 20);
if (cmd === "run") await run();
else if (cmd === "queue") await queue();
else if (cmd === "list" && pageNo) await list(rest, pageNo, flags.plain === true || flags.page !== undefined);
else if (cmd === "ingredient") await ingredient(rest);
else if (cmd === "pantry") await pantryCommand(rest);
else if (cmd === "cook") await cook(have, flags.plain === true);
else if (cmd === "open" && rest.length === 1) await open(rest[0]);
else if (cmd === "status" && rest.length <= 1) await status(rest[0]);
else if (cmd === "log" && rest.length <= 1 && tail !== null) await showLog(rest[0], tail);
else if (cmd === "clean" && !rest.length) await clean();
else if (cmd === "add" && rest.length === 1 && flags.tag !== true && flags.message !== true && autoTag !== null) {
  await add(rest[0], { tags, autoTag, message: (flags.message || "").trim() || undefined });
}
else if (cmd === "preview" && arg) await preview(arg);
else if (cmd === "serve" && !rest.length && port) serve(port);
else if (cmd === "config" && !rest.length) await showConfig();
else if (cmd === "config" && rest[0] === "list" && rest.length === 1) listConfig();
else if (cmd === "config" && rest[0] === "get" && rest.length === 2) await getConfig(rest[1], flags.reveal === true);
else if (cmd === "config" && rest[0] === "set" && (rest.length === 2 || rest.length === 3)) await setConfig(rest[1], rest[2]);
else if (cmd === "config" && rest[0] === "unset" && rest.length === 2) await unsetConfig(rest[1]);
else {
  console.error(usage);
  Deno.exit(2);
}
