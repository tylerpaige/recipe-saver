import { bin } from "./config.ts";
import { ItemError, SystemicError, TransientError } from "./errors.ts";

export interface PostInfo {
  id: string;
  url: string;
  caption: string;
  creator: string | null; // "@handle"
  raw: unknown;
}

/** Reel/post shortcode from an Instagram URL, or null for other URLs. */
export function instagramId(url: string): string | null {
  return url.match(/instagram\.com\/(?:[^/]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

function classify(stderr: string): Error {
  const s = stderr.toLowerCase();
  if (/login required|log in|rate-limit|rate limit|checkpoint|cookies/.test(s)) {
    return new SystemicError(
      "instagram-login",
      "Instagram refused the request. Open Waterfox and check you're still logged in.",
    );
  }
  if (/not available|does not exist|404|private|unsupported url|no video/.test(s)) {
    return new ItemError(stderr.trim().split("\n").pop() ?? "Post not available");
  }
  if (/timed out|connection|temporary failure|5\d\d|network/.test(s)) {
    return new TransientError(stderr.trim());
  }
  // Unknown extractor failure: usually Instagram changed something and
  // yt-dlp needs `brew upgrade yt-dlp`.
  return new SystemicError(
    "yt-dlp",
    "yt-dlp failed in an unexpected way. Try `brew upgrade yt-dlp`.",
  );
}

/** Tier 1: metadata only (caption, uploader). No media download. */
export async function fetchInfo(url: string, cookiesFile: string): Promise<PostInfo> {
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(bin.ytDlp, {
      args: [
        "--cookies", cookiesFile,
        "--skip-download",
        "--ignore-no-formats-error", // photo/carousel posts still return metadata
        "--dump-single-json",
        "--no-warnings",
        "--socket-timeout", "30",
        url,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch {
    throw new SystemicError("yt-dlp", `yt-dlp not found at ${bin.ytDlp}. Run \`brew install yt-dlp\`.`);
  }
  if (!out.success) throw classify(new TextDecoder().decode(out.stderr));

  // deno-lint-ignore no-explicit-any
  const info: any = JSON.parse(new TextDecoder().decode(out.stdout));
  // Carousels come back as a playlist; the caption lives on the playlist or
  // its first entry.
  const first = info.entries?.[0] ?? {};
  const caption = info.description ?? first.description ?? "";
  const handle = info.channel ?? first.channel ?? info.uploader_id ?? first.uploader_id;
  return {
    id: instagramId(url) ?? info.id,
    url,
    caption,
    creator: handle ? `@${String(handle).replace(/^@/, "")}` : null,
    raw: info,
  };
}
