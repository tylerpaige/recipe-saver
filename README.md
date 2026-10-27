# Recipe Saver

Share an Instagram reel (or a recipe page) from your iPhone and a plain-text recipe appears in `iCloud Drive/iA Writer/Recipes/`. See [SPEC.md](SPEC.md) for the design.

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
- **Log**: `~/Library/Application Support/recipe-saver/recipe-saver.log`
- **What Claude saw for one reel**: `~/Library/Application Support/recipe-saver/debug/<reel-id>/` (kept 30 days)
- **Re-process a reel**: delete its entry from `state.json` in the same folder, then `add` it again. The script never overwrites an existing recipe file; you'll get a `-2` copy.
- **Stop it**: `launchctl bootout gui/$(id -u)/local.recipe-saver`
