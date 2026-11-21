# Contributing to Social Favboard

[中文指南](CONTRIBUTING.zh-CN.md) | **English**

Thanks for wanting to contribute. The rules below are short — a minute of reading saves both of us time.

---

## The Three Iron Rules

No new code, whatever platform or feature it touches, may violate:

1. **The extension never sends its own requests** — it only listens to responses the page itself made and scans the already-rendered DOM. No private APIs, no signature reversing, no simulated clicks.
2. **Never touch login states** — no storing or transmitting cookies/tokens (temporary tokens already present in page responses are the exception; the page provided them).
3. **Everything stays local** — extension and plugin talk only over `127.0.0.1`; no servers, no uploads.

PRs violating any of these will be closed without discussion.

---

## Adding a new platform

Changes concentrate in `browser-extension/content.js`, four spots:

1. **Platform detection**: the `PLAT` map, matched by domain;
2. **Page whitelist**: only the platform's favorites/likes list pages — nothing else;
3. **Data parsing**: API response parsing (primary) + DOM scan selectors (fallback);
4. **Link generation**: the platform's original-post URL format.

The Obsidian plugin (`social-favboard/`) usually needs no changes — it doesn't care where content came from.

---

## Before you open a PR

```bash
npm test        # must be all green
```

- [ ] All tests pass
- [ ] No new dependencies, build steps, or network requests
- [ ] `LICENSE` and authorship untouched (DajiaoFish, MIT)
- [ ] Docs updated for the new platform
- [ ] Card text matches the existing format (title / author / saved date / original link)

## Process

1. Fork this repo → new branch → code → `npm test` → open the PR
2. In the PR description, state: target platform, whitelisted pages, and how you verified capture works
3. The maintainer reviews and merges; rejected PRs get a reason

## License

By submitting, you agree your contribution is released under the [MIT](LICENSE) license.
