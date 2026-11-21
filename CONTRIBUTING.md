# Contributing to Social Favboard / 贡献指南

**简体中文 + English**

感谢你愿意为这个项目添砖加瓦。下面几条规矩不长，读完再动手能省大家的时间。

Thanks for wanting to contribute. The rules below are short — a minute of reading saves both of us time.

---

## 三条铁律 / The Three Iron Rules

任何新代码，无论加什么平台、改什么功能，都不得违反：

No new code, whatever platform or feature it touches, may violate:

1. **扩展绝不主动发请求**——只旁听页面自己发出的接口响应 + 扫描页面已渲染的 DOM；不调平台私有接口、不逆向签名、不模拟点击。
   **The extension never sends its own requests** — it only listens to responses the page itself made and scans the already-rendered DOM. No private APIs, no signature reversing, no simulated clicks.
2. **不碰登录态**——cookie / token 一律不存储、不传输（页面响应里自带的临时令牌除外，那是页面自己给的）。
   **Never touch login states** — no storing or transmitting cookies/tokens (temporary tokens already present in page responses are the exception; the page provided them).
3. **全部本地运行**——扩展与插件之间只通过 `127.0.0.1` 通信，无任何服务器，不上传任何数据。
   **Everything stays local** — extension and plugin talk only over `127.0.0.1`; no servers, no uploads.

违反任一条的 PR 会被直接关闭，不做讨论。

PRs violating any of these will be closed without discussion.

---

## 加新平台的接入点 / Adding a new platform

改动集中在 `browser-extension/content.js`，四处：

Changes concentrate in `browser-extension/content.js`, four spots:

1. **平台识别**：`PLAT` 映射表，按域名认平台；
   **Platform detection**: the `PLAT` map, matched by domain;
2. **页面白名单**：只放行该平台的收藏/喜欢列表页，其余一律不采；
   **Page whitelist**: only the platform's favorites/likes list pages — nothing else;
3. **数据解析**：接口响应解析（主路）+ DOM 扫描选择器（兜底）；
   **Data parsing**: API response parsing (primary) + DOM scan selectors (fallback);
4. **链接生成**：该平台的原帖链接格式。
   **Link generation**: the platform's original-post URL format.

Obsidian 插件（`social-favboard/`）一般不用动，它不关心内容来自哪个平台。

The Obsidian plugin (`social-favboard/`) usually needs no changes — it doesn't care where content came from.

---

## 提交前检查 / Before you open a PR

```bash
npm test        # 必须全绿 / must be all green
```

- [ ] 测试全部通过 / All tests pass
- [ ] 没有引入任何新依赖、构建步骤或网络请求 / No new dependencies, build steps, or network requests
- [ ] 没有改动 `LICENSE` 与作者署名（DajiaoFish, MIT）/ `LICENSE` and authorship untouched
- [ ] 新平台的说明已补进 README 与使用文档 / Docs updated for the new platform
- [ ] 卡片文案风格与现有平台一致（标题 / 作者 / 收录日期 / 原链接）/ Card text matches the existing format

## 流程 / Process

1. Fork 本仓库 → 新建分支 → 改代码 → `npm test` → 提交 PR
   Fork this repo → new branch → code → `npm test` → open the PR
2. PR 描述里写清楚：目标平台、白名单页面、测试方式（怎么验证你能抓到列表）
   In the PR description, state: target platform, whitelisted pages, and how you verified capture works
3. 维护者审核通过后合并；不合符铁律或测试不过的会说明原因
   The maintainer reviews and merges; rejected PRs get a reason

## 许可 / License

提交即表示你同意你的贡献以 [MIT](LICENSE) 协议发布，版权归项目所有。
By submitting, you agree your contribution is released under the [MIT](LICENSE) license.
