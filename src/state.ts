import { join } from "@std/path";
import { bin, limits, paths } from "./config.ts";

// Only what the recipe files can't tell us. Whether a recipe is saved is answered by the Recipes folder
// (each file's `id`), so deleting a file is all it takes to have a re-shared post processed again.
interface State {
  notRecipes: Record<string, string>; // id -> ISO time it was checked and found not to be a recipe
  attempts: Record<string, number>; // id -> failed attempts so far
  lastNotified: Record<string, string>; // failure kind -> ISO time
  current?: { id: string; since: string }; // item being processed right now
  lastError?: { id: string; kind: string; message: string; at: string }; // cleared by the next success
}

export type { State };

export const logFile = () => join(paths.state, "recipe-saver.log");

const stateFile = () => join(paths.state, "state.json");

export async function loadState(): Promise<State> {
  const empty: State = { notRecipes: {}, attempts: {}, lastNotified: {} };
  try {
    return { ...empty, ...JSON.parse(await Deno.readTextFile(stateFile())) };
  } catch {
    return empty;
  }
}

export async function saveState(state: State): Promise<void> {
  await Deno.mkdir(paths.state, { recursive: true });
  const tmp = `${stateFile()}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(state, null, 2));
  await Deno.rename(tmp, stateFile());
}

export async function log(message: string): Promise<void> {
  await Deno.mkdir(paths.state, { recursive: true });
  const line = `${new Date().toISOString()} ${message}\n`;
  await Deno.writeTextFile(logFile(), line, { append: true });
  console.error(message);
}

/** Saves raw inputs/outputs for one item, for debugging. Pruned after 30 days. */
export async function saveDebug(id: string, name: string, data: unknown): Promise<void> {
  const dir = join(paths.state, "debug", id);
  await Deno.mkdir(dir, { recursive: true });
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  await Deno.writeTextFile(join(dir, name), body);
}

export async function pruneDebug(): Promise<void> {
  const root = join(paths.state, "debug");
  const cutoff = Date.now() - limits.debugRetentionDays * 86_400_000;
  try {
    for await (const e of Deno.readDir(root)) {
      const p = join(root, e.name);
      const { mtime } = await Deno.stat(p);
      if (mtime && mtime.getTime() < cutoff) await Deno.remove(p, { recursive: true });
    }
  } catch { /* nothing to prune */ }
}

/** macOS notification, at most once per failure kind per day. */
export async function notifyOnce(state: State, kind: string, message: string): Promise<void> {
  const last = state.lastNotified[kind];
  if (last && Date.now() - Date.parse(last) < 86_400_000) return;
  state.lastNotified[kind] = new Date().toISOString();
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await new Deno.Command(bin.osascript, {
    args: ["-e", `display notification "${esc(message)}" with title "Recipe Saver"`],
    stdout: "null",
    stderr: "null",
  }).output();
}

/** True while a live `run` holds the lock. Stale if the holder is gone (crash) or it's been an hour. */
export async function runInProgress(): Promise<boolean> {
  const lock = join(paths.state, "run.lock");
  const pid = Number(await Deno.readTextFile(lock).catch(() => "0"));
  if (!pid) return false;
  const mtime = (await Deno.stat(lock).catch(() => null))?.mtime;
  if (mtime && Date.now() - mtime.getTime() > 3_600_000) return false;
  return (await new Deno.Command("/bin/kill", { args: ["-0", String(pid)], stderr: "null" }).output()).success;
}

/** Single-instance lock so WatchPaths and the interval timer never overlap. */
export async function acquireLock(): Promise<boolean> {
  await Deno.mkdir(paths.state, { recursive: true });
  const lock = join(paths.state, "run.lock");
  try {
    await Deno.writeTextFile(lock, String(Deno.pid), { createNew: true });
    return true;
  } catch {
    if (await runInProgress()) return false;
    await Deno.remove(lock).catch(() => {});
    return acquireLock();
  }
}

export async function releaseLock(): Promise<void> {
  await Deno.remove(join(paths.state, "run.lock")).catch(() => {});
}
