# Social Favboard Installation Guide (From Zero)

Step-by-step version: from downloading on GitHub to the first card appearing on your board, in four steps. No command line, no Node.js needed at any point.

[中文版](../安装教程.md) | **English**

---

## Step 0: Download and unzip

1. Open the project's GitHub page, click the green **Code** button → **Download ZIP**.
2. The browser downloads an archive named something like `Social-Favboard-main.zip`.
3. **Right-click → Extract all** (don't just preview it inside the archive tool — it must be extracted onto disk).

After extraction you'll have a folder like this:

```
Social-Favboard-main\          ← the extracted top folder
├── browser-extension\         ← Part 1: browser extension (3 js files + manifest.json + popup, etc.)
├── social-favboard\           ← Part 2: Obsidian plugin (main.js + manifest.json + styles.css)
├── README.md
├── docs\
│   ├── INSTALL_EN.md          ← you are reading this
│   └── USAGE_EN.md
└── 使用说明.md                 ← usage guide (Chinese)
```

**Important**: the two parts belong to two different pieces of software — don't mix them up:
- `browser-extension` goes into the **browser** (Edge / Chrome);
- `social-favboard` goes into **Obsidian**.

---

## Step 1: Install the browser extension

First, the differences between browsers — pick the row that matches yours:

| Browser | Extensions page | Load button | What to select |
|---|---|---|---|
| **Edge** | `edge://extensions` | Load unpacked | **folder** `browser-extension` |
| **Chrome** | `chrome://extensions` | Load unpacked | **folder** `browser-extension` |
| **Brave** | `brave://extensions` | Load unpacked | **folder** `browser-extension` |
| **Other Chromium-based browsers** | look for "Extensions / Apps" in settings | Load unpacked | **folder** `browser-extension` |
| **Firefox** | `about:debugging#/runtime/this-firefox` | Load Temporary Add-on | **file** `browser-extension\manifest.json` |

Everything in the "What to select" column refers to the `browser-extension` folder inside the extracted top folder — the one sitting next to `social-favboard`, containing `manifest.json`, `content.js`, `popup.html` and so on. **`social-favboard` is the Obsidian plugin; never load it into the browser.**

Two key differences to remember first:

- **Chromium browsers (first four rows) select the folder; Firefox selects the file.** If you get a "manifest not found" error, this is why.
- **Only Chromium browsers need "Developer mode";** Firefox has no such toggle.

A browser extension doesn't work by "copying files somewhere" — the browser **points at** the folder. So the first task is giving it a **stable, permanent location**.

### 1.1 Put the folder somewhere permanent

**Move or copy** the whole `browser-extension` folder to a directory you won't delete or rename, for example:

```
D:\Softwares\Social-Favboard\browser-extension
```

> ⚠️ Don't leave it in the Downloads folder, and don't delete it later on a whim. The extension **runs by directly referencing this folder** — delete or rename the folder and the extension breaks. This is the most common beginner mistake.

> Firefox's temporary load also references this location, so the same rule applies (a temporary add-on dies on restart anyway, but deleting the folder while loaded breaks it immediately).

### 1.2 Load it (Edge as the example)

1. Open Edge, type `edge://extensions` in the address bar (Chrome: `chrome://extensions`, Brave: `brave://extensions`).
2. Turn on the **Developer mode** switch in the **bottom-left corner**. In Chrome it's in the **top-right**.
3. Click **Load unpacked** at the top.
4. In the picker window, find and select **the `browser-extension` folder itself**.

   It's the one inside the extracted top folder, next to `social-favboard`:

   ```
   Social-Favboard-main\           ← extracted top folder (don't select this)
   ├── browser-extension\          ← ✅ select this; inside you'll see manifest.json, content.js, popup.html
   ├── social-favboard\            ← ❌ don't select — this is the Obsidian plugin
   ├── README.md
   └── docs\
   ```

   Select the folder and click "Select folder" — installed. **Don't double-click in and pick `manifest.json`** — that's the Firefox way; on Chromium browsers selecting the file gives a "manifest not found" error.

Once installed, a card appears in the list: **Social Favboard**.

### 1.3 Pin it to the toolbar (Chromium browsers)

Click the **puzzle-piece icon** (top right) → find Social Favboard → click the **pin** next to it. The icon now lives on the toolbar, so you can click it anytime to see the status panel.

Firefox doesn't need pinning — the icon shows next to the address bar by default; if not, find the extension in `about:addons`.

---

## Step 1 (Firefox only): how to install on Firefox

> Only Firefox users need this section. Edge / Chrome / Brave and other Chromium browsers: just follow Step 1.

Firefox differs from the browsers above in three ways. Know them before doing anything.

**① Firefox does not allow permanently installing "unsigned" extensions.**
Not this project's fault — it's a hard Firefox rule. Pick one of three paths:

| Method | Permanent? | Best for |
|---|---|---|
| `about:debugging` temporary load | ❌ gone when the browser closes, must reload next time | trying it out yourself |
| AMO "self-distribution" signing into an `.xpi` | ✅ yes | distributing to others (see "Distributing to others" below) |
| Dev / Nightly + disabling signature check | ✅ yes, but requires a special browser build | long-term personal use without listing |

**② The loading method is different** (temporary load):

1. Type `about:debugging#/runtime/this-firefox` in the Firefox address bar;
2. Click **"Load Temporary Add-on…"**;
3. Select the **`manifest.json`** file inside the `browser-extension` folder (note: here you select the **file**, not the folder);
4. The extension appears in the list immediately, and the icon shows in the toolbar.

Unlike Edge, there is **no "Developer mode" switch**, and none is needed.

**③ You must grant all permissions, especially 127.0.0.1.**
After loading, Firefox asks for permissions, including "Access your data for 127.0.0.1" and a few site domains. **Grant all of them**, otherwise:

- Deny site domains → favorites lists can't be read; the icon never shows a number;
- Deny 127.0.0.1 → items are captured but never reach Obsidian; the icon shows an **orange backlog number** while the board stays empty.

To verify: click the extension icon and check the **"Local port"** row — it should show `127.0.0.1:27123`; a `—` means not connected.

> If permissions were denied, fix it here: `about:addons` → Social Favboard → **Permissions** tab → check the missing items. Temporarily loaded extensions must be re-authorized on every reload.

### Distributing to others (permanent install)

Official Firefox requires signing. Pack the `browser-extension` folder into a zip:

```
Zip all files INSIDE browser-extension (not the outer folder) → rename to xxx.xpi
```

Then upload it at the [addons.mozilla.org](https://addons.mozilla.org) developer hub and choose "self-distribution (unlisted)" — **signing is free, and you get a signed `.xpi` without listing it publicly**. Users drag the `.xpi` into Firefox for a permanent install. Review usually takes minutes to a day.

> Way around signing for personal testing only: install **Firefox Developer Edition** or **Nightly**, and set `xpinstall.signatures.required` to `false` in `about:config`. Does not work on regular Firefox.

### Compatibility note (author's remark)

The extension manifest declares both background script forms at once:

```json
"background": { "service_worker": "background.js", "scripts": ["background.js"] }
```

Chrome only reads `service_worker`, Firefox only reads `scripts`; each ignores the other's entry, so the same code runs on both. `strict_min_version` is set to 128 because page-context injection uses `world: "MAIN"` (supported since Firefox 128).

---

## Step 2: Install the Obsidian plugin

This step is **copying files**: put the whole `social-favboard` folder into your vault's plugin directory.

### 2.1 Find the vault's plugin directory

Inside your Obsidian vault folder there's a `.obsidian` folder (hidden by default — see the tip below), which contains a `plugins` subfolder. The target path looks like:

```
<your vault>\.obsidian\plugins\
```

> Can't find `.obsidian`? It's a hidden folder starting with a dot.
> Windows: in File Explorer, **View → Show → Hidden items**.

### 2.2 Copy it in

Copy the entire extracted **`social-favboard` folder** into that `plugins` directory, ending up with:

```
<your vault>\.obsidian\plugins\social-favboard\
├── main.js
├── manifest.json
└── styles.css
```

**Copy the whole folder level** — all three files must go in together; missing one breaks it. If you copied files loose into `plugins\` (i.e. `plugins\main.js`), that's wrong; it must be `plugins\social-favboard\main.js`.

### 2.3 Enable it in Obsidian

1. Open Obsidian → Settings (gear, bottom-left) → **Community plugins**.
2. If prompted about Restricted mode, click **Turn off Restricted mode and enable plugins**.
3. Find **Social Favboard** under Installed plugins and toggle it on.

---

## Step 3: First-time configuration (once only)

In Obsidian: **Settings → Social Favboard**, going top to bottom:

| Setting | Suggestion |
|---|---|
| Connection status | "Connected" means good. If not, click "Restart local port" once |
| Target canvas | A **relative path**, e.g. `favorites/my-board.canvas` (missing folders are created automatically). **Never an absolute `C:\...` path** |
| Auto-write on receive | Recommended on — scroll the page and cards appear automatically |
| Skip already-saved items | Recommended on, prevents duplicate cards |

Nothing to configure on the browser side — the extension finds and pairs with the Obsidian plugin automatically.

---

## Step 4: Verify

1. Open Xiaohongshu "Profile → Collected" (or Douyin "Likes / Collections", or a Bilibili favorites folder).
2. **Scroll down slowly** so the list loads new content.
3. Watch the extension icon on the browser toolbar:
   - No number → normal, data already went into Obsidian;
   - An **orange number** → items captured but not delivered; opening Obsidian auto-delivers them;
   - Gray `OFF` → paused; click the big button in the extension popup to resume.
4. Back in Obsidian, cards appear in the empty space to the right of existing content — **drag them wherever you like**.

---

## The 7 most common mistakes

| Symptom | Cause |
|---|---|
| "Manifest not found" when loading the extension | Wrong selection: picked `social-favboard` (that's the Obsidian plugin) or the top-level folder. Chromium browsers need the `browser-extension` **folder**; Firefox needs the `manifest.json` **file** inside it |
| Extension suddenly dies days later | The `browser-extension` folder was moved / renamed / deleted. Put it back in its permanent spot and reload once from `edge://extensions` |
| Extension gone after Firefox restarts | Normal. Temporary add-ons don't persist; repeat the `about:debugging` load |
| Board stays empty | "Target canvas" is empty or an absolute path; or Obsidian isn't even open (the orange icon number hints at this) |
| Orange number on the icon that never clears | Data captured but not delivered. Check Obsidian is running and the plugin enabled; on Firefox also check the **127.0.0.1** permission was granted |
| Can't find the `.obsidian` folder | It's hidden — see Step 2.1 for how to show it |
| Clicking the extension icon does nothing | Icon isn't pinned. Edge/Chrome: find it under the puzzle icon (Step 1.3); Firefox: use "Options" in `about:addons` |

---

## How to update later

When a new version is out, download the new ZIP from GitHub (Code → Download ZIP), then:

- **Browser extension (Edge / Chrome, etc.)**: overwrite the files in your permanent `browser-extension` folder with the new ones, then click the **refresh arrow** on the extension card in `edge://extensions`, and **refresh (F5) every open** Douyin / Bilibili / Xiaohongshu tab.
- **Browser extension (Firefox)**: overwrite the files the same way, then in `about:debugging#/runtime/this-firefox` click **"Reload"**, then refresh tabs. Note that **permissions must be granted again** after reloading.
- **Obsidian plugin**: overwrite the files in `.obsidian\plugins\social-favboard\`, then toggle the plugin off and on in Obsidian.

> **Why F5-refresh pages after every update?** The extension's page scripts only run on newly opened pages. Skip the refresh and open tabs keep running old code — "I updated but nothing changed" is almost always this. Closing and reopening tabs works too.

Your board and dedup records live in the vault; updates never lose them.
