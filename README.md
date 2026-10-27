# Recipe Saver

Share an Instagram reel (or a recipe page) from your iPhone and a plain-text recipe appears in `iCloud Drive/iA Writer/Recipes/`. See [SPEC.md](SPEC.md) for the design.

## How it works

```
iPhone                         iCloud Drive                         Mac
──────                         ────────────                         ───
Share → "Save Recipe"  ──▶  Shortcuts/recipe-inbox/<id>.txt  ──▶  launchd starts `recipe-saver run`
                                                                     │  fetch the post, extract the recipe
                            iA Writer/Recipes/<slug>.md  ◀────────────┘  write Markdown, delete the inbox file
```

1. **Queue.** The Shortcut drops a one-line text file holding the shared URL into `iCloud Drive/Shortcuts/recipe-inbox/`. Nothing else happens on the phone. Sharing the same reel twice just overwrites the same file.
2. **Wake up.** A launchd agent on the Mac watches that folder and starts `~/bin/recipe-saver run` when a file lands, plus every 15 minutes as a safety net (for missed events, or a Mac that was asleep). There's no process running in between. Files still downloading from iCloud are left until they arrive.
3. **Process**, oldest first, one at a time, 15 seconds apart so Instagram isn't hammered. A lock file stops two runs overlapping. Each item goes through up to three tiers, stopping as soon as the recipe is complete:
   1. **Caption.** `yt-dlp` fetches the post's caption and creator (using your Waterfox Instagram login). Claude Haiku turns it into a structured recipe and decides whether the post is a recipe at all; if not, it's skipped.
   2. **Recipe page.** If the caption is missing quantities or steps, it follows a link in the caption, or has Claude search the web for the creator's own write-up (blog, Substack), and reads the recipe from that page. A recipe URL shared directly from Safari starts here.
   3. **Video.** Still incomplete: it downloads the video, transcribes the audio locally with whisper.cpp, and sends ~10 frames to Claude to read on-screen text (for carousels, the slide images). The media is deleted afterwards.

   Whatever's found is written even if it's incomplete, marked `partial` (cookable, but something's missing) or `needs-source` (not cookable).
4. **Write.** The recipe becomes a Markdown file in `iCloud Drive/iA Writer/Recipes/`, named after the title. Existing files are never overwritten; a clash gets a `-2` suffix. The inbox file is deleted, and the item's ID is recorded so it's never processed twice. (Use `recipe-saver status <url>` to look one up by link.)

### Recipe files

```markdown
---
title: Brothy Chickpeas & Rice
id: a9fbcf7b89a5
source: https://www.instagram.com/reel/De7QgD3Iy9z/
recipe_url: https://madeleinesmeals.substack.com/p/brothy-chickpeas-and-rice
saved: 2026-10-26
servings: "2"
tags: #vegetarian #comfort_food #chickpea
status: complete
extracted_from: [caption, recipe-page]
---

# Brothy Chickpeas & Rice

## Ingredients
…
## Steps
…
## Notes
…
```

- **`id`** is a short hash of the shared URL, after dropping tracking junk (`utm_…`, `igsh`, …) so the same post shared twice gets the same ID. The commands below (`status`, `log`) take it, and it's how the saver recognises a recipe even after you rename the file.
- **`tags`** are iA Writer hashtags, so they show up in iA Writer's Hashtags list. Multi-word tags use `_` (`#comfort_food`). This line isn't valid YAML; that's deliberate. `list` reads hashtags from anywhere in the file, so tags you add by hand count too.
- **`status`** is `complete`, `partial` or `needs-source`; anything but `complete` also gets a `status_reason`.
- **`extracted_from`** says which tiers contributed.

You can edit recipes freely in iA Writer; the saver never touches a file after writing it.

### Failures

- **One post can't be fetched** (deleted, private): a `needs-source` file is written with the link, so you can finish it by hand.
- **Network blips**: retried on later runs, up to 3 attempts, then a Mac notification.
- **Problems only you can fix** (Instagram logged out, `yt-dlp` broken, bad API key): the run stops, everything stays queued, and you get a notification at most once a day per problem. `status` reports `error` until the next recipe saves successfully.

### Where things live

| What | Where |
|---|---|
| Recipes | `~/Library/Mobile Documents/27N4MQEA55~pro~writer/Documents/Recipes/` (iCloud Drive › iA Writer › Recipes) |
| Queue | `~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/recipe-inbox/` (iCloud Drive › Shortcuts › recipe-inbox) |
| Log, saved-ID record (`state.json`), debug data | `~/Library/Application Support/recipe-saver/` |
| API key | Keychain, service `recipe-saver` |
| Program | `~/bin/recipe-saver`, built from `src/` by `deno task compile` |

Debug data (raw post info, transcripts, Claude's extractions) is kept per ID for 30 days.

## iPhone Shortcut

In the Shortcuts app, create a new shortcut named **Save Recipe**:

1. Tap the **ⓘ** (details) button → turn on **Show in Share Sheet**. Under *Share Sheet Types*, leave only **URLs** and **Text** selected.
2. Set *Receive …* to: **If there's no input: Stop and Respond**.
3. Add **Get URLs from Input** (input: *Shortcut Input*).
4. Add **Get Item from List** → *First Item* of *URLs*.
5. Add **Match Text**: pattern `(?:reels?|p|tv)/([A-Za-z0-9_-]+)` in *Item from List*.
6. Add **Get Group from Matched Text** → *Group At Index* `1`.
7. Add **If** *Text from Group* **has any value**:
   - **Text**: *Text from Group* → set variable `Name`
   - **Otherwise**: **Format Date** (*Current Date*, custom format `yyyyMMdd-HHmmss`) → set variable `Name`
   - **End If**
8. Add **Text** containing just the *Item from List* (the URL).
9. Add **Save File**: save *Text* to **Shortcuts**, turn **off** *Ask Where to Save*, set *Subpath* to `recipe-inbox/Name.txt` (insert the `Name` variable), turn **on** *Overwrite If File Exists*.
10. Add **Show Notification**: `Saved ✓`.

To use it in Instagram, tap **Share → Share to…** on a reel (or **Copy link**, then share the link from Safari/Notes), then choose **Save Recipe**. For a recipe blog, share the page from Safari.

The Shortcut writes into `iCloud Drive/Shortcuts/recipe-inbox/`. The Mac picks it up the next time it's awake.

## Mac setup

```sh
brew install yt-dlp ffmpeg whisper-cpp

# whisper model (~490 MB)
curl -L -o ~/Library/Application\ Support/recipe-saver/models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin

# Anthropic API key in Keychain
security add-generic-password -s recipe-saver -a anthropic -w

# build + launchd agent
deno task compile

cp launchd/local.recipe-saver.plist ~/Library/LaunchAgents/

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.recipe-saver.plist
```

Stay logged into Instagram in **Waterfox**; that's where the cookies come from.

## Commands

```sh
deno task dev preview <url>   # run the full pipeline, print Markdown, save nothing
~/bin/recipe-saver add <url>  # queue a URL (same as the Shortcut)
~/bin/recipe-saver queue      # show what's queued, oldest first
~/bin/recipe-saver list       # saved recipes, newest first, 10 per page (--page 2 for more)
~/bin/recipe-saver list mushroom weeknight  # only recipes tagged with all of these
~/bin/recipe-saver list "comfort food"      # quote a multi-word tag (matches #comfort_food)
~/bin/recipe-saver status     # idle_no_queue | waiting_to_start | processing | error
~/bin/recipe-saver status <id>              # one recipe: waiting_to_start | processing | error | saved | not_recipe | not_found
~/bin/recipe-saver log --tail 50            # last 50 log lines (bare --tail: 20)
~/bin/recipe-saver log <id>                 # everything logged about one recipe
~/bin/recipe-saver clean                    # clear the logs
~/bin/recipe-saver run        # drain the inbox now (launchd does this automatically)
```

After changing code: `deno task compile` (launchd runs `~/bin/recipe-saver`).

## When something breaks

- **Notification "Instagram refused the request"**: open Waterfox and log into Instagram. Items stay queued and retry automatically.
- **Notification "yt-dlp failed"**: `brew upgrade yt-dlp`. This is the main recurring maintenance.
- **Is it working?** `recipe-saver status`, then `recipe-saver log --tail` or `recipe-saver log <id>`.
- **Log file**: `~/Library/Application Support/recipe-saver/recipe-saver.log`
- **What Claude saw for one reel**: `~/Library/Application Support/recipe-saver/debug/<id>/` (kept 30 days)
- **Re-process a reel**: delete its entry from `state.json` in the same folder, then `add` it again. The script never overwrites an existing recipe file; you'll get a `-2` copy.
- **Stop it**: `launchctl bootout gui/$(id -u)/local.recipe-saver`
