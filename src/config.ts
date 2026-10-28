import { join } from "@std/path";

const HOME = Deno.env.get("HOME")!;
const ICLOUD = join(HOME, "Library/Mobile Documents");

export const paths = {
  // iCloud Drive/iA Writer/Recipes — shows up in iA Writer's library on iPhone.
  recipes: Deno.env.get("RECIPE_SAVER_OUTPUT") ??
    join(ICLOUD, "27N4MQEA55~pro~writer/Documents/Recipes"),
  // iCloud Drive/Shortcuts/recipe-inbox — the Share Sheet Shortcut writes here.
  inbox: Deno.env.get("RECIPE_SAVER_INBOX") ??
    join(ICLOUD, "iCloud~is~workflow~my~workflows/Documents/recipe-inbox"),
  // Local bookkeeping; never synced.
  state: join(HOME, "Library/Application Support/recipe-saver"),
  waterfoxProfiles: join(HOME, "Library/Application Support/Waterfox/Profiles"),
};

export const MODEL = "claude-haiku-4-5";
export const KEYCHAIN_SERVICE = "recipe-saver";

export const limits = {
  // ≤ ~4 fetches/minute.
  secondsBetweenItems: 15,
  maxItemsPerRun: 20,
  maxTransientAttempts: 3,
  debugRetentionDays: 30,
  recipesPerPage: 10,
};

// Homebrew binaries; launchd doesn't inherit your shell PATH.
export const bin = {
  ytDlp: "/opt/homebrew/bin/yt-dlp",
  ffmpeg: "/opt/homebrew/bin/ffmpeg",
  ffprobe: "/opt/homebrew/bin/ffprobe",
  whisper: "/opt/homebrew/bin/whisper-cli",
  sqlite3: "/usr/bin/sqlite3",
  osascript: "/usr/bin/osascript",
  security: "/usr/bin/security",
  launchctl: "/bin/launchctl",
  gum: "/opt/homebrew/bin/gum",
  open: "/usr/bin/open",
};

export const EDITOR_APP = "iA Writer";
