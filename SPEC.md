# Recipe Saver — Spec

Archive recipes from Instagram Reels (and carousels, and plain recipe URLs) as plain-text Markdown in iCloud Drive, read in iA Writer on iPhone.

## Intake

- iPhone Share Sheet Shortcut: silent, one tap, "Saved ✓" notification.
- Writes one file per item to `iCloud Drive/Shortcuts/recipe-inbox/<id>.txt` containing the shared URL. Filename is the reel/post ID when derivable (dedupes double-shares), else a timestamp.
- Backlog: one-time `import-export` command reads the Instagram data export (saved collections JSON), filters to the recipe collection (~90 items), and writes them into the inbox.

## Trigger

- launchd agent with `WatchPaths` on the inbox (fast path) + `StartInterval` 900s (safety net for missed/asleep events).
- `ProcessType=Background`, `LowPriorityIO=true`. No resident process; an empty inbox exits immediately.
- Idempotent: drains the inbox, skips already-processed IDs, self-throttles to ≤ ~4 fetches/minute.
- Ignore iCloud placeholder files (`.icloud`) until downloaded.

## Pipeline (tiered; stop as soon as the recipe is complete)

1. **Caption** — `yt-dlp --skip-download --dump-json` → caption + uploader. One Claude Haiku 4.5 call with a strict JSON schema. Includes an `is_recipe` check (non-recipes are skipped and logged).
2. **Recipe page** — URL in the caption (or the shared item itself is a URL) → parse schema.org `Recipe` JSON-LD. If no URL, web-search "creator + dish title". Normalize through the same LLM extraction for formatting/conversions.
3. **Media** — download video (or carousel images). Audio → whisper.cpp `small.en`. 6–10 frames via ffmpeg scene detection (or carousel slides) sent directly to Claude as images (no OCR). Delete media afterwards.
4. **Give up gracefully** — write the file anyway with `status: needs-source` and a one-line reason.

## Output

Path: `iCloud Drive/iA Writer/Recipes/<slug>.md`. Plain CommonMark + YAML frontmatter. No images.

```markdown
---
title: Crispy Gochujang Tofu
id: 3f9a1c0b7e42           # hash of the URL minus tracking params; used by `status` and `log`
source: https://www.instagram.com/reel/C9xYz123abc/
recipe_url: https://somecook.com/gochujang-tofu   # only if found
saved: 2026-10-26
servings: 2
prep_time: 10 min
cook_time: 20 min
tags: #korean #tofu #vegetarian #weeknight
status: complete            # complete | partial | needs-source
status_reason: ...          # only when not complete
extracted_from: [caption]   # caption | recipe-page | transcript | frames
---

# Crispy Gochujang Tofu

## Ingredients

- 400 g (14 oz) extra-firm tofu, pressed and cubed
- 2 tbsp (30 ml) gochujang
- a glug of neutral oil
- 1 can coconut milk

## Steps

1. Toss the tofu in cornstarch and salt.
2. ...

## Notes

- Creator says the sauce keeps a week in the fridge.
```

Rules:
- Fields not found are omitted, never guessed.
- Tags are space-separated iA Writer hashtags on the frontmatter `tags:` line: lowercase, words joined with `_` (`#comfort_food`). YAML reads that line as a comment; that's accepted.
- `partial` = cookable but part of the recipe is missing (quantities, a step); missing servings/times don't count. `needs-source` = not cookable.
- A post about making a dish is a recipe even when the recipe text lives elsewhere ("comment RECIPE"); only non-cooking posts are skipped.
- Notes keep creator tips (storage, substitutions, why a step matters); no restating title/tags/times, no promotional chatter.
- Quantities kept as written. Add a conversion to the other system (metric ↔ US) in parentheses only for specific standard units. Teaspoons and tablespoons are never converted. Same-dimension conversions exact; weight↔volume only for common pantry staples, marked `~`. Never convert casual amounts ("a glug", "a handful") or container units ("can", "packet").
- **Write-once.** The script never modifies an existing recipe file. Filename collisions get `-2`, `-3`, …

## Operations

- **Cookies:** Waterfox profile (`~/Library/Application Support/Waterfox/Profiles/*.default-release`). Copy `cookies.sqlite` + `-wal` to a temp dir, export instagram.com cookies only to a temp Netscape `cookies.txt`, pass via `--cookies`, delete after. No Full Disk Access needed.
- **API key:** macOS Keychain, service `recipe-saver`, read via `security find-generic-password`.
- **State:** `~/Library/Application Support/recipe-saver/` — processed IDs, debug data (raw info JSON, transcripts, extraction JSON), logs. Pruned after 30 days.
- **Failures:**
  - Per-reel incomplete → `needs-source` file.
  - Transient (network) → silent retry, up to 3 attempts.
  - Systemic (cookies expired, yt-dlp broken, bad API key) → leave inbox file for retry; macOS notification, max once per failure type per day.

## Stack

- TypeScript on Deno, `deno compile` to a single binary at a stable path (e.g. `~/bin/recipe-saver`); launchd invokes it directly.
- Dependencies: Homebrew `yt-dlp`, `ffmpeg`, `whisper-cpp` + `small.en` model.

## v1 scope

In: Instagram Reels, Instagram carousels, plain recipe-blog URLs.
Out: TikTok / YouTube Shorts testing (fetch layer is source-agnostic so they can be added), retry-from-frontmatter, servings scaling, phone push notifications.

## Build order

1. Tier-1 caption pipeline end-to-end on one real reel.
2. launchd plist.
3. Tiers 2 and 3.
4. Shortcut instructions.
