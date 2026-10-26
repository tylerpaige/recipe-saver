import { join } from "@std/path";
import { bin, paths } from "./config.ts";
import { SystemicError } from "./errors.ts";

async function findProfile(): Promise<string> {
  try {
    for await (const entry of Deno.readDir(paths.waterfoxProfiles)) {
      if (entry.isDirectory && entry.name.endsWith(".default-release")) {
        return join(paths.waterfoxProfiles, entry.name);
      }
    }
  } catch { /* fall through */ }
  throw new SystemicError("cookies", "Couldn't find the Waterfox profile.");
}

/**
 * Writes Waterfox's instagram.com cookies to a temporary Netscape cookies.txt
 * and returns its path. Copies cookies.sqlite together with its -wal file so a
 * recently refreshed session isn't missed. Caller deletes the directory.
 */
export async function exportInstagramCookies(): Promise<{ file: string; dir: string }> {
  const profile = await findProfile();
  const dir = await Deno.makeTempDir({ prefix: "recipe-saver-" });
  const db = join(dir, "cookies.sqlite");
  await Deno.copyFile(join(profile, "cookies.sqlite"), db);
  try {
    await Deno.copyFile(join(profile, "cookies.sqlite-wal"), `${db}-wal`);
  } catch { /* no WAL is fine */ }

  const sql = "select host, path, isSecure, expiry, name, value from moz_cookies " +
    "where host = 'instagram.com' or host like '%.instagram.com'";
  const out = await new Deno.Command(bin.sqlite3, {
    args: ["-separator", "\t", db, sql],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new SystemicError("cookies", "Couldn't read Waterfox cookies.");
  }

  const rows = new TextDecoder().decode(out.stdout).trim().split("\n").filter(Boolean);
  if (!rows.some((r) => r.split("\t")[4] === "sessionid")) {
    throw new SystemicError(
      "instagram-login",
      "Not logged into Instagram in Waterfox. Open Waterfox and log in.",
    );
  }

  const lines = ["# Netscape HTTP Cookie File"];
  for (const row of rows) {
    const [host, path, secure, expiry, name, value] = row.split("\t");
    // Waterfox stores expiry in milliseconds; Netscape format wants seconds.
    let exp = Number(expiry) || 0;
    if (exp > 1e11) exp = Math.floor(exp / 1000);
    const domain = host.startsWith(".") ? host : `.${host}`;
    lines.push([domain, "TRUE", path, secure === "1" ? "TRUE" : "FALSE", exp, name, value].join("\t"));
  }
  const file = join(dir, "cookies.txt");
  await Deno.writeTextFile(file, lines.join("\n") + "\n", { mode: 0o600 });
  await Deno.remove(db);
  await Deno.remove(`${db}-wal`).catch(() => {});
  await Deno.remove(`${db}-shm`).catch(() => {});
  return { file, dir };
}

/** Exports cookies on first use (only Instagram items need them) and cleans up after. */
export class CookieJar {
  #exported: { file: string; dir: string } | null = null;

  async file(): Promise<string> {
    this.#exported ??= await exportInstagramCookies();
    return this.#exported.file;
  }

  async cleanup(): Promise<void> {
    if (this.#exported) await Deno.remove(this.#exported.dir, { recursive: true }).catch(() => {});
    this.#exported = null;
  }
}
