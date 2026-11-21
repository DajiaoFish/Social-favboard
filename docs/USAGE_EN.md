# Social Favboard · Setup & Usage

Turn your Douyin / Bilibili / Xiaohongshu likes and favorites into cards on an Obsidian board — you do the sorting by dragging.

[中文版](../使用说明.md) | **English**

---

## How it works

Two parts, cleanly divided:

The **browser extension** runs in your own Chrome / Edge and reads only what the page has already loaded — it sends no requests of its own toward the platforms. You log in normally and scroll normally; it quietly notes what you see.

The **Obsidian plugin** opens a local port listening only on `127.0.0.1`, receives what the extension sends, downloads covers, builds cards, and writes them onto the board.

Everything platform-related happens inside your browser, under your own identity. The plugin stays fully offline and never touches any platform.

---

## 1. Enable the Obsidian plugin

The plugin is already inside your vault (`.obsidian/plugins/social-favboard/`).

1. Open Obsidian → Settings → Community plugins
2. If prompted about Restricted mode, turn it off first
3. Find **Social Favboard** under Installed plugins and toggle it on

Once enabled, a film-strip icon appears in the left sidebar; click it to open the collection panel. In settings, a green line like `Local receiver ready · 127.0.0.1:27123` means the port is up.

---

## 2. Install the browser extension

The extension files live in this repo's `browser-extension/` folder (the same-named folder after unzipping the repo ZIP).

Copy the folder to a permanent location first (e.g. `D:\Tools\browser-extension`) so it isn't wiped when you clean your Downloads folder.

To install (same for Chrome / Edge):

1. Type `chrome://extensions` in the address bar (`edge://extensions` on Edge)
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `browser-extension` folder

Click the extension icon afterwards — a green "Connected to Obsidian plugin" means you're set.

> Requires Chrome / Edge 111 or newer. On older versions the page hook doesn't fire and only DOM scanning works — usable, but titles and authors may be incomplete.

---

## 3. First-time configuration

Two things in the plugin settings:

**1. Set the target canvas**

For example `Inspiration/Video styles/Zen aesthetics.canvas`. Once set, collected content is written to this board automatically.

**2. Create your topics**

In the "Topics" section of settings, click `+ Add topic`, give it a name and a color. As many as you want, editable anytime.

Note: Obsidian Canvas natively has only 6 colors (red/orange/yellow/green/cyan/purple); with more than 6 topics colors repeat, so every card also carries a `#topic-name` line to tell them apart.

**3. Per-batch limit (default 30)**

The "Per-batch limit" setting, 5 to 50 (default 30). Meaning: at most this many cards are written to the board per round, cover downloads included. Extras stay in the queue for the next round.

This exists to control request volume — syncing 2000 cards would fire hundreds of cover requests within two minutes, which looks anomalous in platform logs; batching keeps it flat. Leave it at 30 and you'll never notice.

---

## 4. Daily use

**Scroll on "favorites / likes" list pages** — the extension only collects there:

| Platform | Where | Page pattern |
|---|---|---|
| Douyin | Avatar → **Likes / Collections** tab | URL starts with `/user/...` |
| Bilibili | A favorites folder page | URL contains `favlist` |
| Xiaohongshu | Profile → **Collected** or **Liked** | URL is `/user/profile/...` followed by `collected` or `liked` |

**Home pages, video pages and search pages are not collected** — those video links come from recommendation feeds and comment sections, not your favorites; capturing them would only add junk.

1. Scroll down normally on the pages above
2. After a while, check the board in Obsidian — cards have been spread into the empty space on the right

Cards are spread out, not grouped, not overlapping, with generous spacing for dragging. Grouping, connecting and recoloring are all done manually on the board.

If auto-write is off, content waits in the collection panel's queue until you confirm and click "Write to canvas now".

Anything beyond the per-batch limit stays in the queue; the plugin notifies you how much remains. Keep scrolling and it continues automatically, or click "Write to canvas now" to nudge a batch.

### How duplicates are handled

The "Dedup records" section in settings manages this. By default **the same video is only saved once** — the second encounter is skipped.

Three buttons/switches with completely different jobs:

| Item | When to use |
|---|---|
| **Skip already-saved items** (switch) | On by default. Turning it off means "every encounter makes a new card" — the board fills with duplicates; generally leave it on |
| **Rebuild records from board** | You deleted some cards and want them re-collectable next time. It keeps only records for cards actually still on a board, so it won't re-grab everything old |
| **Clear records** | Start from scratch. Everything counts as new afterwards; the board will fill with duplicates |

**"Rebuild records from board" scans every canvas in the whole vault**, not just the current one. Cards saved to other boards are recognized too, so switching target boards doesn't cause re-grabbing.

### Manual or automatic classification

Pick in settings under "Classification mode"; default is **manual**:

- **Manual (drag yourself)**: cards spread across the board; you arrange everything. The plugin never touches your placements.
- **Keyword auto-classification**: incoming cards are placed straight into the matching group frame, colored accordingly.

For automatic mode, add a few rules under "Keyword rules":

| Field | What to enter |
|---|---|
| Category name | Shown as the frame title, also the `#tag` name on cards |
| Keywords | Comma-separated, e.g. `restaurant, recipe, tasty`; any hit in the title counts |
| Color | The frame color; only 6 native colors exist |

Matching runs top to bottom, **first hit wins**; cards with no hit go into the "Other" frame.

Settings also has an **"Organize current canvas now"** button that re-sorts cards already on the board. It only moves cards generated by this project — **your own cards and handwritten notes are never touched**.

Frame positions are computed by "find a whole empty rectangle": every candidate block is tested against all existing content and only placed when fully clear, so **frames never cover cards, and frames never overlap each other**.

---

## 5. Pausing collection (master switch)

**Click the extension icon on the browser toolbar** — the big green button at the top of the popup is the master switch.

| State | Button shows | Meaning |
|---|---|---|
| Collecting | Green "Pause" | Grabs automatically while you scroll |
| Paused | Red "Resume" | **Not collecting at all**: no page scanning, no receiving, no sending |

**After pausing, three visible indicators keep you from misreading the state:**

1. The popup button turns red and reads "Resume"
2. The status line reads "Paused — not scanning, not grabbing, not sending"
3. **A gray `OFF` badge appears on the toolbar icon** — visible without even opening the popup

**Details worth knowing:**

- **Takes effect on all tabs immediately** — no need to close pages one by one
- **Already-captured items are sent out first**, then collection stops — no data loss
- **Pause persists across browser restarts and page reloads**; it won't lift itself
- While paused, manually clicking "Send to Obsidian now" still works — it only delivers what was already captured, it grabs nothing new

**To stop collection dead, besides this switch there's one physical way**: close the favorites page tab. Close the page, and its scripts cease to exist.

---

## FAQ

**Extension shows "Not connected to Obsidian"**

First confirm Obsidian is open and the plugin enabled. Then click "Restart local port" once in the plugin settings.

**Collected but nothing written to the board**

Check whether "Target canvas" in the plugin settings is empty. If it is, the plugin doesn't know where to write and everything waits in the queue.

**Covers don't show, only text cards**

When a cover download fails, the card degrades to text-only without affecting the rest. Usually the CDN's hotlink protection blocked it; retrying usually fixes it.

**Will the same video be collected twice**

No. The plugin remembers saved ids and skips duplicates. To re-collect, clear the dedup records in settings.

**Xiaohongshu card opens to "This note cannot be viewed"**

Xiaohongshu requires links to carry `xsec_token` (a temporary token). The extension grabs it from data the page already has: token available → `▶ Open original`; not available → it automatically becomes `🔍 Search this on Xiaohongshu`, never a guaranteed-dead link.

Tokens expire (usually within days), so every tokened card carries a search-link fallback line. When the tokened one expires, use the search line.

**An orange number appears on the extension icon**

That many items haven't been delivered to Obsidian yet. Usually Obsidian is closed or the plugin disabled — opening it auto-delivers, no need to scroll again. Gray `OFF` means paused; nothing shown means normal.

**Scrolling only captures part of the content**

The platform's lazy loading has a depth limit; past a point it stops serving new data. Platform behavior, no way around it.

---

## Limitations you should know

- This is an unofficial route. What it guarantees is **no extra requests and no automated actions on your account** — it cannot guarantee full compliance with platform terms, nor survival across platform redesigns.
- You get "the part you can scroll to". Content too old to appear, no tool can reach.
- The browser extension and the Obsidian plugin must both be running.

---

## File list

```
social-favboard/          Obsidian plugin (already inside the vault)
  manifest.json
  main.js
  styles.css

browser-extension/          Browser extension
  manifest.json
  inject.js                    Main-world page hook, listens to API responses
  content.js                   Isolated world, parses responses + DOM scan fallback
  background.js                Buffering and forwarding to the local port
  popup.html / popup.js        Status panel
```
