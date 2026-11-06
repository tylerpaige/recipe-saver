// Settings changed with `recipe-saver config`. Secrets live in Keychain, never in a file; the rest in settings.json.
import Anthropic from "@anthropic-ai/sdk";
import { join } from "@std/path";
import { bin, KEYCHAIN_SERVICE, paths } from "./config.ts";
import { loadState, saveState } from "./state.ts";

// Ingredients `cook` assumes you always have, on top of salt, oil, dried spices and the like.
const DEFAULT_PANTRY = "garlic, onion, miso";

const settingsFile = () => join(paths.state, "settings.json");

async function readSettingsFile(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await Deno.readTextFile(settingsFile()));
  } catch {
    return {};
  }
}

async function writeSettingsFile(values: Record<string, string>): Promise<void> {
  await Deno.mkdir(paths.state, { recursive: true });
  const tmp = `${settingsFile()}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(values, null, 2));
  await Deno.rename(tmp, settingsFile());
}

/** Your pantry staples, from `config set pantry`, else the default. */
export async function pantry(): Promise<string[]> {
  const value = (await readSettingsFile()).pantry ?? DEFAULT_PANTRY;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

interface Setting {
  description: string;
  /** The value and where it came from, or null if unset. */
  get(): Promise<{ value: string; source: string } | null>;
  /** Saves the value; returns a warning to print, if any. Throws (with a message for the user) if it's invalid. */
  set(value: string): Promise<string | void>;
  /** Removes the stored value; false if there wasn't one. */
  unset(): Promise<boolean>;
  secret: boolean;
}

async function keychainRead(): Promise<string | null> {
  const out = await new Deno.Command(bin.security, {
    args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const value = new TextDecoder().decode(out.stdout).trim();
  return out.success && value ? value : null;
}

/** Writes via `security -i` on stdin, so the value never shows up in the process list. Caller must validate it: no quotes or spaces. */
async function keychainWrite(account: string, value: string): Promise<void> {
  const child = new Deno.Command(bin.security, { args: ["-i"], stdin: "piped", stdout: "null", stderr: "piped" }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w "${value}"\n`));
  await writer.close();
  const out = await child.output();
  const err = new TextDecoder().decode(out.stderr).trim();
  if (!out.success || err) throw new Error(`Couldn't write to Keychain: ${err || `security exited ${out.code}`}`);
}

async function keychainDelete(): Promise<boolean> {
  const out = await new Deno.Command(bin.security, {
    args: ["delete-generic-password", "-s", KEYCHAIN_SERVICE],
    stdout: "null",
    stderr: "null",
  }).output();
  return out.success;
}

/** ANTHROPIC_API_KEY if set, else the Keychain item. */
export async function anthropicApiKey(): Promise<string | null> {
  return Deno.env.get("ANTHROPIC_API_KEY") || await keychainRead();
}

export const settings: Record<string, Setting> = {
  "anthropic-api-key": {
    description: "Anthropic API key, stored in Keychain",
    secret: true,
    async get() {
      const env = Deno.env.get("ANTHROPIC_API_KEY");
      if (env) return { value: env, source: "ANTHROPIC_API_KEY, which overrides Keychain" };
      const value = await keychainRead();
      return value ? { value, source: `Keychain, service "${KEYCHAIN_SERVICE}"` } : null;
    },
    async set(value) {
      if (!/^sk-ant-[\w-]+$/.test(value)) throw new Error("That doesn't look like an Anthropic API key (sk-ant-…).");
      let warning: string | undefined;
      try {
        await new Anthropic({ apiKey: value, maxRetries: 0 }).models.list({ limit: 1 });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new Error("Anthropic rejected that key; not saved.");
        warning = `Couldn't check the key with Anthropic (${e instanceof Error ? e.message : e}); saved it anyway.`;
      }
      await keychainWrite("anthropic", value);
      // `status` would otherwise keep reporting the old bad-key error until the next recipe saves.
      const state = await loadState();
      if (state.lastError?.kind === "api-key") {
        delete state.lastError;
        await saveState(state);
      }
      if (Deno.env.get("ANTHROPIC_API_KEY")) {
        warning = [warning, "ANTHROPIC_API_KEY is set in this shell and overrides Keychain here."].filter(Boolean).join("\n");
      }
      return warning;
    },
    unset: keychainDelete,
  },
  pantry: {
    description: "Comma-separated staples `cook` never counts as missing (salt, oil, dried spices are always included)",
    secret: false,
    async get() {
      const value = (await readSettingsFile()).pantry;
      return value ? { value, source: settingsFile() } : { value: DEFAULT_PANTRY, source: "default" };
    },
    async set(value) {
      const items = value.split(",").map((s) => s.trim()).filter(Boolean);
      if (!items.length) throw new Error("Give a comma-separated list, e.g. \"garlic, onion, miso\".");
      await writeSettingsFile({ ...(await readSettingsFile()), pantry: items.join(", ") });
    },
    async unset() {
      const values = await readSettingsFile();
      if (values.pantry === undefined) return false;
      delete values.pantry;
      await writeSettingsFile(values);
      return true;
    },
  },
};

export const mask = (value: string) => value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-4)}` : "…";
