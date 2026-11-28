'use strict';

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  Notice,
  requestUrl,
  normalizePath,
} = require('obsidian');

/* 界面语言：跟随 Obsidian 的语言设置（中文界面 → 中文，其余 → 英文） */
function detectZhLocale() {
  try {
    const raw =
      (typeof window !== 'undefined' &&
        window.localStorage &&
        window.localStorage.getItem('language')) ||
      (typeof navigator !== 'undefined' && navigator.language) ||
      'en';
    return String(raw).toLowerCase().startsWith('zh');
  } catch (e) {
    return false;
  }
}
let UI_ZH = detectZhLocale();
const T = (zh, en) => (UI_ZH ? zh : en);

/* =========================================================
 * Node 内置 http（桌面版可用）
 * ========================================================= */
let nodeHttp = null;
try {
  nodeHttp = require('http');
} catch (e) {
  /* ignore */
}
if (!nodeHttp) {
  try {
    nodeHttp = window.require && window.require('http');
  } catch (e) {
    /* ignore */
  }
}

/* =========================================================
 * Node 内置 fs / path（用于导入 Skill 生成的完整白板）
 * ========================================================= */
let nodeFs = null;
let nodePath = null;
try {
  nodeFs = require('fs');
  nodePath = require('path');
} catch (e) {
  /* ignore */
}
if (!nodeFs || !nodePath) {
  try {
    nodeFs = (window.require && window.require('fs')) || nodeFs;
    nodePath = (window.require && window.require('path')) || nodePath;
  } catch (e) {
    /* ignore */
  }
}

/* =========================================================
 * 常量
 * ========================================================= */
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const APP_TAG = 'social-favboard';
const PORT_RANGE = [27123, 27124, 27125, 27126, 27127, 27128];

const CANVAS_COLORS = [
  { v: '1', name: '红' },
  { v: '2', name: '橙' },
  { v: '3', name: '黄' },
  { v: '4', name: '绿' },
  { v: '5', name: '青' },
  { v: '6', name: '紫' },
];

const PLATFORM_LABEL = { douyin: '抖音', bilibili: 'B站', xhs: '小红书' };
const PLATFORM_REFERER = {
  douyin: 'https://www.douyin.com/',
  bilibili: 'https://www.bilibili.com/',
  xhs: 'https://www.xiaohongshu.com/',
};

const DEFAULT_SETTINGS = {
  topics: [{ id: 'topic_default', name: '未分类', color: '5' }],
  defaultTopicId: 'topic_default',
  /* 分类方式：manual 自己拖 / keyword 写入时按关键词归组 */
  classifyMode: 'manual',
  /* 规则：{ id, name, keywords: '美食,探店', color: '4', enabled: true } */
  classifyRules: [],
  /* 「其他」分组（没命中任何关键词的卡片）的颜色 */
  otherGroupColor: '5',
  targetCanvas: '',
  /* Skill 生成的白板文件（绝对路径），供“从 Skill 输出文件导入白板”命令使用 */
  importSource: '',
  /* 自动监控 Skill 输出文件，变化后自动写入默认白板 */
  autoImport: false,
  /* Skill 排版方式已移除，统一使用生成文件后导入 */
  coverFolder: 'video-covers',
  cardWidth: 340,
  maxPerRow: 4,
  gapX: 80,
  gapY: 90,
  textHeight: 176,
  batchLimit: 30,
  autoWrite: false,
  dedupe: true,
  bridgeToken: '',
  synced: { douyin: [], bilibili: [], xhs: [] },
};

/* =========================================================
 * 工具
 * ========================================================= */
function uid() {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 16; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把用户填的白板路径清洗成 vault 相对路径。
 * 常见误填：绝对路径（C:\Users\xx\Obsidian Vault\文件夹\a.canvas）
 * Obsidian 的 getAbstractFileByPath 只认相对路径，绝对路径一律找不到。
 */
function toVaultPath(raw, basePath) {
  let s = String(raw || '').trim().replace(/\\/g, '/');
  if (!s) return '';

  const base = String(basePath || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (base && s.toLowerCase().startsWith(base.toLowerCase() + '/')) {
    s = s.slice(base.length + 1);
  }

  s = s.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  return s;
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|#^\[\]\s]+/g, '_').slice(0, 60);
}

/* 从白板节点里认出「已经收过的内容」。
   两条线索都要看：
   - file 节点：封面文件名固定是 `<平台>-<id>.<扩展名>`
   - text 节点：卡片正文里带 `[▶ 打开原视频](链接)`
   只看文件名会漏掉没封面的卡片，只看链接会漏掉用户手工改过正文的卡片。 */
const ID_PATTERNS = [
  { platform: 'douyin', re: /douyin\.com\/video\/(\d{6,})/i, file: /^douyin-(.+)$/i },
  { platform: 'bilibili', re: /bilibili\.com\/video\/((?:BV|av)[0-9A-Za-z]+)/i, file: /^bilibili-(.+)$/i },
  { platform: 'xhs', re: /xiaohongshu\.com\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/i, file: /^xhs-(.+)$/i },
];

function extractIdsFromCanvas(json) {
  const out = { douyin: [], bilibili: [], xhs: [] };
  const seen = { douyin: new Set(), bilibili: new Set(), xhs: new Set() };
  const nodes = json && Array.isArray(json.nodes) ? json.nodes : [];

  const push = (platform, id) => {
    if (!id) return;
    const key = String(id).trim();
    if (!key || seen[platform].has(key)) return;
    seen[platform].add(key);
    out[platform].push(key);
  };

  for (const n of nodes) {
    if (!n) continue;

    // 1) 封面文件名
    const file = String(n.file || '');
    if (file) {
      const base = file.split('/').pop().replace(/\.[a-z0-9]+$/i, '');
      for (const p of ID_PATTERNS) {
        const m = base.match(p.file);
        if (m) {
          push(p.platform, m[1]);
          break;
        }
      }
    }

    // 2) 正文里的链接
    const text = String(n.text || '');
    if (text) {
      for (const p of ID_PATTERNS) {
        const m = text.match(p.re);
        if (m) push(p.platform, m[1]);
      }
    }
  }
  return out;
}

/**
 * 判断标题是否为无意义占位文本。
 * 抖音卡片图片的 alt 常是 "icon"，这类条目基本都是误抓的账号卡片/头像。
 */
const JUNK_TITLE_RE =
  /^(icon|图标|头像|avatar|封面|cover|logo|placeholder|img|image|图片|视频|video|直播中|live|抖音|哔哩哔哩|bilibili)$/i;

/**
 * 平台占位/声明类文本。喜欢列表里被删除或屏蔽的视频，接口会返回占位条目：
 * 标题是平台的举报声明页脚（8 个不同视频共用同一句），封面也拿不到，
 * 收进来全是又长又乱的纯文字卡 —— 直接当垃圾过滤。
 */
const JUNK_HINT_RE =
  /违法和不良信息举报|专项举报|算法推荐|网络文化经营许可证|京网文|[\w.+-]+@(?:douyin|bytedance|bilibili|xiaohongshu)\.com|400-\d{3,4}-\d{3,4}/i;

function isJunkTitle(t) {
  const s = String(t || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 2) return true;
  /* 结构化判定：占位页脚一律是「｜ 某某许可证/声明 ｜」的包裹格式，
   * 平台换文案也不怕 —— 整体被全角竖线包住直接判垃圾 */
  if (/^[｜|].+[｜|]$/.test(s)) return true;
  return JUNK_TITLE_RE.test(s) || JUNK_HINT_RE.test(s);
}

/**
 * 关键词规则 ---------------------------------------------------------------
 * 一条规则形如 { id, name: '美食', keywords: '探店,菜谱,好吃', color: '4' }，
 * 多个关键词用中英文逗号、分号、顿号、斜杠或空格分隔。
 */
function splitKeywords(s) {
  return String(s || '')
    .split(/[,，;；、|/\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function getActiveRules(settings) {
  return (settings.classifyRules || []).filter((r) => r && String(r.name || '').trim() && r.enabled !== false);
}

/**
 * 标题优先、正文（标题+作者）其次，命中即止。
 * 返回命中的规则，没命中返回 null。
 */
function matchRule(card, rules) {
  const title = String(card.title || '').toLowerCase();
  const body = (title + ' ' + String(card.author || '') + ' ' + String(card.text || '')).toLowerCase();
  for (const r of rules) {
    const kws = splitKeywords(r.keywords).map((k) => k.toLowerCase());
    if (!kws.length) continue;
    if (kws.some((k) => title.includes(k))) return r;
  }
  for (const r of rules) {
    const kws = splitKeywords(r.keywords).map((k) => k.toLowerCase());
    if (!kws.length) continue;
    if (kws.some((k) => body.includes(k))) return r;
  }
  return null;
}

/** 从卡片正文里取标题（第一行 **粗体**） */
function cardTitleOf(text) {
  const s = String(text || '');
  const m = /^\s*\*\*(.+?)\*\*/m.exec(s);
  if (m) return m[1].trim();
  const line = s.split('\n').find((x) => x.trim());
  return (line || '').trim();
}

/**
 * 时间戳 → 本地日期字符串（精确到日）。
 * 拿不到或数值异常就返回空串，调用处直接跳过，不显示「收录 undefined」。
 */
function fmtDay(ts) {
  const n = Number(ts);
  if (!n || !isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  const p = (x) => (x < 10 ? '0' + x : String(x));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDuration(sec) {
  const n = Number(sec);
  if (!n || n <= 0) return '';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function imageSize(buffer) {
  try {
    const v = new DataView(buffer);
    if (v.byteLength < 16) return null;
    const b0 = v.getUint8(0);
    const b1 = v.getUint8(1);

    if (b0 === 0x89 && b1 === 0x50) return { w: v.getUint32(16), h: v.getUint32(20) };

    if (b0 === 0xff && b1 === 0xd8) {
      let i = 2;
      while (i < v.byteLength - 9) {
        if (v.getUint8(i) !== 0xff) {
          i++;
          continue;
        }
        const marker = v.getUint8(i + 1);
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = v.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: v.getUint16(i + 7), h: v.getUint16(i + 5) };
        }
        i += 2 + len;
      }
      return null;
    }

    if (b0 === 0x47 && b1 === 0x49) return { w: v.getUint16(6, true), h: v.getUint16(8, true) };

    if (b0 === 0x52 && b1 === 0x49) {
      const type = String.fromCharCode(v.getUint8(12), v.getUint8(13), v.getUint8(14), v.getUint8(15));
      if (type === 'VP8 ') {
        for (let i = 20; i < v.byteLength - 8; i++) {
          if (v.getUint8(i) === 0x9d && v.getUint8(i + 1) === 0x01 && v.getUint8(i + 2) === 0x2a) {
            return { w: v.getUint16(i + 3, true) & 0x3fff, h: v.getUint16(i + 5, true) & 0x3fff };
          }
        }
      } else if (type === 'VP8L') {
        const bits = v.getUint32(21, true);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      } else if (type === 'VP8X') {
        const w = v.getUint8(24) | (v.getUint8(25) << 8) | (v.getUint8(26) << 16);
        const h = v.getUint8(27) | (v.getUint8(28) << 8) | (v.getUint8(29) << 16);
        return { w: w + 1, h: h + 1 };
      }
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function guessExt(url, buffer) {
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'png';
  if (clean.endsWith('.webp')) return 'webp';
  if (clean.endsWith('.gif')) return 'gif';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'jpg';
  try {
    const v = new DataView(buffer);
    const b0 = v.getUint8(0);
    const b1 = v.getUint8(1);
    if (b0 === 0x89 && b1 === 0x50) return 'png';
    if (b0 === 0x47 && b1 === 0x49) return 'gif';
    if (b0 === 0x52 && b1 === 0x49) return 'webp';
  } catch (e) {
    /* ignore */
  }
  return 'jpg';
}

/* =========================================================
 * 白板
 * ========================================================= */
async function readCanvas(app, canvasPath) {
  const file = app.vault.getAbstractFileByPath(canvasPath);
  if (!file) return { nodes: [], edges: [] };
  try {
    const j = JSON.parse(await app.vault.read(file));
    return {
      nodes: Array.isArray(j.nodes) ? j.nodes : [],
      edges: Array.isArray(j.edges) ? j.edges : [],
    };
  } catch (e) {
    return { nodes: [], edges: [] };
  }
}

/**
 * 小红书的笔记链接要靠 xsec_token 才能打开，而 token 是临时的（会过期）。
 * 所以额外给一条「按标题搜索」的链接，这个长期有效，作为兜底入口。
 */
function xhsSearchUrl(title) {
  return 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(String(title || '').slice(0, 60));
}

function buildCardText(card, topic) {
  const label = PLATFORM_LABEL[card.platform] || '视频';
  const bits = [];
  if (card.author) bits.push(card.author);
  bits.push(label);
  if (card.duration) bits.push(fmtDuration(card.duration));

  const lines = [`**${card.title || '（无标题）'}**`, '', bits.join(' · ')];
  const day = fmtDay(card.at);
  if (day) lines.push(`收录 ${day}`);
  if (topic && topic.name) lines.push(`#${topic.name.replace(/\s+/g, '')}`);
  if (Array.isArray(card.tags) && card.tags.length) {
    lines.push(card.tags.slice(0, 10).map((t) => '#' + String(t).replace(/\s+/g, '')).join(' '));
  }
  const isXhs = card.platform === 'xhs';
  const hasTok = isXhs && /xsec_token=/i.test(card.url || '');
  if (isXhs && card.title) {
    if (hasTok) {
      lines.push('', `[▶ 打开原帖](${card.url})`, `[🔍 按标题搜索](${xhsSearchUrl(card.title)})`);
    } else {
      /*
       * 没带 xsec_token 的小红书裸链接必然跳到 404「笔记暂时无法浏览」，
       * 放上去只会让人反复点、以为坏了。宁可不给，直接给能用的搜索入口。
       */
      lines.push('', `[🔍 在小红书搜索这条](${xhsSearchUrl(card.title)})`);
    }
  } else {
    lines.push('', `[▶ 打开原视频](${card.url})`);
  }
  return lines.join('\n');
}

function buildNodes(existingNodes, cards, settings, topic) {
  const w = settings.cardWidth;
  const gapX = settings.gapX;
  const gapY = settings.gapY;
  const textH = settings.textHeight;
  const perRow = Math.max(1, settings.maxPerRow);

  let baseX = 0;
  let baseY = 0;
  if (existingNodes.length) {
    let maxRight = -Infinity;
    let minTop = Infinity;
    for (const n of existingNodes) {
      const right = (Number(n.x) || 0) + (Number(n.width) || 0);
      const top = Number(n.y) || 0;
      if (right > maxRight) maxRight = right;
      if (top < minTop) minTop = top;
    }
    baseX = (Number.isFinite(maxRight) ? maxRight : 0) + 200;
    baseY = Number.isFinite(minTop) ? minTop : 0;
  }

  const nodes = [];
  let col = 0;
  let rowY = baseY;
  let rowH = 0;

  for (const c of cards) {
    const x = baseX + col * (w + gapX);
    let imgH = 0;

    if (c.imagePath) {
      let aspect = 16 / 9;
      if (c.imageSize && c.imageSize.w > 0 && c.imageSize.h > 0) {
        aspect = c.imageSize.w / c.imageSize.h;
      }
      imgH = Math.round(w / aspect);
      imgH = Math.max(150, Math.min(540, imgH));

      nodes.push({ id: uid(), type: 'file', file: c.imagePath, x, y: rowY, width: w, height: imgH });
    }

    nodes.push({
      id: uid(),
      type: 'text',
      text: buildCardText(c, topic),
      x,
      y: rowY + (c.imagePath ? imgH + 10 : 0),
      width: w,
      height: textH,
      color: (topic && topic.color) || '5',
    });

    rowH = Math.max(rowH, imgH + 10 + textH);
    col++;
    if (col >= perRow) {
      col = 0;
      rowY += rowH + gapY;
      rowH = 0;
    }
  }
  return nodes;
}

async function appendNodes(app, canvasPath, newNodes) {
  const file = app.vault.getAbstractFileByPath(canvasPath);
  if (!file) throw new Error(`白板不存在：${canvasPath}`);

  const leaves = app.workspace.getLeavesOfType('canvas');
  for (const leaf of leaves) {
    const v = leaf.view;
    if (v && v.file && v.file.path === canvasPath && v.canvas && typeof v.canvas.importData === 'function') {
      v.canvas.importData({ nodes: newNodes, edges: [] }, false);
      await sleep(120);
      try {
        if (typeof v.canvas.requestSave === 'function') await v.canvas.requestSave();
      } catch (e) {
        /* ignore */
      }
      return 'live';
    }
  }

  const data = await readCanvas(app, canvasPath);
  data.nodes = data.nodes.concat(newNodes);
  await app.vault.modify(file, JSON.stringify(data, null, '\t'));
  return 'file';
}

/* =========================================================
 * 关键词分类 + 白板分组
 * ========================================================= */
/*
 * 卡片正文的「入口链接」就是身份标识。三种文案都要认：
 * 抖音 / B站 → [▶ 打开原视频]，小红书有 token → [▶ 打开原帖]，
 * 小红书没 token → [🔍 在小红书搜索这条]。
 * 早期只认第一种，导致小红书卡片整理时被当成「别人的节点」，原地不动。
 */
const CARD_MARKS = ['[▶ 打开原视频]', '[▶ 打开原帖]', '[🔍 在小红书搜索这条]'];
const CARD_LINK_RE = /\[[^\]]*\]\(https?:\/\/(?:www\.)?(?:douyin\.com|bilibili\.com|xiaohongshu\.com)\//i;

function isCardText(text) {
  const s = String(text || '');
  if (!s) return false;
  for (const m of CARD_MARKS) {
    if (s.indexOf(m) >= 0) return true;
  }
  /* 兜底：文案以后再改，只要有指向三个平台的链接就仍认得出 */
  return CARD_LINK_RE.test(s);
}
const GROUP_PAD = 40;
const GROUP_TOP = 76;

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d || 0;
}

function minLeftOf(nodes) {
  let m = Infinity;
  for (const n of nodes) m = Math.min(m, num(n.x));
  return Number.isFinite(m) ? m : 0;
}

function maxBottomOf(nodes) {
  let b = -Infinity;
  for (const n of nodes) b = Math.max(b, num(n.y) + num(n.height));
  return Number.isFinite(b) ? b : 0;
}

/**
 * 把节点拆成「卡片单元」：一张文字卡 + 它正上方的封面图。
 * 只认本插件生成的卡片（正文带「打开原视频」链接），用户自己画的节点不会被搬动。
 */
function collectUnits(nodes) {
  const texts = nodes.filter((n) => n.type === 'text' && isCardText(n.text));
  const files = nodes.filter((n) => n.type === 'file');
  const used = new Set();
  const units = [];

  for (const t of texts) {
    const tx = num(t.x);
    const ty = num(t.y);
    const tw = num(t.width);
    const th = num(t.height);

    let img = null;
    for (const f of files) {
      if (used.has(f.id)) continue;
      const fx = num(f.x);
      const fy = num(f.y);
      const fw = num(f.width);
      const fh = num(f.height);
      const gap = ty - (fy + fh);
      if (Math.abs(fx - tx) <= 8 && Math.abs(fw - tw) <= 8 && gap >= -6 && gap <= 60) {
        img = f;
        break;
      }
    }
    if (img) used.add(img.id);

    let left = tx;
    let top = ty;
    let right = tx + tw;
    let bottom = ty + th;
    if (img) {
      const ix = num(img.x);
      const iy = num(img.y);
      const iw = num(img.width);
      const ih = num(img.height);
      left = Math.min(left, ix);
      top = Math.min(top, iy);
      right = Math.max(right, ix + iw);
      bottom = Math.max(bottom, iy + ih);
    }

    units.push({
      nodes: img ? [img, t] : [t],
      x: left,
      y: top,
      w: right - left,
      h: bottom - top,
      text: t.text,
      title: cardTitleOf(t.text),
    });
  }
  return units;
}

/* ---- 占位与找空位 --------------------------------------------------
 * 排布的唯一原则：整块矩形拿去和「所有已有内容」逐个比对，空就算空。
 * 早期版本只看左右边界（maxRight / maxBottom），一旦别的卡片在中间，
 * 分组框就会被盖上去——现在统一走 findFreeArea。
 * ------------------------------------------------------------------ */

/** 把节点转成占位矩形（margin 是外扩的安全边距） */
function occupiedRects(nodes, margin) {
  const m = margin == null ? 16 : margin;
  const out = [];
  for (const n of nodes) {
    const w = num(n.width);
    const h = num(n.height);
    if (w <= 0 || h <= 0) continue;
    out.push({ x: num(n.x) - m, y: num(n.y) - m, w: w + m * 2, h: h + m * 2 });
  }
  return out;
}

function rectHits(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function rectFree(rect, areas) {
  for (const a of areas) {
    if (rectHits(rect, a)) return false;
  }
  return true;
}

/**
 * 找一块能整块放下的空地：从 (opt.x, opt.y) 起，同一行往右试，
 * 全行放不下就往下挪一整块再试。
 */
function findFreeArea(areas, w, h, opt) {
  const o = opt || {};
  const stepX = num(o.stepX, w + num(o.gapX, 80));
  const gapY = num(o.gapY, 120);
  const cols = Math.max(1, num(o.cols, 1));
  const startX = num(o.x);
  let y = num(o.y);
  for (let i = 0; i < 500; i++) {
    for (let c = 0; c < cols; c++) {
      const rect = { x: startX + c * stepX, y, w, h };
      if (rectFree(rect, areas)) return { x: rect.x, y: rect.y };
    }
    y += h + gapY;
  }
  return { x: startX, y };
}

/** 封面高度（按真实比例，夹在 150~540 之间） */
function cardImgH(card, w) {
  if (!card || !card.imagePath) return 0;
  let aspect = 16 / 9;
  if (card.imageSize && card.imageSize.w > 0 && card.imageSize.h > 0) aspect = card.imageSize.w / card.imageSize.h;
  return Math.max(150, Math.min(540, Math.round(w / aspect)));
}

/** 往 nodes 里放一张卡（封面 + 文字），返回它占的高度 */
function pushCardNodes(nodes, card, pos, settings, color) {
  const w = settings.cardWidth;
  const imgH = cardImgH(card, w);
  if (imgH) {
    nodes.push({ id: uid(), type: 'file', file: card.imagePath, x: pos.x, y: pos.y, width: w, height: imgH });
  }
  nodes.push({
    id: uid(),
    type: 'text',
    text: buildCardText(card, card._topic),
    x: pos.x,
    y: pos.y + (imgH ? imgH + 10 : 0),
    width: w,
    height: settings.textHeight,
    color: color || '5',
  });
  return imgH ? imgH + 10 + settings.textHeight : settings.textHeight;
}

/** 在分组框里找一个不压住任何卡片的空位（必要时往下长） */
function findFreeSlot(group, areas, w, h, opt) {
  const gx = num(group.x);
  const gy = num(group.y);
  const gw = num(group.width);
  const stepY = h + opt.gapY;
  for (let row = 0; row < 400; row++) {
    for (let col = 0; col < opt.perRow; col++) {
      const x = gx + opt.pad + col * (w + opt.gapX);
      const y = gy + opt.top + row * stepY;
      if (x + w > gx + gw - opt.pad) continue;
      if (rectFree({ x, y, w, h }, areas)) return { x, y };
    }
  }
  return { x: gx + opt.pad, y: gy + opt.top + 400 * stepY };
}

/**
 * 把一组单元按每行 perRow 排成矩形，坐标相对于组框左上角。
 * 返回每个单元的落点 + 整组需要的尺寸（这样框能一次算准，不用边长边猜）。
 */
function layoutUnits(items, settings) {
  const w = settings.cardWidth;
  const gapX = settings.gapX;
  const gapY = settings.gapY;
  const perRow = Math.max(1, settings.maxPerRow);
  const slots = [];
  let col = 0;
  let rowY = 0;
  let rowH = 0;
  let cols = 0;

  for (const it of items) {
    if (col >= perRow) {
      rowY += rowH + gapY;
      rowH = 0;
      col = 0;
    }
    slots.push({ item: it.item, h: it.h, x: col * (w + gapX), y: rowY });
    rowH = Math.max(rowH, it.h);
    col++;
    cols = Math.max(cols, col);
  }

  cols = Math.max(1, cols);
  return {
    slots,
    w: cols * w + (cols - 1) * gapX + GROUP_PAD * 2,
    h: GROUP_TOP + rowY + rowH + GROUP_PAD,
  };
}

/** 自动分类模式下的写入：按关键词塞进对应的分组框，没有就新建一个 */
function buildClassifiedNodes(existingNodes, cards, settings, rules) {
  const w = settings.cardWidth;
  const gapX = settings.gapX;
  const gapY = settings.gapY;
  const perRow = Math.max(1, settings.maxPerRow);
  const pad = GROUP_PAD;

  const nodes = existingNodes.slice();
  const groups = nodes.filter((n) => n.type === 'group');
  let newGroups = 0;

  /* 先把这一批按规则分堆，保持进来的顺序 */
  const order = [];
  const buckets = new Map();
  for (const c of cards) {
    const rule = matchRule(c, rules);
    const name = rule ? rule.name : '其他';
    const color = rule ? rule.color : settings.otherGroupColor || '5';
    c._topic = { name, color };
    if (!buckets.has(name)) {
      buckets.set(name, { name, color, cards: [] });
      order.push(name);
    }
    buckets.get(name).cards.push(c);
  }

  for (const name of order) {
    const b = buckets.get(name);
    const items = b.cards.map((c) => {
      const imgH = cardImgH(c, w);
      return { item: c, h: imgH ? imgH + 10 + settings.textHeight : settings.textHeight };
    });

    const g = groups.find((x) => x.label === name);

    if (g) {
      /* 已经有这个框：往里找空位接着放，不够高就往下长（框下方本来就是空的） */
      const minW = Math.min(items.length, perRow) * w + (Math.min(items.length, perRow) - 1) * gapX + pad * 2;
      if (num(g.width) < minW) g.width = minW;
      for (const it of items) {
        const areas = occupiedRects(
          nodes.filter((n) => n.type !== 'group'),
          12
        );
        const pos = findFreeSlot(g, areas, w, it.h, { pad, top: GROUP_TOP, gapX, gapY, perRow });
        pushCardNodes(nodes, it.item, pos, settings, b.color);
        const need = pos.y + it.h + pad - num(g.y);
        if (need > num(g.height)) g.height = need;
      }
      continue;
    }

    /* 新框：尺寸先按这一批算准，再整块找空地放下，一次到位 */
    const lay = layoutUnits(items, settings);
    const areas = occupiedRects(nodes, 16);
    const startX = nodes.length ? minLeftOf(nodes) : 0;
    const startY = nodes.length ? maxBottomOf(nodes) + Math.round(gapY * 1.6) : 0;
    const pos = findFreeArea(areas, lay.w, lay.h, {
      x: startX,
      y: startY,
      gapY: Math.round(gapY * 1.6),
      cols: 1,
    });

    const box = {
      id: uid(),
      type: 'group',
      label: name,
      x: pos.x,
      y: pos.y,
      width: lay.w,
      height: lay.h,
      color: b.color,
    };
    nodes.push(box);
    groups.push(box);
    newGroups++;

    for (const s of lay.slots) {
      pushCardNodes(nodes, s.item, { x: pos.x + pad + s.x, y: pos.y + GROUP_TOP + s.y }, settings, b.color);
    }
  }

  return { nodes, newGroups };
}

/** 整块替换白板内容（白板开着时走 canvas 官方 importData，带 clear） */
async function replaceCanvas(app, canvasPath, data) {
  const file = app.vault.getAbstractFileByPath(canvasPath);
  if (!file) throw new Error(`白板不存在：${canvasPath}`);

  const leaves = app.workspace.getLeavesOfType('canvas');
  for (const leaf of leaves) {
    const v = leaf.view;
    if (v && v.file && v.file.path === canvasPath && v.canvas && typeof v.canvas.importData === 'function') {
      v.canvas.importData({ nodes: data.nodes, edges: data.edges || [] }, true);
      await sleep(150);
      try {
        if (typeof v.canvas.requestSave === 'function') await v.canvas.requestSave();
      } catch (e) {
        /* ignore */
      }
      return 'live';
    }
  }

  await app.vault.modify(file, JSON.stringify({ nodes: data.nodes, edges: data.edges || [] }, null, '\t'));
  return 'file';
}

/** 把整个白板里的卡片按关键词重新排进分组框，每个框带颜色 */
async function organizeCanvas(app, canvasPath, settings) {
  const data = await readCanvas(app, canvasPath);
  const rules = getActiveRules(settings);

  const names = new Set(['其他']);
  for (const r of rules) names.add(r.name);

  /* 先拆掉上一次自动建的分组框（同名且是 group 的），卡片本身还在，随后再重排 */
  const kept = data.nodes.filter((n) => !(n.type === 'group' && names.has(n.label)));
  const units = collectUnits(kept);

  const buckets = new Map();
  for (const r of rules) buckets.set(r.name, { name: r.name, color: r.color, units: [] });
  buckets.set('其他', { name: '其他', color: settings.otherGroupColor || '5', units: [] });

  for (const u of units) {
    const r = matchRule(u, rules);
    buckets.get(r ? r.name : '其他').units.push(u);
  }

  const gapY = settings.gapY;
  const groupGap = Math.round(gapY * 1.6);

  const used = new Set();
  const groups = [];
  const moved = [];
  let groupCount = 0;
  let cardCount = 0;

  /* 非卡片节点（用户自己画的、手写的）原地不动，它们的占位要避开 */
  const areas = occupiedRects(kept, 16);
  let y = kept.length ? maxBottomOf(kept) + 150 : 0;
  const startX = kept.length ? minLeftOf(kept) : 0;

  for (const b of buckets.values()) {
    if (!b.units.length) continue;

    const items = b.units.map((u) => ({ item: u, h: u.h }));
    const lay = layoutUnits(items, settings);
    const pos = findFreeArea(areas, lay.w, lay.h, { x: startX, y, gapY: groupGap, cols: 1 });

    groups.push({
      id: uid(),
      type: 'group',
      label: b.name,
      x: pos.x,
      y: pos.y,
      width: lay.w,
      height: lay.h,
      color: b.color,
    });
    /* 这个框占的位置也参与后续比对，框与框不会叠 */
    areas.push({ x: pos.x - 16, y: pos.y - 16, w: lay.w + 32, h: lay.h + 32 });
    groupCount++;

    for (const s of lay.slots) {
      const u = s.item;
      const dx = pos.x + GROUP_PAD + s.x - u.x;
      const dy = pos.y + GROUP_TOP + s.y - u.y;
      for (const n of u.nodes) {
        const copy = Object.assign({}, n);
        copy.x = num(n.x) + dx;
        copy.y = num(n.y) + dy;
        moved.push(copy);
        used.add(n.id);
      }
      cardCount++;
    }

    y = pos.y + lay.h + groupGap;
  }

  const rest = kept.filter((n) => !used.has(n.id));
  await replaceCanvas(app, canvasPath, { nodes: groups.concat(rest, moved), edges: data.edges });

  return { groups: groupCount, cards: cardCount };
}

/* =========================================================
 * 本地桥：只监听 127.0.0.1
 * ========================================================= */
class LocalBridge {
  constructor(plugin) {
    this.plugin = plugin;
    this.server = null;
    this.port = 0;
    this.token = '';
    this.lastError = '';
  }

  get running() {
    return !!this.server;
  }

  async start() {
    if (this.server) return;
    if (!nodeHttp) {
      this.lastError = '当前环境拿不到 Node 的 http 模块';
      return;
    }

    if (!this.plugin.settings.bridgeToken) {
      this.plugin.settings.bridgeToken = uid() + uid().slice(0, 8);
      await this.plugin.saveSettings();
    }
    this.token = this.plugin.settings.bridgeToken;

    for (const port of PORT_RANGE) {
      const ok = await new Promise((resolve) => {
        let srv;
        try {
          srv = nodeHttp.createServer((req, res) => this.handle(req, res));
        } catch (e) {
          resolve(false);
          return;
        }
        srv.once('error', () => {
          try {
            srv.close();
          } catch (e) {
            /* ignore */
          }
          resolve(false);
        });
        srv.listen(port, '127.0.0.1', () => {
          this.server = srv;
          this.port = port;
          resolve(true);
        });
      });
      if (ok) {
        this.lastError = '';
        return;
      }
    }
    this.lastError = '端口 27123–27128 都被占用了';
  }

  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch (e) {
        /* ignore */
      }
      this.server = null;
      this.port = 0;
    }
  }

  handle(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-SFB-Token');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const path = String(req.url || '').split('?')[0];

    if (path === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: APP_TAG, version: '2.0.0', token: this.token }));
      return;
    }

    if (path === '/collect' && req.method === 'POST') {
      const token = req.headers['x-sfb-token'];
      if (this.token && token !== this.token) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('bad token');
        return;
      }

      let body = '';
      let aborted = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 20 * 1024 * 1024) {
          aborted = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        let payload;
        try {
          payload = JSON.parse(body);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('bad json');
          return;
        }
        const items = Array.isArray(payload.items) ? payload.items : [];
        this.plugin
          .ingest(items)
          .then((r) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(Object.assign({ ok: true }, r)));
          })
          .catch((e) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
          });
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

/* =========================================================
 * 收集面板
 * ========================================================= */
class CollectModal extends Modal {
  constructor(app, plugin, presetCanvas) {
    super(app);
    this.plugin = plugin;
    this.presetCanvas = presetCanvas || '';
    this.refreshTimer = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('sfb-modal');

    contentEl.createEl('h3', { text: '收集面板' });

    this.connEl = contentEl.createDiv({ cls: 'sfb-conn' });

    // 待写入
    const pendRow = contentEl.createDiv({ cls: 'sfb-row' });
    pendRow.createEl('label', { text: '待写入' });
    this.pendingEl = pendRow.createEl('b', { cls: 'sfb-pending', text: '0 条' });

    // 主题选择已移除：卡片统一使用默认颜色，归类交给 Skill

    // 白板
    const canvasRow = contentEl.createDiv({ cls: 'sfb-row' });
    canvasRow.createEl('label', { text: '写入白板' });
    this.canvasSel = canvasRow.createEl('select', { cls: 'sfb-select' });
    this.fillCanvasOptions();

    // 操作
    const actions = contentEl.createDiv({ cls: 'sfb-actions' });
    this.writeBtn = actions.createEl('button', { cls: 'sfb-go', text: '立即写入白板' });
    this.writeBtn.addEventListener('click', () => this.writeNow());

    this.clearBtn = actions.createEl('button', { cls: 'sfb-btn-ghost', text: '清空待写入' });
    this.clearBtn.addEventListener('click', () => {
      this.plugin.queue.clear();
      this.refresh();
      new Notice('已清空待写入');
    });

    contentEl.createEl('p', {
      cls: 'sfb-hint',
      text: '在浏览器里打开收藏页往下滚，收集到的内容会自动排到这里。自动写入开启时，停顿几秒就会自己铺到白板上。',
    });

    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 1200);
  }

  fillCanvasOptions() {
    this.canvasSel.empty();
    const files = this.app.vault
      .getFiles()
      .filter((f) => f.extension === 'canvas')
      .sort((a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0));

    for (const f of files) {
      const o = this.canvasSel.createEl('option', { text: f.path });
      o.value = f.path;
    }
    const wanted = this.presetCanvas || this.plugin.settings.targetCanvas;
    if (wanted && files.some((f) => f.path === wanted)) this.canvasSel.value = wanted;
    if (!files.length) {
      const o = this.canvasSel.createEl('option', { text: '（还没有白板，请先新建）' });
      o.value = '';
    }
  }

  refresh() {
    const b = this.plugin.bridge;
    this.connEl.empty();
    if (b.running) {
      this.connEl.addClass('ok');
      this.connEl.setText(`本地接收已就绪 · 127.0.0.1:${b.port}`);
    } else {
      this.connEl.addClass('bad');
      this.connEl.setText(b.lastError || '本地接收未启动');
    }

    const n = this.plugin.queue.size;
    this.pendingEl.setText(`${n} 条`);
    this.writeBtn.disabled = n === 0;
  }

  async writeNow() {
    const canvasPath = this.canvasSel.value;
    if (!canvasPath) {
      new Notice('请先选择一个白板');
      return;
    }

    this.plugin.settings.targetCanvas = canvasPath;
    await this.plugin.saveSettings();

    this.writeBtn.disabled = true;
    this.writeBtn.setText('写入中…');
    try {
      const n = await this.plugin.flushQueue({ force: true });
      new Notice(n ? `已写入 ${n} 张卡片` : '没有新内容', 4000);
    } catch (e) {
      new Notice('写入失败：' + ((e && e.message) || e), 8000);
    }
    this.writeBtn.setText('立即写入白板');
    this.refresh();
  }

  onClose() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.contentEl.empty();
  }
}

/* =========================================================
 * 设置页
 * ========================================================= */
class VccSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.statusEl = null;
    this.statusTimer = null;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    UI_ZH = detectZhLocale();
    containerEl.createEl('h2', { text: 'Social Favboard' });

    /* ---- 连接状态 ---- */
    containerEl.createEl('h3', { text: T('连接状态', 'Connection') });
    this.statusEl = containerEl.createDiv({ cls: 'sfb-setting-status' });
    this.renderStatus();

    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = setInterval(() => this.renderStatus(), 2000);

    new Setting(containerEl)
      .setName(T('重新启动接收端口', 'Restart the receiving port'))
      .setDesc(T('如果浏览器扩展提示找不到插件，点一下这里', 'Click here if the browser extension cannot find the plugin'))
      .addButton((b) =>
        b.setButtonText(T('重启', 'Restart')).onClick(async () => {
          this.plugin.bridge.stop();
          await this.plugin.bridge.start();
          this.renderStatus();
          new Notice(this.plugin.bridge.running ? `已监听 127.0.0.1:${this.plugin.bridge.port}` : '启动失败');
        })
      );

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        T('浏览器扩展会自动扫描 127.0.0.1 的 27123–27128 端口来配对，通常不需要你手动配置。', 'The extension scans ports 27123-27128 on 127.0.0.1 to pair automatically, so no manual setup is needed.') +
        T('这个端口只绑定在本机回环地址上，局域网里的其它设备访问不到。', 'The port binds to the loopback address only, so other devices on your network cannot reach it.'),
    });

    /* ---- 待写入 ---- */
    containerEl.createEl('h3', { text: T('待写入队列', 'Pending queue') });
    const queueInfo = containerEl.createEl('p', { cls: 'setting-item-description' });
    const renderQueue = () => {
      queueInfo.setText(T(`当前队列里有 ${this.plugin.queue.size} 条内容等待写入白板。`, `${this.plugin.queue.size} items waiting to be written.`));
    };
    renderQueue();

    new Setting(containerEl).setName(T('立即写入', 'Write now')).addButton((b) =>
      b.setButtonText(T('写入', 'Write')).onClick(async () => {
        const n = await this.plugin.flushQueue({ force: true });
        renderQueue();
        new Notice(n ? `已写入 ${n} 张卡片` : '没有新内容');
      })
    );

    new Setting(containerEl)
      .setName(T('新采集的视频自动写入白板', 'Write new items to the board automatically'))
      .setDesc(T('开启后，浏览器扩展收到新采集的视频会自动追加到「默认写入白板」；关闭则只进队列，需要点上面的「立即写入」', 'When on, newly collected items are appended to the default board. When off they only enter the queue, and you click Write now.'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoWrite).onChange(async (v) => {
          this.plugin.settings.autoWrite = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName(T('清空队列', 'Clear queue')).addButton((b) =>
      b.setButtonText(T('清空', 'Clear')).onClick(() => {
        this.plugin.queue.clear();
        renderQueue();
        new Notice('已清空队列');
      })
    );

    /* 主题、分类方式、关键词规则已移除：统一由 Skill 排版处理 */

    /* 分类类型改为独立标签页，主设置页不再调用 */

    /* 分类 / 关键词规则 / 立即整理 已移除 */

    /* ---- 卡片外观 ---- */
    containerEl.createEl('h3', { text: T('卡片', 'Cards') });

    new Setting(containerEl)
      .setName(T('默认写入白板', 'Default board'))
      .setDesc(
        T(
          '填相对 vault 的路径，例如：卡片/我的收藏.canvas（不要带 C:\\... 这种绝对路径）',
          'Path relative to your vault, e.g. cards/favorites.canvas (no absolute paths like C:\\...)'
        )
      )
      .addText((t) =>
        t
          .setPlaceholder(T('文件夹/白板.canvas', 'folder/board.canvas'))
          .setValue(this.plugin.settings.targetCanvas)
          .onChange(async (v) => {
            const basePath =
              this.plugin.app && this.plugin.app.vault && this.plugin.app.vault.adapter
                ? this.plugin.app.vault.adapter.basePath
                : '';
            this.plugin.settings.targetCanvas = toVaultPath(v, basePath);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(T('Skill 输出文件', 'Skill output file'))
      .setDesc(
        T('绝对路径。Skill 排好版生成的白板文件；在命令面板运行“从 Skill 输出文件导入白板”时，会把它写进上面的默认白板。留空则不自动导入。', 'Absolute path to the canvas the Skill produces. The command Import board from Skill output writes it into the default board above. Leave empty to disable auto-import.')
      )
      .addText((t) =>
        t
          .setPlaceholder('C:\\...\\organized.canvas')
          .setValue(this.plugin.settings.importSource || '')
          .onChange(async (v) => {
            this.plugin.settings.importSource = v.trim();
            await this.plugin.saveSettings();
          })
      );

    /* Skill 排版方式已移除：统一使用「生成文件后导入」 */

    new Setting(containerEl)
      .setName(T('Skill整理排版白板-自动覆盖白板（会覆盖用户自己的排版）', 'Auto-apply Skill layout (overwrites your own arrangement)'))
      .setDesc(
        T('开启后，Skill 每次重新生成排版文件，插件会在约 2 秒内用它整块替换「默认写入白板」；替换前自动备份。', 'When on, the plugin replaces the default board with the Skill output within about 2 seconds of it changing. A backup is made first.')
      )
      .addToggle((t) =>
        t.setValue(!!this.plugin.settings.autoImport).onChange(async (v) => {
          this.plugin.settings.autoImport = v;
          await this.plugin.saveSettings();
        })
      );

    /* 「新采集的视频自动写入白板」已移到「待写入队列」区块 */

    new Setting(containerEl)
      .setName(T('封面目录', 'Cover folder'))
      .addText((t) =>
        t.setValue(this.plugin.settings.coverFolder).onChange(async (v) => {
          this.plugin.settings.coverFolder = v.trim() || 'video-covers';
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(T('单次同步上限', 'Items per sync'))
      .setDesc(T('每次最多写入多少张卡片（含封面下载）。剩下的留在队列里，下次继续。调小可降低请求量。', 'Maximum cards written per sync (covers included). The rest stay queued for next time. Lower values mean fewer requests.'))
      .addSlider((s) =>
        s
          .setLimits(5, 50, 5)
          .setValue(this.plugin.settings.batchLimit || 30)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.batchLimit = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName(T('卡片宽度', 'Card width')).addSlider((s) =>
      s
        .setLimits(200, 560, 20)
        .setValue(this.plugin.settings.cardWidth)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.cardWidth = v;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName(T('每行卡片数', 'Cards per row')).addSlider((s) =>
      s
        .setLimits(1, 10, 1)
        .setValue(this.plugin.settings.maxPerRow)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.maxPerRow = v;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName(T('横向间距', 'Horizontal gap')).addSlider((s) =>
      s
        .setLimits(20, 300, 10)
        .setValue(this.plugin.settings.gapX)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.gapX = v;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName(T('纵向间距', 'Vertical gap')).addSlider((s) =>
      s
        .setLimits(20, 300, 10)
        .setValue(this.plugin.settings.gapY)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.gapY = v;
          await this.plugin.saveSettings();
        })
    );

    /* ---- 去重记录 ---- */
    containerEl.createEl('h3', { text: T('去重记录', 'Duplicate records') });
    const total =
      (this.plugin.settings.synced.douyin || []).length +
      (this.plugin.settings.synced.bilibili || []).length +
      (this.plugin.settings.synced.xhs || []).length;
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: T(`已记录 ${total} 条收过的内容。`, `${total} items recorded.`),
    });

    new Setting(containerEl)
      .setName(T('跳过收过的内容', 'Skip already-collected items'))
      .setDesc(T('开着：同一个视频只收一次。关掉：每次刷到都会重新生成卡片（会重复）。', 'On: each video is collected once. Off: every scroll regenerates the card, creating duplicates.'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.dedupe !== false).onChange(async (v) => {
          this.plugin.settings.dedupe = v;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName(T('从白板重建记录', 'Rebuild records from boards'))
      .setDesc(
        T(
          '扫描全库所有白板，只把白板上还存在的卡片记成「已收过」，其余清掉。' +
            '你在白板里删掉的卡片，下次刷到就能重新收回来，又不会把旧的全都重抓一遍。',
          'Scans every board and keeps records only for cards still present. Cards you deleted from a board can be collected again next time, without re-fetching everything.'
        )
      )
      .addButton((b) =>
        b
          .setButtonText(T('重建', 'Rebuild'))
          .setCta()
          .onClick(async () => {
            b.setButtonText(T('扫描中…', 'Scanning…')).setDisabled(true);
            const r = await this.plugin.rebuildSynced();
            b.setButtonText(T('重建', 'Rebuild')).setDisabled(false);
            new Notice(
              `扫描了 ${r.canvases} 块白板：记录 ${r.before} 条 → ${r.after} 条。` +
                (r.after < r.before ? '清掉了白板上已不存在的记录。' : ''),
              6000
            );
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(T('清空记录', 'Clear records'))
      .setDesc(T('全部清零。之后所有内容都会被当成新的，重新收一遍到白板。', 'Wipes everything. All content is then treated as new and collected again.'))
      .addButton((b) =>
        b.setButtonText(T('清空', 'Clear')).onClick(async () => {
          this.plugin.settings.synced = { douyin: [], bilibili: [], xhs: [] };
          await this.plugin.saveSettings();
          new Notice('已清空');
          this.display();
        })
      );

    /* ---- 说明 ---- */
    containerEl.createEl('h3', { text: T('它是怎么工作的', 'How it works') });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        T('浏览器扩展运行在你自己的 Chrome / Edge 里，读的是页面已经加载出来的内容——它不发任何面向平台的请求。', 'The extension runs inside your own Chrome or Edge and reads content the page has already loaded. It sends no requests of its own to any platform.') +
        T('读到的东西通过本机回环地址交给我这个插件，插件下载封面、生成卡片、写进白板。', 'What it reads is handed to this plugin over the loopback address; the plugin downloads covers, builds cards and writes them to the board.') +
        T('与平台有关的一切都发生在你的浏览器里、以你本人的身份完成。', 'Everything platform-related happens inside your browser, under your own identity.'),
    });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        T('需要说明：这仍属于非官方途径，无法保证平台条款意义上的完全合规，也无法保证平台改版后始终可用。是否使用请自行判断。', 'Note: this remains an unofficial route. Platform terms vary, and a redesign may break collection. Use at your own discretion.'),
    });

    this.renderConcepts(containerEl);
  }

  renderConcepts(containerEl) {
    if (!this.plugin.conceptText && !this.conceptLoading) {
      this.conceptLoading = true;
      this.plugin.loadConceptText().then(() => {
        this.conceptLoading = false;
        this.display();
      });
      return;
    }
    containerEl.createEl('h3', { text: T('分类类型', 'Classification types') });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: T('体 / 面来自「分类类型-灵感体系.md」。点体名展开或收起它下面的面。', 'Bodies and facets come from 分类类型-灵感体系.md. Click a body name to expand or collapse its facets.'),
    });
    const box = containerEl.createDiv();
    const entities = [];
    let cur = null;
    for (const line of String(this.plugin.conceptText || '').split('\n')) {
      const m1 = line.match(/^##\s*体[:：]\s*(.+)$/);
      if (m1) {
        cur = { name: m1[1].trim(), facets: [] };
        entities.push(cur);
        continue;
      }
      const m2 = line.match(/^-\s*面[:：]\s*(.+)$/);
      if (m2 && cur) cur.facets.push(m2[1].trim());
    }
    for (const e of entities) {
      const head = box.createDiv();
      head.style.cursor = 'pointer';
      head.style.fontWeight = '600';
      head.setText(T(`▸ ${e.name}（${e.facets.length} 个面）`, `▸ ${e.name} (${e.facets.length} facets)`));
      const body = box.createDiv();
      body.style.display = 'none';
      body.style.paddingLeft = '16px';
      for (const f of e.facets) body.createDiv({ text: '· ' + f });
      head.addEventListener('click', () => {
        const opened = body.style.display !== 'none';
        body.style.display = opened ? 'none' : 'block';
        head.setText(
          T(
            `${opened ? '▸' : '▾'} ${e.name}（${e.facets.length} 个面）`,
            `${opened ? '▸' : '▾'} ${e.name} (${e.facets.length} facets)`
          )
        );
      });
      const fb = body.createEl('button', { cls: 'sfb-add-topic', text: T('+ 添加面', '+ Add facet') });
      fb.addEventListener('click', () => {
        const inp = body.createEl('input', { cls: 'sfb-input', attr: { placeholder: T('输入面名称，回车保存', 'Facet name, press Enter to save') } });
        inp.style.width = '100%';
        inp.focus();
        let saved = false;
        const save = async () => {
          if (saved) return;
          saved = true;
          const name = inp.value.trim();
          if (!name) {
            inp.remove();
            return;
          }
          let t = '';
          try {
            t = await this.plugin.app.vault.adapter.read('分类类型-灵感体系.md');
          } catch (err) {
            /* ignore */
          }
          const lines = String(t).split('\n');
          const idx = lines.findIndex((l) => l.trim() === `## 体：${e.name}`);
          if (idx < 0) return;
          let end = lines.length;
          for (let i = idx + 1; i < lines.length; i++) {
            if (/^##\s*体[:：]/.test(lines[i])) {
              end = i;
              break;
            }
          }
          lines.splice(end, 0, `- 面：${name}`);
          await this.plugin.app.vault.adapter.write('分类类型-灵感体系.md', lines.join('\n'));
          await this.plugin.loadConceptText();
          this.display();
        };
        inp.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            save();
          }
        });
        inp.addEventListener('blur', save);
      });
    }
    if (!entities.length) {
      box.createEl('p', { cls: 'setting-item-description', text: T('还没有体。', 'No bodies yet.') });
    }
    const btn = box.createEl('button', { cls: 'sfb-add-topic', text: T('+ 添加体', '+ Add body') });
    btn.addEventListener('click', () => {
      const inp = box.createEl('input', { cls: 'sfb-input', attr: { placeholder: T('输入体名称，回车保存', 'Body name, press Enter to save') } });
      inp.style.width = '100%';
      inp.focus();
      let saved = false;
      const save = async () => {
        if (saved) return;
        saved = true;
        const name = inp.value.trim();
        if (!name) {
          inp.remove();
          return;
        }
        let t = '';
        try {
          t = await this.plugin.app.vault.adapter.read('分类类型-灵感体系.md');
        } catch (err) {
          /* ignore */
        }
        if (!t.trim()) t = '# 分类类型-灵感体系\n';
        await this.plugin.app.vault.adapter.write('分类类型-灵感体系.md', t.trimEnd() + `\n\n## 体：${name}\n`);
        await this.plugin.loadConceptText();
        this.display();
      };
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          save();
        }
      });
      inp.addEventListener('blur', save);
    });
  }

  renderStatus() {
    if (!this.statusEl) return;
    const b = this.plugin.bridge;
    this.statusEl.empty();
    this.statusEl.classList.remove('ok', 'bad');
    if (b.running) {
      this.statusEl.addClass('ok');
      this.statusEl.setText(T(`已就绪 · 正在监听 127.0.0.1:${b.port}`, `Ready · listening on 127.0.0.1:${b.port}`));
    } else {
      this.statusEl.addClass('bad');
      this.statusEl.setText(b.lastError || T('未启动', 'Not running'));
    }
  }

  hide() {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  renderRules(container) {
    container.empty();
    const rules = this.plugin.settings.classifyRules;

    if (!rules.length) {
      container.createEl('p', {
        cls: 'setting-item-description',
        text: '还没有分类规则。点下面的「+ 添加分类」，给它起个名字、填几个关键词。',
      });
      return;
    }

    rules.forEach((r, idx) => {
      const row = container.createDiv({ cls: 'sfb-rule-row' });

      const nameInput = row.createEl('input', { cls: 'sfb-rule-name' });
      nameInput.type = 'text';
      nameInput.placeholder = '分类名';
      nameInput.value = r.name || '';
      nameInput.addEventListener('change', async () => {
        rules[idx].name = nameInput.value.trim() || '未命名';
        await this.plugin.saveSettings();
      });

      const kwInput = row.createEl('input', { cls: 'sfb-rule-keywords' });
      kwInput.type = 'text';
      kwInput.placeholder = '关键词，逗号分开，例如：探店, 菜谱, 好吃';
      kwInput.value = r.keywords || '';
      kwInput.addEventListener('change', async () => {
        rules[idx].keywords = kwInput.value.trim();
        await this.plugin.saveSettings();
      });

      const sel = row.createEl('select', { cls: 'sfb-topic-color' });
      for (const c of CANVAS_COLORS) {
        const o = sel.createEl('option', { text: c.name });
        o.value = c.v;
      }
      sel.value = r.color || '5';
      sel.addEventListener('change', async () => {
        rules[idx].color = sel.value;
        await this.plugin.saveSettings();
      });

      const del = row.createEl('button', { cls: 'sfb-topic-del', text: '删除' });
      del.addEventListener('click', async () => {
        rules.splice(idx, 1);
        await this.plugin.saveSettings();
        this.renderRules(container);
      });
    });
  }

  renderTopics(container) {
    container.empty();
    const topics = this.plugin.settings.topics;

    if (!topics.length) {
      container.createEl('p', { cls: 'setting-item-description', text: '还没有主题，点下面按钮添加。' });
      return;
    }

    topics.forEach((t, idx) => {
      const row = container.createDiv({ cls: 'sfb-topic-row' });

      const nameInput = row.createEl('input', { cls: 'sfb-topic-name' });
      nameInput.type = 'text';
      nameInput.value = t.name;
      nameInput.addEventListener('change', async () => {
        topics[idx].name = nameInput.value.trim() || '未命名';
        await this.plugin.saveSettings();
      });

      const sel = row.createEl('select', { cls: 'sfb-topic-color' });
      for (const c of CANVAS_COLORS) {
        const o = sel.createEl('option', { text: c.name });
        o.value = c.v;
      }
      sel.value = t.color;
      sel.addEventListener('change', async () => {
        topics[idx].color = sel.value;
        await this.plugin.saveSettings();
      });

      const del = row.createEl('button', { cls: 'sfb-topic-del', text: '删除' });
      del.addEventListener('click', async () => {
        if (topics.length <= 1) {
          new Notice('至少保留一个主题');
          return;
        }
        topics.splice(idx, 1);
        if (!topics.some((x) => x.id === this.plugin.settings.defaultTopicId)) {
          this.plugin.settings.defaultTopicId = topics[0].id;
        }
        await this.plugin.saveSettings();
        this.renderTopics(container);
      });
    });
  }
}

/* =========================================================
 * 插件
 * ========================================================= */
module.exports = class VideoCardCollector extends Plugin {
  async onload() {
    await this.loadSettings();

    this.conceptText = '';
    await this.loadConceptText();

    this.queue = new Map();
    this.bridge = new LocalBridge(this);
    this.writeTimer = null;
    this.writeChain = Promise.resolve();

    await this.bridge.start();

    this.addRibbonIcon('film', '收集面板', () => this.openModal());

    this.addCommand({
      id: 'open-collect-panel',
      name: '打开收集面板',
      callback: () => this.openModal(),
    });

    this.addCommand({
      id: 'flush-queue',
      name: '把队列里的内容写入白板',
      callback: async () => {
        const n = await this.flushQueue({ force: true });
        new Notice(n ? `已写入 ${n} 张卡片` : '队列是空的');
      },
    });

    /* 关键词整理命令已移除：归类由 Skill 负责 */

    this.addCommand({
      id: 'import-skill-canvas',
      name: '从 Skill 输出文件导入白板',
      callback: async () => {
        await this.importSkillCanvas();
      },
    });

    this.lastImportMtime = 0;
    this.registerInterval(window.setInterval(() => {
      if (!this.settings.autoImport) return;
      if (!nodeFs || !nodePath) return;
      const source = (this.settings.importSource || '').trim();
      if (!source) return; /* 未设置路径时跳过自动导入 */
      if (!nodeFs.existsSync(source)) return;
      let mtime = 0;
      try {
        mtime = nodeFs.statSync(source).mtimeMs;
      } catch (e) {
        return;
      }
      if (!this.lastImportMtime) {
        this.lastImportMtime = mtime;
        return;
      }
      if (mtime === this.lastImportMtime) return;
      this.lastImportMtime = mtime;
      this.importSkillCanvas();
    }, 2000));

    this.addSettingTab(new VccSettingTab(this.app, this));
    /* 独立分类标签页已移除，分类类型在主设置页最下方 */
  }

  onunload() {
    if (this.bridge) this.bridge.stop();
    if (this.writeTimer) clearTimeout(this.writeTimer);
  }


  async loadConceptText() {
    try {
      const f = this.app.vault.getAbstractFileByPath('分类类型-灵感体系.md');
      this.conceptText = f ? await this.app.vault.read(f) : '';
    } catch (e) {
      this.conceptText = '';
    }
  }

  renderConcepts(containerEl) {
    containerEl.createEl('h3', { text: T('分类类型', 'Classification types') });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '点体名展开或收起它下面的面。',
    });
    const box = containerEl.createDiv();
    const entities = [];
    let cur = null;
    for (const line of String(this.conceptText || '').split('\n')) {
      const m1 = line.match(/^##\s*体[:：]\s*(.+)$/);
      if (m1) {
        cur = { name: m1[1].trim(), facets: [] };
        entities.push(cur);
        continue;
      }
      const m2 = line.match(/^-\s*面[:：]\s*(.+)$/);
      if (m2 && cur) cur.facets.push(m2[1].trim());
    }
    for (const e of entities) {
      const head = box.createDiv();
      head.style.cursor = 'pointer';
      head.style.fontWeight = '600';
      head.setText(T(`▸ ${e.name}（${e.facets.length} 个面）`, `▸ ${e.name} (${e.facets.length} facets)`));
      const body = box.createDiv();
      body.style.display = 'none';
      body.style.paddingLeft = '16px';
      for (const f of e.facets) body.createDiv({ text: '· ' + f });
      head.addEventListener('click', () => {
        const opened = body.style.display !== 'none';
        body.style.display = opened ? 'none' : 'block';
        head.setText(
          T(
            `${opened ? '▸' : '▾'} ${e.name}（${e.facets.length} 个面）`,
            `${opened ? '▸' : '▾'} ${e.name} (${e.facets.length} facets)`
          )
        );
      });
      const fi = body.createEl('input', { cls: 'sfb-input', attr: { placeholder: '新面名称' } });
      fi.style.width = '100%';
      const fb = body.createEl('button', { cls: 'sfb-add-topic', text: T('+ 添加面', '+ Add facet') });
      fb.addEventListener('click', async () => {
        const name = fi.value.trim();
        if (!name) return;
        let t = '';
        try {
          t = await this.app.vault.adapter.read('分类类型-灵感体系.md');
        } catch (err) {
          /* ignore */
        }
        const lines = String(t).split('\n');
        const idx = lines.findIndex((l) => l.trim() === `## 体：${e.name}`);
        if (idx < 0) return;
        let end = lines.length;
        for (let i = idx + 1; i < lines.length; i++) {
          if (/^##\s*体[:：]/.test(lines[i])) {
            end = i;
            break;
          }
        }
        lines.splice(end, 0, `- 面：${name}`);
        await this.app.vault.adapter.write('分类类型-灵感体系.md', lines.join('\n'));
        await this.loadConceptText();
        this.display();
      });
    }
    if (!entities.length) {
      box.createEl('p', { cls: 'setting-item-description', text: T('还没有体。', 'No bodies yet.') });
    }
    const input = box.createEl('input', { cls: 'sfb-input', attr: { placeholder: '新体名称' } });
    input.style.width = '100%';
    const btn = box.createEl('button', { cls: 'sfb-add-topic', text: T('+ 添加体', '+ Add body') });
    btn.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) return;
      let t = '';
      try {
        t = await this.app.vault.adapter.read('分类类型-灵感体系.md');
      } catch (err) {
        /* ignore */
      }
      if (!t.trim()) t = '# 分类类型-灵感体系\n';
      await this.app.vault.adapter.write('分类类型-灵感体系.md', t.trimEnd() + `\n\n## 体：${name}\n`);
      await this.loadConceptText();
      this.display();
    });
  }

  async importSkillCanvas() {
    const rel = (this.settings.targetCanvas || '').trim();
    if (!rel) {
      new Notice('请先在设置里填写“默认写入白板”');
      return;
    }
    if (!nodeFs || !nodePath) {
      new Notice('当前环境不支持读取外部文件（仅桌面版可用）');
      return;
    }
    const source = (this.settings.importSource || '').trim();
    if (!source) {
      new Notice('请先在设置里填写「分类结果文件」路径，自动导入已跳过', 8000);
      return;
    }
    if (!nodeFs.existsSync(source)) {
      new Notice('找不到 Skill 输出文件：' + source, 8000);
      return;
    }
    let raw = '';
    try {
      raw = nodeFs.readFileSync(source, 'utf8');
    } catch (e) {
      new Notice('读取失败：' + e.message, 8000);
      return;
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      new Notice('文件不是合法 JSON，已停止', 8000);
      return;
    }
    if (!data || !Array.isArray(data.nodes)) {
      new Notice('文件缺少 nodes 数组，已停止', 8000);
      return;
    }
    const norm = normalizePath(rel);
    const basePath = this.app.vault.adapter.basePath || '';
    const absTarget = basePath ? nodePath.join(basePath, norm) : '';
    if (absTarget && nodePath.resolve(absTarget) === nodePath.resolve(source)) {
      new Notice('源文件和白板是同一个文件，已停止', 8000);
      return;
    }
    let backup = '';
    try {
      if (absTarget && nodeFs.existsSync(absTarget)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        backup = nodePath.join(nodePath.dirname(source), `backup-${stamp}.canvas`);
        nodeFs.copyFileSync(absTarget, backup);
      }
    } catch (e) {
      new Notice('备份失败，已停止：' + e.message, 8000);
      return;
    }
    try {
      await this.app.vault.adapter.write(norm, raw);

    try {
      const leaves = this.app.workspace.getLeavesOfType('canvas');
      for (const leaf of leaves) {
        const v = leaf.view;
        if (v && v.file && v.file.path === norm) {
          await leaf.openFile(v.file, { active: false });
        }
      }
    } catch (e) {
      /* 刷新失败不影响写入结果 */
    }
    } catch (e) {
      new Notice('写入白板失败：' + e.message, 8000);
      return;
    }
    new Notice(
      `已导入 ${data.nodes.length} 个节点${backup ? '；备份：' + backup : ''}。请关闭并重新打开白板查看。`,
      10000
    );
  }

  openModal() {
    const active = this.app.workspace.getActiveFile();
    const preset = active && active.extension === 'canvas' ? active.path : '';
    new CollectModal(this.app, this, preset).open();
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    if (!Array.isArray(this.settings.topics) || !this.settings.topics.length) {
      this.settings.topics = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.topics));
    }
    if (this.settings.classifyMode !== 'keyword') this.settings.classifyMode = 'manual';
    if (!Array.isArray(this.settings.classifyRules)) this.settings.classifyRules = [];
    this.settings.classifyRules = this.settings.classifyRules
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({
        id: r.id || 'rule_' + uid().slice(0, 8),
        name: String(r.name || '未命名'),
        keywords: String(r.keywords || ''),
        color: String(r.color || '5'),
        enabled: r.enabled !== false,
      }));
    if (!this.settings.synced) this.settings.synced = { douyin: [], bilibili: [], xhs: [] };
    for (const k of ['douyin', 'bilibili', 'xhs']) {
      if (!Array.isArray(this.settings.synced[k])) this.settings.synced[k] = [];
    }

    /* 深拷贝：Object.assign 只做浅拷贝，config 里缺字段时会直接引用 DEFAULT_SETTINGS
       里的同一个对象，导致多个实例（或重载前后）共享同一份 topics/synced。 */
    this.settings.topics = JSON.parse(JSON.stringify(this.settings.topics));
    this.settings.synced = JSON.parse(JSON.stringify(this.settings.synced));

    // 去重开关：旧配置里没有这一项时默认开启（保持原行为）
    if (typeof this.settings.dedupe !== 'boolean') this.settings.dedupe = true;

    // 单次同步上限：旧配置里没有这一项，或值非法时回落到 30
    const bl = Number(this.settings.batchLimit);
    this.settings.batchLimit =
      Number.isFinite(bl) && bl >= 1 ? Math.min(50, Math.floor(bl)) : DEFAULT_SETTINGS.batchLimit;

    // 卡片正文多了一行「收录 日期」，旧的默认高度 150 会把最后一行裁掉，自动升一次
    const th = Number(this.settings.textHeight);
    if (!Number.isFinite(th) || th === 150) this.settings.textHeight = DEFAULT_SETTINGS.textHeight;

    // 白板路径容错：填成绝对路径时自动剥成 vault 相对路径
    const basePath = this.app && this.app.vault && this.app.vault.adapter && this.app.vault.adapter.basePath;
    const cleaned = toVaultPath(this.settings.targetCanvas, basePath);
    if (cleaned !== this.settings.targetCanvas) {
      this.settings.targetCanvas = cleaned;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isSynced(key) {
    const [plat, id] = key.split(':');
    const arr = this.settings.synced[plat];
    return Array.isArray(arr) && arr.indexOf(id) !== -1;
  }

  markSynced(items) {
    for (const it of items) {
      const arr = this.settings.synced[it.platform];
      if (!Array.isArray(arr)) continue;
      if (arr.indexOf(it.id) === -1) arr.push(it.id);
      if (arr.length > 6000) arr.splice(0, arr.length - 6000);
    }
  }

  /* 扫全库所有白板，把「白板上还实际存在」的卡片 id 收成去重记录。
     其余全丢掉——这样你在白板里删掉的卡片，下次刷到能重新收回来，
     又不用清空全部记录导致所有旧内容重抓一遍。 */
  async rebuildSynced() {
    const before =
      (this.settings.synced.douyin || []).length +
      (this.settings.synced.bilibili || []).length +
      (this.settings.synced.xhs || []).length;

    let files = [];
    try {
      files = this.app.vault.getFiles().filter((f) => f.extension === 'canvas');
    } catch (e) {
      files = [];
    }

    const merged = { douyin: [], bilibili: [], xhs: [] };
    const seen = { douyin: new Set(), bilibili: new Set(), xhs: new Set() };
    let scanned = 0;

    for (const f of files) {
      let json;
      try {
        json = JSON.parse(await this.app.vault.read(f));
      } catch (e) {
        continue;
      }
      scanned++;
      const got = extractIdsFromCanvas(json);
      for (const k of ['douyin', 'bilibili', 'xhs']) {
        for (const id of got[k]) {
          if (seen[k].has(id)) continue;
          seen[k].add(id);
          merged[k].push(id);
        }
      }
    }

    this.settings.synced = merged;
    await this.saveSettings();

    const after = merged.douyin.length + merged.bilibili.length + merged.xhs.length;
    return { before, after, canvases: scanned };
  }

  /**
   * 按关键词把某块白板里的卡片重新分组。返回 { ok, message }
   */
  async organize(canvasPath) {
    const path = canvasPath || this.settings.targetCanvas;
    if (!path) return { ok: false, message: '还没设置默认白板' };
    if (!getActiveRules(this.settings).length) return { ok: false, message: '还没有关键词分类，先在设置里加一个' };
    if (!this.app.vault.getAbstractFileByPath(path)) return { ok: false, message: `找不到白板「${path}」` };

    try {
      const r = await organizeCanvas(this.app, path, this.settings);
      if (!r.cards) return { ok: true, message: '这块白板上没有找到可分类的卡片' };
      return { ok: true, message: `已把 ${r.cards} 张卡片整理成 ${r.groups} 个分组` };
    } catch (e) {
      return { ok: false, message: `整理失败：${(e && e.message) || e}` };
    }
  }

  /**
   * 扩展推过来的条目。
   * 返回 ids（platform:id 形式），扩展据此清理自己的暂存。
   */
  async ingest(items) {
    const acceptedIds = [];
    let dropped = 0;
    if (!this.coverSeen) this.coverSeen = new Map();

    for (const raw of items) {
      if (!raw || !raw.id || !raw.platform) continue;
      const key = `${raw.platform}:${raw.id}`;
      acceptedIds.push(key);

      if (this.queue.has(key)) continue;
      // dedupe 关掉时，收过的内容也允许再进来一次
      if (this.settings.dedupe !== false && this.isSynced(key)) continue;

      /* 闸门一：标题是 icon 这类占位文本 → 直接丢，连封面都不下载 */
      if (isJunkTitle(raw.title)) {
        dropped++;
        continue;
      }

      /* 闸门二：同一个封面 URL 被多条复用 → 一定是头像/占位图，不是真封面 */
      let cover = String(raw.cover || '');
      if (cover) {
        const seenCount = (this.coverSeen.get(cover) || 0) + 1;
        this.coverSeen.set(cover, seenCount);
        if (seenCount > 1) cover = '';
        if (this.coverSeen.size > 3000) this.coverSeen.clear();
      }

      this.queue.set(key, {
        id: String(raw.id),
        platform: raw.platform,
        title: String(raw.title || '').slice(0, 300),
        author: String(raw.author || '').slice(0, 80),
        cover,
        url: String(raw.url || ''),
        duration: Number(raw.duration) || 0,
        /* 扩展抓到的时刻；旧数据没有这个字段，卡片上就不显示日期 */
        at: Number(raw.at) || 0,
      });
    }

    if (dropped >= 3) {
      new Notice(`已过滤 ${dropped} 条无效内容（标题无意义，多为误抓的账号卡片）`, 5000);
    }

    if (this.settings.autoWrite && this.settings.targetCanvas && this.queue.size) {
      this.scheduleWrite();
    }

    return { accepted: acceptedIds.length, ids: acceptedIds };
  }

  scheduleWrite() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeChain = this.writeChain
        .then(() => this.flushQueue({ force: false }))
        .catch((e) => console.error('[Social Favboard]', e));
    }, 4000);
  }

  /**
   * 把队列写进白板。返回写入的卡片数。
   */
  async flushQueue(opts) {
    if (!this.queue.size) return 0;

    const canvasPath = this.settings.targetCanvas;
    if (!canvasPath) {
      if (opts && opts.force) new Notice('还没设置默认白板，请到设置里填一个，或在收集面板里选');
      return 0;
    }

    if (!this.app.vault.getAbstractFileByPath(canvasPath)) {
      new Notice(
        `找不到白板「${canvasPath}」。\n设置里要填相对于 vault 的路径，例如：卡片/我的收藏.canvas`,
        12000
      );
      return 0;
    }

    const topic =
      this.settings.topics.find((t) => t.id === this.settings.defaultTopicId) ||
      this.settings.topics[0] ||
      { name: '未分类', color: '5' };

    const limit = Math.max(1, Number(this.settings.batchLimit) || 30);
    const allCards = Array.from(this.queue.values());
    const cards = allCards.slice(0, limit);
    const restCount = allCards.length - cards.length;
    const done = [];

    for (const card of cards) {
      try {
        const saved = await this.saveCover(card);
        if (saved) {
          card.imagePath = saved.path;
          card.imageSize = saved.size;
        }
      } catch (e) {
        card.imagePath = null;
      }
      done.push(card);
      await sleep(70);
    }

    const rules = [];
    const autoClassify = false;

    try {
      const existing = await readCanvas(this.app, canvasPath);
      if (autoClassify) {
        const built = buildClassifiedNodes(existing.nodes, done, this.settings, rules);
        await replaceCanvas(this.app, canvasPath, { nodes: built.nodes, edges: existing.edges });
      } else {
        const nodes = buildNodes(existing.nodes, done, this.settings, topic);
        await appendNodes(this.app, canvasPath, nodes);
      }
    } catch (e) {
      new Notice(
        `写入白板失败：${(e && e.message) || e}\n内容还留在队列里，修好后点「写入白板」重试。`,
        12000
      );
      return 0;
    }

    this.markSynced(done);
    for (const c of done) this.queue.delete(`${c.platform}:${c.id}`);
    await this.saveSettings();

    if (restCount > 0) {
      new Notice(
        `已写入 ${done.length} 张，队列里还剩 ${restCount} 条。继续往下刷或点「写入白板」分批同步。`,
        8000
      );
    }

    return done.length;
  }

  async saveCover(card) {
    if (!card.cover) return null;

    const folder = normalizePath(this.settings.coverFolder);
    if (!(await this.app.vault.adapter.exists(folder))) {
      try {
        await this.app.vault.createFolder(folder);
      } catch (e) {
        /* 已存在 */
      }
    }

    let buf = null;
    try {
      const res = await requestUrl({
        url: card.cover,
        method: 'GET',
        headers: {
          'User-Agent': UA_DESKTOP,
          Referer: PLATFORM_REFERER[card.platform] || '',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        throw: false,
      });
      if (res.status < 400 && res.arrayBuffer && res.arrayBuffer.byteLength > 800) {
        buf = res.arrayBuffer;
      }
    } catch (e) {
      /* 下载失败，卡片降级成纯文字 */
    }

    if (!buf) return null;

    const size = imageSize(buf);
    const ext = guessExt(card.cover, buf);
    const fileName = `${card.platform}-${safeName(card.id)}.${ext}`;
    const path = normalizePath(`${folder}/${fileName}`);

    if (await this.app.vault.adapter.exists(path)) {
      try {
        await this.app.vault.adapter.remove(path);
      } catch (e) {
        /* ignore */
      }
    }
    await this.app.vault.createBinary(path, buf);

    return { path, size };
  }
};
/* 独立分类标签页已删除：分类类型只在主设置页最下方 */
