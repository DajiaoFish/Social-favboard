/**
 * content.js —— 运行在扩展隔离世界
 *
 * 两条数据来源合并去重：
 *   1. 接收 inject.js 从页面主世界转来的接口响应（信息最全）
 *   2. 直接扫已渲染卡片的 DOM（钩子失效时兜底）
 *
 * 全程只读，不发起任何面向平台的请求。
 */
(function () {
  'use strict';
  if (window.__sfbContentReady) return;
  window.__sfbContentReady = true;

  const host = location.hostname;
  let PLAT = null;
  if (/douyin\.com$/i.test(host)) PLAT = 'douyin';
  else if (/bilibili\.com$/i.test(host)) PLAT = 'bilibili';
  else if (/xiaohongshu\.com$/i.test(host)) PLAT = 'xhs';
  if (!PLAT) return;

  const LINK_PATTERNS = {
    douyin: /\/(?:video|note|slides)\/(\d{15,25})/,
    bilibili: /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i,
    xhs: /\/(?:explore|discovery\/item)\/([0-9a-f]{16,32})/,
  };

  const COVER_HOSTS = {
    douyin: /(douyinpic|byteimg|aweme|douyin\.com)/i,
    bilibili: /(hdslb|bilibili)/i,
    xhs: /(xhscdn|xiaohongshu)/i,
  };

  /* 无意义标题黑名单：图片 alt 常是 "icon" 这类占位文本 */
  const JUNK_TITLE = /^(icon|图标|头像|avatar|封面|cover|logo|placeholder|img|image|图片|视频|video|直播中|live)$/i;
  /* 平台占位声明（被删除/屏蔽视频的标题就是这段举报页脚），收进来全是垃圾卡 */
  const JUNK_HINT = /违法和不良信息举报|专项举报|算法推荐|网络文化经营许可证|京网文|[\w.+-]+@(?:douyin|bytedance|bilibili|xiaohongshu)\.com|400-\d{3,4}-\d{3,4}/i;

  function isJunkTitle(t) {
    const s = String(t || '').trim();
    if (s.length < 2) return true;
    /* 结构化判定：占位页脚一律是「｜ 某某许可证/声明 ｜」的包裹格式 */
    if (/^[｜|].+[｜|]$/.test(s)) return true;
    return JUNK_TITLE.test(s) || JUNK_HINT.test(s);
  }

  /* DOM 扫描只在「收藏 / 喜欢」这类页面上进行。
     首页、播放页、搜索页一律不扫——那里的视频链接是推荐流和评论区，
     不是你的收藏，扫进来全是垃圾数据。 */
  const PAGE_OK = {
    douyin: () => /^\/user\//i.test(location.pathname || ''),
    bilibili: () => /favlist|medialist/i.test(location.pathname || ''),
    xhs: () => /\/user\/profile|collected|favorite|liked/i.test(location.pathname || ''),
  };

  const seen = new Set();
  const pending = new Map();

  /* 总开关：paused = true 时彻底停止抓取（不扫描、不接收、不发送） */
  let paused = false;

  function makeUrl(id) {
    if (PLAT === 'douyin') return `https://www.douyin.com/video/${id}`;
    if (PLAT === 'bilibili') return id.startsWith('av') ? `https://www.bilibili.com/video/${id}` : `https://www.bilibili.com/video/${id}`;
    return `https://www.xiaohongshu.com/explore/${id}`;
  }

  /* 小红书 2024 底起，笔记页必须带 xsec_token 才能打开，
     否则就是「当前笔记暂时无法浏览，请打开小红书App扫码查看」。
     token 就在页面自己的数据里：接口响应的字段、或卡片 <a> 的 href 参数。
     优先用现成 href，其次用响应里的 token 拼接，都没有才退回裸链接。
     全程不额外发请求。 */
  function xhsUrl(id, href, token, source) {
    if (href && /xsec_token=/i.test(href)) return href;
    if (token) {
      return `https://www.xiaohongshu.com/explore/${id}?xsec_token=${encodeURIComponent(token)}&xsec_source=${source || 'pc_user'}`;
    }
    return `https://www.xiaohongshu.com/explore/${id}`;
  }

  /* 页面卡片链接上没有 token（实测 41 条全是裸链接），
     token 只出现在接口响应的数据里。这里对转来的响应做一次通用扫描：
     任何一层对象只要同时有 note_id/id 和 xsec_token，就记下来备用。
     只读内存里的数据，不发请求。 */
  const tokenMap = new Map();

  function harvestTokens(node, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 10) return;
    if (Array.isArray(node)) {
      for (const c of node) harvestTokens(c, (depth || 0) + 1);
      return;
    }
    const tok = node.xsec_token;
    if (typeof tok === 'string' && tok.length > 6) {
      const id = node.note_id || node.id;
      if (typeof id === 'string' && /^[0-9a-f]{16,32}$/i.test(id) && !tokenMap.has(id)) {
        tokenMap.set(id, tok);
        if (tokenMap.size > 5000) {
          tokenMap.delete(tokenMap.keys().next().value);
        }
      }
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') harvestTokens(v, (depth || 0) + 1);
    }
  }

  /* 从地址栏里捞 token：/explore/<id>?xsec_token=... */
  function harvestNav(href) {
    const m = String(href || '').match(/\/explore\/([0-9a-f]{16,32})[^#]*[?&]xsec_token=([^&#]+)/i);
    if (!m) return false;
    let tok = m[2];
    try {
      tok = decodeURIComponent(tok);
    } catch (e) {
      /* 用原值 */
    }
    if (tokenMap.get(m[1]) !== tok) {
      tokenMap.set(m[1], tok);
      return true;
    }
    return false;
  }

  /* 给还没 token 的待发送条目补上（来自接口数据的那份） */
  function applyTokens() {
    let changed = false;
    for (const it of pending.values()) {
      if (it.platform === 'xhs' && !hasToken(it.url)) {
        const tok = tokenMap.get(it.id);
        if (tok) {
          it.url = xhsUrl(it.id, '', tok, 'pc_user');
          changed = true;
        }
      }
    }
    if (changed) scheduleFlush();
  }

  function hasToken(u) {
    return /xsec_token=/i.test(String(u || ''));
  }

  function add(item) {
    if (paused) return false;
    if (!item || !item.id) return false;

    const prev = pending.get(item.id);
    if (prev) {
      /* 同一个 id 可能先被接口抓到（那时没有 xsec_token），后被 DOM 抓到（href 里带 token）。
         这里用后来的信息补齐，避免先到的那条把更好的链接挡掉。 */
      let better = false;
      if (hasToken(item.url) && !hasToken(prev.url)) {
        prev.url = item.url;
        better = true;
      }
      if (!prev.title && item.title) {
        prev.title = item.title;
        better = true;
      }
      if (!prev.cover && item.cover) {
        prev.cover = item.cover;
        better = true;
      }
      if (!prev.author && item.author) {
        prev.author = item.author;
        better = true;
      }
      if (better) scheduleFlush();
      return false;
    }

    if (seen.has(item.id)) return false;
    seen.add(item.id);
    /* 收录时间：抓到的这一刻，卡片上显示到「日」 */
    if (!item.at) item.at = Date.now();
    pending.set(item.id, item);
    return true;
  }

  /* =======================================================
   * 一、接口响应 → 卡片
   * ======================================================= */
  function parsePayload(url, d) {
    const out = [];
    try {
      if (/aweme\/v1\/web\/aweme\/(favorite|collection)/i.test(url)) {
        const list = d.aweme_list || (d.data && d.data.aweme_list) || [];
        for (const it of list) {
          if (!it || !it.aweme_id) continue;
          const v = it.video || {};
          const coverList =
            (v.cover && v.cover.url_list) ||
            (v.origin_cover && v.origin_cover.url_list) ||
            (v.dynamic_cover && v.dynamic_cover.url_list) ||
            [];
          out.push({
            id: String(it.aweme_id),
            platform: 'douyin',
            title: String(it.desc || '').replace(/\s+/g, ' ').trim().slice(0, 300),
            author: (it.author && it.author.nickname) || '',
            cover: coverList.length ? String(coverList[coverList.length - 1]).replace(/^http:/, 'https:') : '',
            url: `https://www.douyin.com/video/${it.aweme_id}`,
            duration: v.duration ? Math.round(v.duration / 1000) : 0,
            tags: (String(it.desc || '').match(/#[^\s#]+/g) || []).map((s) => s.slice(1)).slice(0, 10),
          });
        }
      } else if (/fav\/resource\/list/i.test(url)) {
        const dd = d.data || d;
        const list = dd.medias || [];
        for (const it of list) {
          if (!it || !it.bvid) continue;
          out.push({
            id: String(it.bvid),
            platform: 'bilibili',
            title: String(it.title || '').trim().slice(0, 300),
            author: (it.upper && it.upper.name) || '',
            cover: String(it.cover || '').replace(/^http:/, 'https:'),
            url: `https://www.bilibili.com/video/${it.bvid}`,
            duration: Number(it.duration) || 0,
            tags: [].concat(it.tags || it.tag_list || []).map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean).slice(0, 10),
          });
        }
      } else if (/note\/user_posted|user\/(collected|liked)|note\/feed|liked_list|collect_list|collected|liked/i.test(url)) {
        const dd = d.data || d;
        const list = dd.notes || dd.items || [];
        for (const it of list) {
          if (!it) continue;
          const id = it.note_id || it.id;
          if (!id) continue;
          const cover =
            (it.cover && (it.cover.url_default || it.cover.url_pre || it.cover.url)) ||
            (Array.isArray(it.image_list) && it.image_list[0] && it.image_list[0].url_default) ||
            '';
          const token =
            it.xsec_token ||
            (it.note_card && it.note_card.xsec_token) ||
            tokenMap.get(String(id)) ||
            '';
          const source = /collect/i.test(url) ? 'pc_collect' : 'pc_user';
          out.push({
            id: String(id),
            platform: 'xhs',
            title: String(it.display_title || it.title || '').trim().slice(0, 300),
            author: (it.user && it.user.nickname) || '',
            cover: String(cover).replace(/^http:/, 'https:'),
            url: xhsUrl(String(id), '', token, source),
            duration: 0,
            tags: [].concat((it.note_card && it.note_card.tag_list) || it.tag_list || it.tags || []).map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean).slice(0, 10),
          });
        }
      }
    } catch (e) {
      /* 单条格式异常不影响其它 */
    }
    return out;
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.__sfbBridge !== 1) return;

    if (m.nav) {
      if (harvestNav(m.nav)) applyTokens();
      return;
    }

    harvestTokens(m.d);
    const items = parsePayload(m.u || '', m.d);
    applyTokens();
    if (!items.length) return;
    let n = 0;
    for (const it of items) if (add(it)) n++;
    if (n) scheduleFlush();
  });

  /* =======================================================
   * 二、DOM 兜底扫描
   * ======================================================= */
  function climb(node, maxUp) {
    let cur = node;
    for (let i = 0; i < maxUp && cur; i++) {
      if (cur.querySelector && cur.querySelector('img')) return cur;
      cur = cur.parentElement;
    }
    return (node && node.parentElement) || node;
  }

  function pickImage(box, plat) {
    if (!box) return null;
    const imgs = box.querySelectorAll('img');
    const hostRe = COVER_HOSTS[plat];
    let best = null;
    let bestScore = -1;

    for (const img of imgs) {
      const src = img.currentSrc || img.src || '';
      if (!src || src.startsWith('data:')) continue;
      /* 跳过头像/图标类图片，它们的 alt 几乎都是 "icon" */
      if (/avatar|头像|icon/i.test(img.className || '')) continue;
      const w = img.naturalWidth || img.clientWidth || 0;
      const h = img.naturalHeight || img.clientHeight || 0;
      let score = w * h;
      if (hostRe.test(src)) score += 1e9;
      if (score > bestScore) {
        best = img;
        bestScore = score;
      }
    }
    return best;
  }

  function pickTitle(a, box, img) {
    const candidates = [];

    if (img && img.alt) candidates.push(img.alt);

    if (box) {
      const t = box.querySelector('[class*="title"],[class*="desc"],[class*="caption"]');
      if (t && t.textContent) candidates.push(t.textContent);
    }
    if (a.title) candidates.push(a.title);
    const aria = a.getAttribute('aria-label');
    if (aria) candidates.push(aria);
    if (box) {
      const lines = (box.innerText || '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && s.length < 200)
        .sort((x, y) => y.length - x.length);
      candidates.push.apply(candidates, lines);
    }

    /* 逐个候选挑，跳过 "icon" 这类占位文本 */
    for (const c of candidates) {
      const s = String(c || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!isJunkTitle(s)) return s;
    }
    return '';
  }

  function pickAuthor(box) {
    if (!box) return '';
    const el = box.querySelector('[class*="author"],[class*="up-name"],[class*="nickname"],[class*="username"]');
    if (el && el.textContent) {
      const t = el.textContent.trim();
      if (t && t.length < 40) return t;
    }
    const lines = (box.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const t of lines) {
      if (/^@/.test(t)) return t.replace(/^@/, '').slice(0, 40);
    }
    return '';
  }

  function scanDom() {
    const re = LINK_PATTERNS[PLAT];
    if (!re) return 0;

    const pageOk = PAGE_OK[PLAT];
    if (pageOk && !pageOk()) return 0;

    const anchors = document.querySelectorAll('a[href]');
    let added = 0;

    for (const a of anchors) {
      let href = '';
      try {
        href = a.href || '';
      } catch (e) {
        continue;
      }
      const m = href.match(re);
      if (!m) continue;

      const id = m[1];
      if (!id || seen.has(id)) continue;

      const box = climb(a, 6);
      const img = pickImage(box, PLAT);
      const title = pickTitle(a, box, img);

      /* 标题是 "icon" 这类占位文本 → 大概率不是真视频卡片，丢弃 */
      if (isJunkTitle(title)) continue;

      const author = pickAuthor(box);

      if (add({
        id,
        platform: PLAT,
        title,
        author,
        cover: img ? (img.currentSrc || img.src || '') : '',
        url: PLAT === 'xhs' ? xhsUrl(id, href, '', '') : makeUrl(id),
        duration: 0,
      })) {
        added++;
      }
    }
    return added;
  }

  /* =======================================================
   * 三、节流调度
   * ======================================================= */
  let scanTimer = null;
  let flushTimer = null;
  let tickTimer = null;
  let mo = null;

  function scheduleScan() {
    if (paused || scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      const n = scanDom();
      if (n) scheduleFlush();
    }, 900);
  }

  function scheduleFlush() {
    if (paused) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 2600);
  }

  /* 小红书 token 最可靠的来源是页面里卡片的 <a href>。
     发送前统一给还没有 token 的条目补一次，只读当前 DOM，不发任何请求。 */
  function repairXhsUrls(items) {
    if (PLAT !== 'xhs') return;

    /* 第一优先：接口响应里收来的 token */
    for (const it of items) {
      if (it.platform === 'xhs' && !hasToken(it.url)) {
        const tok = tokenMap.get(it.id);
        if (tok) it.url = xhsUrl(it.id, '', tok, 'pc_user');
      }
    }

    /* 第二优先：页面卡片 href（实测这个页面上没有，留作兜底） */
    const need = items.filter(function (it) {
      return it.platform === 'xhs' && !hasToken(it.url);
    });
    if (!need.length) return;

    const map = new Map();
    try {
      const anchors = document.querySelectorAll('a[href]');
      for (const a of anchors) {
        const href = a.href || '';
        if (!hasToken(href)) continue;
        const m = href.match(LINK_PATTERNS.xhs);
        if (m && m[1] && !map.has(m[1])) map.set(m[1], href);
      }
    } catch (e) {
      return;
    }

    for (const it of need) {
      const href = map.get(it.id);
      if (href) it.url = href;
    }
  }

  function flush() {
    if (!pending.size) return;
    const items = Array.from(pending.values()).slice(0, 200);
    repairXhsUrls(items);
    try {
      chrome.runtime.sendMessage({ type: 'sfb-items', items: items }, function (res) {
        if (chrome.runtime.lastError) return;
        if (res && res.ok) {
          for (const it of items) pending.delete(it.id);
        }
      });
    } catch (e) {
      /* 扩展上下文失效（比如刚更新），忽略 */
    }
  }

  function boot() {
    if (tickTimer) return;
    /* 直接打开带 token 的笔记地址时，先把地址里的 token 记下来 */
    try {
      harvestNav(location.href);
    } catch (e) {
      /* ignore */
    }
    scheduleScan();
    try {
      if (!mo) {
        mo = new MutationObserver(function () {
          scheduleScan();
        });
        mo.observe(document.body, { childList: true, subtree: true });
      }
    } catch (e) {
      /* body 还没准备好 */
    }
    // 兜底：定时全扫一次
    tickTimer = setInterval(scheduleScan, 12000);
  }

  /* 彻底停下：清掉所有定时器、断开 DOM 监听 */
  function halt() {
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (mo) {
      try {
        mo.disconnect();
      } catch (e) {
        /* 忽略 */
      }
      mo = null;
    }
  }

  /* 暂停 / 恢复。互斥且幂等，重复调用不会产生副作用。 */
  function applyPause(p) {
    p = !!p;
    if (p === paused) return;
    paused = p;
    if (paused) {
      flush(); // 已抓到手的先送出去，不丢数据
      halt();
    } else {
      boot();
    }
    updateBadge();
  }

  /* 标签页标题旁边挂个记号，不看弹窗也知道停没停 */
  function updateBadge() {
    try {
      chrome.runtime.sendMessage({ type: 'sfb-badge', paused: paused });
    } catch (e) {
      /* 扩展上下文失效，忽略 */
    }
  }

  /* 从共享存储读开关状态，并跟随变化（所有标签页立即同步） */
  function watchPause() {
    try {
      chrome.storage.local.get({ sfbPaused: false }, function (v) {
        const p = !!(v && v.sfbPaused);
        if (p) {
          paused = true;
          updateBadge();
        } else {
          boot();
        }
      });
      chrome.storage.onChanged.addListener(function (ch, area) {
        if (area !== 'local' || !ch || !ch.sfbPaused) return;
        applyPause(ch.sfbPaused.newValue);
      });
    } catch (e) {
      /* 没有 chrome API（比如测试环境），直接按开启处理 */
      boot();
    }
  }

  // 调试出口：方便在控制台核对解析结果，也用于自动化测试
  window.__sfbTest = {
    parsePayload,
    pickTitle,
    pickAuthor,
    pickImage,
    makeUrl,
    xhsUrl,
    hasToken,
    repairXhsUrls,
    harvestTokens,
    harvestNav,
    tokenMap,
    pending,
    isJunkTitle,
    scanDom,
    PAGE_OK,
    add,
    setPaused: function (p) {
      paused = !!p;
    },
    isPaused: function () {
      return paused;
    },
  };

  if (document.body) watchPause();
  else document.addEventListener('DOMContentLoaded', watchPause, { once: true });
})();
