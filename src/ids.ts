import { instagramId } from "./fetch.ts";

// Share-sheet and analytics junk that doesn't change which page a URL points at.
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|igsh|igshid|mc_cid|mc_eid|ref|ref_src)$/;

/** The same post shared twice (different tracking params, /reel/ vs /p/) normalizes to one URL. */
export function canonicalUrl(url: string): string {
  const ig = instagramId(url);
  if (ig) return `https://www.instagram.com/p/${ig}/`;
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

/** A recipe's ID: a short hash of its canonical URL. */
export async function itemId(url: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(canonicalUrl(url)));
  return [...new Uint8Array(hash)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}
