/**
 * 端到端验证：插件端真实起 HTTP 服务 + 扩展端解析逻辑
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  }
}

/* =========================================================
 * 一、插件端
 * ========================================================= */
const BASE = path.resolve(__dirname, '..');

class MockPluginBase {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest || {};
    this._data = {};
  }
  async loadData() {
    return this._data;
  }
  async saveData(d) {
    this._data = d;
  }
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
}

const mockObsidian = {
  Plugin: MockPluginBase,
  PluginSettingTab: class {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
    }
  },
  Setting: class {},
  Modal: class {
    constructor(app) {
      this.app = app;
    }
  },
  Notice: class {
    constructor(m) {
      console.log('    [Notice] ' + m);
    }
  },
  requestUrl: async () => ({ status: 404, arrayBuffer: null }),
  normalizePath: (p) => String(p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
};

const mockApp = {
  vault: {
    getAbstractFileByPath: () => null,
    adapter: { exists: async () => false, remove: async () => {} },
    createFolder: async () => {},
    createBinary: async () => {},
    read: async () => JSON.stringify({ nodes: [], edges: [] }),
    modify: async () => {},
    getFiles: () => [],
  },
  workspace: { getLeavesOfType: () => [], getActiveFile: () => null },
};

function loadPluginModule() {
  const src = fs.readFileSync(path.join(BASE, 'social-favboard', 'main.js'), 'utf8');
  const sandbox = {
    require: (n) => (n === 'obsidian' ? mockObsidian : require(n)),
    module: { exports: {} },
    exports: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Date,
    Math,
    JSON,
    DataView,
    Uint8Array,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Infinity,
    NaN,
    Buffer,
    process,
    window: { require: null },
  };
  vm.createContext(sandbox);
  const expose = `
  ;module.exports.__t = { LocalBridge, buildNodes, buildCardText, imageSize, uid, fmtDuration, safeName, toVaultPath, isJunkTitle, extractIdsFromCanvas, splitKeywords, matchRule, collectUnits, buildClassifiedNodes, organizeCanvas, cardTitleOf, isCardText };
  `;
  vm.runInContext(src + expose, sandbox);
  return sandbox.module.exports;
}

(async function run() {
  console.log('\n[1] 插件模块加载');
  const P = loadPluginModule();
  const T = P.__t;
  check('模块导出插件类', typeof P === 'function');
  check('内部函数可访问', !!T && !!T.LocalBridge && !!T.buildNodes);

  const plugin = new P(mockApp, { id: 'social-favboard', dir: '.obsidian/plugins/social-favboard' });
  await plugin.loadSettings();
  plugin.queue = new Map();
  plugin.bridge = new T.LocalBridge(plugin);
  plugin.writeChain = Promise.resolve();

  console.log('\n[2] 启动本地接收端口');
  await plugin.bridge.start();
  check('端口已监听', plugin.bridge.running, plugin.bridge.lastError);
  const port = plugin.bridge.port;
  check('端口落在 27123-27128', port >= 27123 && port <= 27128, port);

  console.log('\n[3] GET /ping');
  const pingRes = await fetch(`http://127.0.0.1:${port}/ping`);
  const ping = await pingRes.json();
  check('ping 返回 200', pingRes.status === 200);
  check('app 标识正确', ping.app === 'social-favboard', ping.app);
  check('返回了配对令牌', typeof ping.token === 'string' && ping.token.length > 10, ping.token);

  console.log('\n[4] POST /collect（正确令牌）');
  const body1 = {
    items: [
      { id: '7300000000000000001', platform: 'douyin', title: '抖音视频一', author: '作者A', cover: '', url: 'https://www.douyin.com/video/7300000000000000001' },
      { id: 'BV1xx411c7mD', platform: 'bilibili', title: 'B站视频一', author: 'UP主', cover: '', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
      { id: '65f0a1b2c3d4e5f60718293a', platform: 'xhs', title: '小红书一', author: '小红薯', cover: '', url: 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a' },
    ],
  };
  const r1 = await fetch(`http://127.0.0.1:${port}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SFB-Token': ping.token },
    body: JSON.stringify(body1),
  });
  const j1 = await r1.json();
  check('返回 200', r1.status === 200, r1.status);
  check('accepted = 3', j1.accepted === 3, j1);
  check('返回 ids 三个平台齐全', Array.isArray(j1.ids) && j1.ids.length === 3, j1.ids);
  check('队列里有 3 条', plugin.queue.size === 3, plugin.queue.size);

  console.log('\n[5] 重复推送去重');
  const r2 = await fetch(`http://127.0.0.1:${port}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SFB-Token': ping.token },
    body: JSON.stringify(body1),
  });
  const j2 = await r2.json();
  check('重复推送仍返回 accepted（幂等应答）', j2.accepted === 3, j2.accepted);
  check('队列没有膨胀，仍是 3 条', plugin.queue.size === 3, plugin.queue.size);

  console.log('\n[6] 令牌校验');
  const r3 = await fetch(`http://127.0.0.1:${port}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SFB-Token': 'wrong-token' },
    body: JSON.stringify({ items: [{ id: 'x1', platform: 'douyin' }] }),
  });
  check('错误令牌返回 401', r3.status === 401, r3.status);
  check('错误令牌没有污染队列', plugin.queue.size === 3, plugin.queue.size);

  console.log('\n[7] 跨域预检');
  const r4 = await fetch(`http://127.0.0.1:${port}/collect`, { method: 'OPTIONS' });
  check('OPTIONS 返回 204', r4.status === 204, r4.status);
  check('允许的来源为 *', r4.headers.get('access-control-allow-origin') === '*');

  console.log('\n[8] 畸形请求');
  const r5 = await fetch(`http://127.0.0.1:${port}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SFB-Token': ping.token },
    body: 'not a json',
  });
  check('坏 JSON 返回 400', r5.status === 400, r5.status);
  const r6 = await fetch(`http://127.0.0.1:${port}/nope`);
  check('未知路径返回 404', r6.status === 404, r6.status);

  console.log('\n[9] 白板布局');
  const settings = { cardWidth: 340, maxPerRow: 4, gapX: 80, gapY: 90, textHeight: 150 };
  const topic = { id: 't', name: 'AI视觉', color: '2' };
  const cards = [
    { platform: 'bilibili', id: 'a', title: '横版', author: 'UP', url: 'u1', duration: 200, imagePath: 'video-covers/a.jpg', imageSize: { w: 1920, h: 1080 } },
    { platform: 'xhs', id: 'b', title: '竖版', author: '小红薯', url: 'u2', imagePath: 'video-covers/b.jpg', imageSize: { w: 900, h: 1200 } },
    { platform: 'douyin', id: 'c', title: '无封面', author: '抖音er', url: 'u3' },
  ];
  const existing = [{ id: 'e1', type: 'text', x: 0, y: 0, width: 400, height: 300 }];
  const nodes = T.buildNodes(existing, cards, settings, topic);

  check('共 5 个节点（2图3文）', nodes.length === 5, nodes.length);
  check('全部在已有内容右侧', nodes.every((n) => n.x >= 600), Math.min(...nodes.map((n) => n.x)));
  check('id 全唯一且 16 位 hex', new Set(nodes.map((n) => n.id)).size === 5 && nodes.every((n) => /^[0-9a-f]{16}$/.test(n.id)));
  check('横版封面高 191', Math.round(nodes[0].height) === 191, nodes[0].height);
  check('竖版封面高 453', Math.round(nodes[2].height) === 453, nodes[2].height);
  check('第 2 张卡的文字在图片下方', nodes[3].y === nodes[2].y + nodes[2].height + 10, { imgY: nodes[2].y, imgH: nodes[2].height, textY: nodes[3].y });
  check('文字卡用了主题色 2', nodes.filter((n) => n.type === 'text').every((n) => n.color === '2'));
  check('文字卡带主题标签', nodes.some((n) => n.type === 'text' && n.text.includes('#AI视觉')));

  let overlap = false;
  const byCol = {};
  for (const n of nodes) {
    const k = n.x;
    (byCol[k] = byCol[k] || []).push(n);
  }
  for (const k of Object.keys(byCol)) {
    const arr = byCol[k].sort((a, b) => a.y - b.y);
    for (let i = 1; i < arr.length; i++) {
      if (arr[i - 1].y + arr[i - 1].height > arr[i].y + 0.5) overlap = true;
    }
  }
  check('同列不垂直重叠', !overlap);

  const many = [];
  for (let i = 0; i < 5; i++) many.push({ platform: 'bilibili', id: 'm' + i, title: 't' + i, url: 'u' + i });
  const n2 = T.buildNodes([], many, settings, topic);
  check('第 5 张换行回到起始 x', n2[4].x === n2[0].x, { x0: n2[0].x, x4: n2[4].x });
  check('第 5 张 y 在下一行', n2[4].y > n2[0].y, { y0: n2[0].y, y4: n2[4].y });

  console.log('\n[10] 图片尺寸探测');
  const png = new Uint8Array(30);
  png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47;
  png[4] = 0x0d; png[5] = 0x0a; png[6] = 0x1a; png[7] = 0x0a;
  const dv = new DataView(png.buffer);
  dv.setUint32(16, 200); dv.setUint32(20, 300);
  const s1 = T.imageSize(png.buffer);
  check('PNG 200x300', s1 && s1.w === 200 && s1.h === 300, s1);

  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x48, 0x00, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const s2 = T.imageSize(jpg.buffer);
  check('JPEG 128x72', s2 && s2.w === 128 && s2.h === 72, s2);

  console.log('\n[11] 时长格式与文件名');
  check('65s -> 1:05', T.fmtDuration(65) === '1:05', T.fmtDuration(65));
  check('3725s -> 1:02:05', T.fmtDuration(3725) === '1:02:05', T.fmtDuration(3725));
  check('非法字符被替换', T.safeName('a/b:c*d?e') === 'a_b_c_d_e', T.safeName('a/b:c*d?e'));

  plugin.bridge.stop();
  check('端口已关闭', !plugin.bridge.running);

  /* =========================================================
   * 二、扩展端解析
   * ========================================================= */
  console.log('\n[12] 扩展端解析：抖音');
  const contentSrc = fs.readFileSync(path.join(BASE, 'browser-extension', 'content.js'), 'utf8');
  const cs = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    MutationObserver: class {
      observe() {}
    },
    location: { hostname: 'www.douyin.com' },
    chrome: { runtime: { sendMessage() {}, lastError: null } },
    document: { body: null, querySelectorAll: () => [], addEventListener: () => {} },
    JSON, Object, Array, String, Number, Math, Date, RegExp, Map, Set, Promise, Error,
  };
  cs.window = cs;
  cs.addEventListener = () => {};
  vm.createContext(cs);
  vm.runInContext(contentSrc, cs);
  const CT = cs.__sfbTest;
  check('扩展解析函数可取到', !!CT && !!CT.parsePayload);

  const douyinPayload = {
    aweme_list: [
      {
        aweme_id: '7300000000000000001',
        desc: '这个转场好厉害  #剪辑',
        author: { nickname: '某某导演' },
        video: { duration: 15200, cover: { url_list: ['http://p3-sign.douyinpic.com/a.jpeg'] } },
      },
    ],
  };
  const dOut = CT.parsePayload('https://www.douyin.com/aweme/v1/web/aweme/favorite/?x=1', douyinPayload);
  check('抖音解析出 1 条', dOut.length === 1, dOut.length);
  check('抖音标题正确', dOut[0] && dOut[0].title === '这个转场好厉害 #剪辑', dOut[0] && dOut[0].title);
  check('抖音作者正确', dOut[0] && dOut[0].author === '某某导演');
  check('抖音封面转 https', dOut[0] && dOut[0].cover.startsWith('https://'), dOut[0] && dOut[0].cover);
  check('抖音时长换算成秒', dOut[0] && dOut[0].duration === 15, dOut[0] && dOut[0].duration);
  check('抖音链接正确', dOut[0] && dOut[0].url === 'https://www.douyin.com/video/7300000000000000001');

  console.log('\n[13] 扩展端解析：B站');
  const biliPayload = {
    code: 0,
    data: {
      medias: [
        { bvid: 'BV1xx411c7mD', title: '【教程】低多边形建模', cover: 'http://i0.hdslb.com/bfs/a.jpg', duration: 305, upper: { name: '建模UP' } },
      ],
    },
  };
  const bOut = CT.parsePayload('https://api.bilibili.com/x/v3/fav/resource/list?media_id=1', biliPayload);
  check('B站解析出 1 条', bOut.length === 1, bOut.length);
  check('B站标题正确', bOut[0] && bOut[0].title === '【教程】低多边形建模');
  check('B站作者正确', bOut[0] && bOut[0].author === '建模UP');
  check('B站封面转 https', bOut[0] && bOut[0].cover.startsWith('https://'));
  check('B站时长 305 秒', bOut[0] && bOut[0].duration === 305);

  console.log('\n[14] 扩展端解析：小红书');
  const xhsPayload = {
    code: 0,
    data: {
      notes: [
        {
          note_id: '65f0a1b2c3d4e5f60718293a',
          display_title: '配色参考合集',
          cover: { url_default: 'http://sns-webpic-qc.xhscdn.com/x.jpg' },
          user: { nickname: '设计薯' },
        },
      ],
    },
  };
  const xOut = CT.parsePayload('https://edith.xiaohongshu.com/api/sns/web/v1/user/collected', xhsPayload);
  check('小红书解析出 1 条', xOut.length === 1, xOut.length);
  check('小红书标题正确', xOut[0] && xOut[0].title === '配色参考合集');
  check('小红书作者正确', xOut[0] && xOut[0].author === '设计薯');
  check('小红书链接正确', xOut[0] && xOut[0].url === 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a');

  console.log('\n[13b] 小红书 xsec_token 链接');
  const xOut2 = CT.parsePayload('https://edith.xiaohongshu.com/api/sns/web/v2/note/user/collected?num=30', {
    code: 0,
    data: {
      notes: [
        {
          note_id: '65f0a1b2c3d4e5f60718293a',
          display_title: '带令牌的收藏',
          xsec_token: 'ABToken_123/',
          cover: { url_default: 'http://sns-webpic-qc.xhscdn.com/x.jpg' },
        },
      ],
    },
  });
  check(
    '响应里有 token → 链接带 xsec_token（collect 页用 pc_collect）',
    xOut2[0] &&
      xOut2[0].url ===
        'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a?xsec_token=' +
          encodeURIComponent('ABToken_123/') +
          '&xsec_source=pc_collect',
    xOut2[0] && xOut2[0].url
  );
  const xOut3 = CT.parsePayload('https://edith.xiaohongshu.com/api/sns/web/v1/note/liked', {
    code: 0,
    data: { notes: [{ note_id: 'aaaabbbbccccddddeeee1111', display_title: '赞过的', xsec_token: 'T2', user: {} }] },
  });
  check('非收藏页 source 用 pc_user', xOut3[0].url.indexOf('xsec_source=pc_user') > 0, xOut3[0].url);
  check(
    'xhsUrl：裸 id 无 token → 仍回退成裸链接',
    CT.xhsUrl('aaa', '', '') === 'https://www.xiaohongshu.com/explore/aaa'
  );
  check(
    'xhsUrl：href 里已带 token → 原样采用',
    CT.xhsUrl('aaa', 'https://www.xiaohongshu.com/explore/aaa?xsec_token=XY&xsec_source=pc_feed', 'ZZ') ===
      'https://www.xiaohongshu.com/explore/aaa?xsec_token=XY&xsec_source=pc_feed'
  );
  check(
    'xhsUrl：href 没有 token 但响应有 → 拼接 token',
    CT.xhsUrl('aaa', 'https://www.xiaohongshu.com/explore/aaa', 'TT') ===
      'https://www.xiaohongshu.com/explore/aaa?xsec_token=TT&xsec_source=pc_user'
  );

  console.log('\n[13c] 小红书 token 补齐（DOM href 优先）');
  {
    const xhsAnchors = [
      { href: 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f607180001?xsec_token=TOK_A&xsec_source=pc_collect' },
      { href: 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f607180002?xsec_token=TOK_B&xsec_source=pc_collect' },
      { href: 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f607180003' },
    ];
    const c2 = Object.assign({}, cs);
    /* 新上下文不能带上一个上下文留下的 __sfbContentReady，否则脚本会直接 return */
    delete c2.__sfbContentReady;
    delete c2.__sfbTest;
    c2.location = { hostname: 'www.xiaohongshu.com', pathname: '/user/profile/abc' };
    c2.document = {
      body: null,
      querySelectorAll: (sel) => (String(sel).indexOf('a[href]') >= 0 ? xhsAnchors : []),
      addEventListener: () => {},
    };
    c2.window = c2;
    vm.createContext(c2);
    vm.runInContext(contentSrc, c2);
    const X = c2.__sfbTest;

    const batch = [
      { id: '65f0a1b2c3d4e5f607180001', platform: 'xhs', url: 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f607180001' },
      { id: '65f0a1b2c3d4e5f607180009', platform: 'xhs', url: 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f607180009' },
      { id: 'BV1xx', platform: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx' },
    ];
    X.repairXhsUrls(batch);
    check(
      '发送前用页面 href 补上 token',
      batch[0].url === 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f607180001?xsec_token=TOK_A&xsec_source=pc_collect',
      batch[0].url
    );
    check('页面里找不到对应 href 的保持原样', batch[1].url === 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f607180009', batch[1].url);
    check('非小红书条目不受影响', batch[2].url === 'https://www.bilibili.com/video/BV1xx', batch[2].url);
    check('href 里没 token 的不采用', batch.some((b) => b.id === '65f0a1b2c3d4e5f607180003') === false);

    /* 先到的裸链接会被后来的带 token 版本升级 */
    X.add({ id: 'MERGE1', platform: 'xhs', title: '先到的', url: 'https://www.xiaohongshu.com/explore/MERGE1' });
    X.add({
      id: 'MERGE1',
      platform: 'xhs',
      title: '先到的',
      url: 'https://www.xiaohongshu.com/explore/MERGE1?xsec_token=TOK_C&xsec_source=pc_collect',
    });
    const merged = X.pending.get('MERGE1');
    check('同一 id 后到的带 token 链接会覆盖裸链接', merged && merged.url.indexOf('xsec_token=TOK_C') > 0, merged && merged.url);
    check('pending 里只留一条', X.pending.size === 1, X.pending.size);

    /* 接口响应里挖 token（页面卡片 href 没有的情况下的主来源） */
    X.harvestTokens({
      data: { notes: [{ note_id: '65f0a1b2c3d4e5f60718000a', xsec_token: 'TOK_FROM_API', user: {} }] },
    });
    const b2 = [{ id: '65f0a1b2c3d4e5f60718000a', platform: 'xhs', url: 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718000a' }];
    X.repairXhsUrls(b2);
    check('接口数据里的 token 能补上', b2[0].url.indexOf('xsec_token=TOK_FROM_API') > 0, b2[0].url);

    X.harvestTokens({ data: { items: [{ id: '65f0a1b2c3d4e5f60718000b', xsec_token: 'TOK_DEEP' }] } });
    check('深层嵌套也能挖到', X.tokenMap.get('65f0a1b2c3d4e5f60718000b') === 'TOK_DEEP');

    X.harvestTokens({ note_id: '65f0a1b2c3d4e5f60718000c' });
    check('没有 token 字段就不会误记', !X.tokenMap.has('65f0a1b2c3d4e5f60718000c'));

    X.harvestTokens({ note_id: '65f0a1b2c3d4e5f60718000d', xsec_token: 'TOK_D' });
    const b3 = [{ id: '65f0a1b2c3d4e5f60718000d', platform: 'xhs', url: 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718000d?xsec_token=ALREADY' }];
    X.repairXhsUrls(b3);
    check('已有 token 的链接不被覆盖', b3[0].url === 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718000d?xsec_token=ALREADY', b3[0].url);

    /* 地址栏兜底：点开笔记时前端把带 token 的地址推进 history */
    const navOk = X.harvestNav(
      'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718000e?xsec_token=TOK_NAV&xsec_source=pc_collect'
    );
    check('从地址栏捞到 token', navOk === true && X.tokenMap.get('65f0a1b2c3d4e5f60718000e') === 'TOK_NAV');
    check('没有 token 的地址不记', X.harvestNav('https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718000f') === false);

    const b4 = [{ id: '65f0a1b2c3d4e5f60718000e', platform: 'xhs', url: 'https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718000e' }];
    X.repairXhsUrls(b4);
    check('地址栏来源的 token 也能补进链接', b4[0].url.indexOf('xsec_token=TOK_NAV') > 0, b4[0].url);
  }

  console.log('\n[15] 扩展端容错');
  check('空响应返回空数组', CT.parsePayload('https://www.douyin.com/aweme/v1/web/aweme/favorite/', {}).length === 0);
  check('无关 URL 返回空数组', CT.parsePayload('https://www.douyin.com/other', { aweme_list: [{ aweme_id: '1' }] }).length === 0);
  check('缺字段不抛异常', CT.parsePayload('https://www.douyin.com/aweme/v1/web/aweme/favorite/', { aweme_list: [{ desc: 'no id' }] }).length === 0);

  console.log('\n[16] 单次同步上限');
  {
    const canvasPath = 'test/白板.canvas';
    const fakeFile = { path: canvasPath };
    const written = { canvas: null };
    const app2 = {
      vault: {
        getAbstractFileByPath: (p) => (p === canvasPath ? fakeFile : null),
        adapter: { exists: async () => false, remove: async () => {} },
        createFolder: async () => {},
        createBinary: async () => {},
        read: async () => JSON.stringify(written.canvas || { nodes: [], edges: [] }),
        modify: async (f, d) => {
          written.canvas = JSON.parse(d);
        },
        getFiles: () => [],
      },
      workspace: { getLeavesOfType: () => [], getActiveFile: () => null },
    };

    const p2 = new P(app2, { id: 'social-favboard' });
    await p2.loadSettings();
    p2.queue = new Map();
    p2.settings.targetCanvas = canvasPath;
    p2.settings.batchLimit = 3;

    for (let i = 0; i < 7; i++) {
      p2.queue.set(`douyin:${i}`, {
        id: String(i),
        platform: 'douyin',
        title: 'T' + i,
        author: 'A',
        cover: '',
        url: 'https://www.douyin.com/video/' + i,
        duration: 0,
      });
    }

    const n = await p2.flushQueue({ force: true });
    check('上限 3：只写入 3 张', n === 3, n);
    check('队列剩 4 条等待下次', p2.queue.size === 4, p2.queue.size);
    check('白板节点数 = 3（无封面时每卡 1 个文字节点）', written.canvas && written.canvas.nodes.length === 3, written.canvas && written.canvas.nodes.length);

    const n2 = await p2.flushQueue({ force: true });
    check('第二次：4 条超上限，仍只写 3 条', n2 === 3, n2);
    check('队列剩 1 条', p2.queue.size === 1, p2.queue.size);

    const n3 = await p2.flushQueue({ force: true });
    check('第三次：剩 1 条全部写完', n3 === 1, n3);
    check('队列已清空', p2.queue.size === 0, p2.queue.size);
    check('白板累计 7 张 = 7 节点', written.canvas.nodes.length === 7, written.canvas.nodes.length);

    const pZero = new P(app2, { id: 'sfb' });
    pZero._data = { batchLimit: 0 };
    await pZero.loadSettings();
    check('batchLimit=0 回落 30', pZero.settings.batchLimit === 30, pZero.settings.batchLimit);

    const pOld = new P(app2, { id: 'sfb' });
    await pOld.loadSettings();
    check('旧配置无此字段默认 30', pOld.settings.batchLimit === 30, pOld.settings.batchLimit);

    const pHuge = new P(app2, { id: 'sfb' });
    pHuge._data = { batchLimit: 99999 };
    await pHuge.loadSettings();
    check('超大值被压到 50', pHuge.settings.batchLimit === 50, pHuge.settings.batchLimit);
  }

  console.log('\n[17] 白板路径清洗');
  {
    const base = 'C:\\Users\\User\\Documents\\Obsidian Vault';
    const ty = T.toVaultPath;

    check(
      '绝对路径剥成相对路径',
      ty('C:\\Users\\User\\Documents\\Obsidian Vault\\卡片\\我的收藏.canvas', base) ===
        '卡片/我的收藏.canvas',
      ty('C:\\Users\\User\\Documents\\Obsidian Vault\\卡片\\我的收藏.canvas', base)
    );

    check('正斜杠绝对路径也能剥', ty('C:/Users/User/Documents/Obsidian Vault/a/b.canvas', base) === 'a/b.canvas');

    check('已经是相对路径时原样保留', ty('卡片/我的收藏.canvas', base) === '卡片/我的收藏.canvas');

    check('去掉前导斜杠', ty('/a/b.canvas', base) === 'a/b.canvas');

    check('空值返回空串', ty('', base) === '');

    check('大小写不同的 base 也能匹配', ty('c:/users/user/documents/obsidian vault/x.canvas', base) === 'x.canvas');

    check('拿不到 basePath 时至少转成相对形式', ty('C:\\a\\b.canvas', '') === 'C:/a/b.canvas', ty('C:\\a\\b.canvas', ''));
  }

  console.log('\n[18] DOM 扫描防误抓');
  {
    check('icon 是垃圾标题', CT.isJunkTitle('icon') === true);
    check('头像 是垃圾标题', CT.isJunkTitle('头像') === true);
    check('真实标题不是垃圾', CT.isJunkTitle('这个转场好厉害') === false);
    check('空标题是垃圾', CT.isJunkTitle('') === true);

    const imgEl = {
      currentSrc: 'https://p3-sign.douyinpic.com/a.jpeg',
      src: 'https://p3-sign.douyinpic.com/a.jpeg',
      className: '',
      alt: 'icon',
      naturalWidth: 200,
      naturalHeight: 200,
    };
    const titleEl = { textContent: '  真实的视频标题内容  ' };
    const box = {
      querySelector: (sel) => (sel === 'img' ? imgEl : titleEl),
      querySelectorAll: () => [imgEl],
      innerText: 'icon\n真实的视频标题内容',
      parentElement: null,
    };
    const anchor = {
      href: 'https://www.douyin.com/video/1234567890123456',
      getAttribute: () => null,
      title: '',
      parentElement: box,
    };

    cs.location.pathname = '/user/self?x=1';
    cs.document.querySelectorAll = () => [anchor];
    const n1 = CT.scanDom();
    check('喜欢页上能扫到 1 条', n1 === 1, n1);

    cs.location.pathname = '/recommend';
    const n2 = CT.scanDom();
    check('首页/播放页不扫描', n2 === 0, n2);

    cs.location.pathname = '/user/self?x=1';
    cs.document.querySelectorAll = () => [];
    check('恢复现场不残留', CT.scanDom() === 0);
  }

  console.log('\n[19] 小红书「赞过」页面');
  {
    cs.location.pathname = '/user/profile/abc123/collected';
    check('收藏页允许扫描', CT.PAGE_OK.xhs() === true);

    cs.location.pathname = '/user/profile/abc123/liked';
    check('赞过页允许扫描', CT.PAGE_OK.xhs() === true);

    cs.location.pathname = '/explore/65f0a1b2c3d4e5f60718293a';
    check('笔记详情页不扫描', CT.PAGE_OK.xhs() === false);

    const likedPayload = {
      data: {
        notes: [
          {
            note_id: '65f0a1b2c3d4e5f60718293a',
            display_title: '赞过的配色笔记',
            cover: { url_default: 'http://sns-webpic-qc.xhscdn.com/y.jpg' },
            user: { nickname: '配色博主' },
          },
        ],
      },
    };

    const likedOut = CT.parsePayload(
      'https://edith.xiaohongshu.com/api/sns/web/v1/user/liked',
      likedPayload
    );
    check('赞过接口能解析出 1 条', likedOut.length === 1, likedOut.length);
    check('赞过标题正确', likedOut[0] && likedOut[0].title === '赞过的配色笔记');

    const collectOut = CT.parsePayload(
      'https://edith.xiaohongshu.com/api/sns/web/v1/note/collect_list',
      likedPayload
    );
    check('collect_list 接口也能解析', collectOut.length === 1, collectOut.length);
  }

  console.log('\n[20] 插件端最后一道闸');
  {
    check('插件端识别 icon 垃圾标题', T.isJunkTitle('icon') === true);
    check('插件端识别空标题', T.isJunkTitle('   ') === true);
    check('插件端放行真实标题', T.isJunkTitle('这个转场好厉害') === false);

    const app3 = {
      vault: {
        getAbstractFileByPath: () => null,
        adapter: { exists: async () => false, remove: async () => {}, basePath: '' },
        createFolder: async () => {},
        createBinary: async () => {},
        read: async () => JSON.stringify({ nodes: [], edges: [] }),
        modify: async () => {},
        getFiles: () => [],
      },
      workspace: { getLeavesOfType: () => [], getActiveFile: () => null },
    };

    const p5 = new P(app3, { id: 'sfb' });
    await p5.loadSettings();
    p5.queue = new Map();
    p5.settings.autoWrite = false;

    await p5.ingest([
      { id: '1', platform: 'douyin', title: 'icon', cover: 'https://x/avatar.png', url: 'u1' },
      { id: '2', platform: 'douyin', title: '真实标题一', cover: 'https://x/dup.png', url: 'u2' },
      { id: '3', platform: 'douyin', title: '真实标题二', cover: 'https://x/dup.png', url: 'u3' },
      { id: '4', platform: 'douyin', title: '', cover: '', url: 'u4' },
    ]);

    check('icon 标题被拦下（不入队）', !p5.queue.has('douyin:1'));
    check('空标题被拦下', !p5.queue.has('douyin:4'));
    check('真实标题正常入队', p5.queue.has('douyin:2') && p5.queue.has('douyin:3'), p5.queue.size);
    check('首条正常封面保留', p5.queue.get('douyin:2').cover === 'https://x/dup.png');
    check('重复封面被清空（疑似头像）', p5.queue.get('douyin:3').cover === '', p5.queue.get('douyin:3').cover);
  }

  console.log('\n[21] 总开关（暂停 / 恢复）');
  {
    check('默认为未暂停', CT.isPaused() === false);

    CT.setPaused(true);
    check('已切到暂停', CT.isPaused() === true);

    const added = CT.add({
      id: '999000111',
      platform: 'douyin',
      title: '暂停期间不该进来的视频',
      cover: '',
      url: 'u',
    });
    check('暂停时 add 被拒绝', added === false);

    const covImg = {
      currentSrc: 'https://p3-sign.douyinpic.com/b.jpeg',
      src: 'https://p3-sign.douyinpic.com/b.jpeg',
      className: '',
      alt: '',
      naturalWidth: 300,
      naturalHeight: 400,
    };
    const box2 = {
      querySelector: (sel) => (sel === 'img' ? covImg : { textContent: '暂停期间不该扫到的标题' }),
      querySelectorAll: () => [covImg],
      innerText: '暂停期间不该扫到的标题',
      parentElement: null,
    };
    const anchor2 = {
      href: 'https://www.douyin.com/video/9988776655443322',
      getAttribute: () => null,
      title: '',
      parentElement: box2,
    };
    cs.location.pathname = '/user/self?x=1';
    cs.document.querySelectorAll = () => [anchor2];
    const pausedScan = CT.scanDom();
    check('暂停时 DOM 扫描不产出', pausedScan === 0, pausedScan);

    CT.setPaused(false);
    check('恢复后未暂停', CT.isPaused() === false);
    const resumedScan = CT.scanDom();
    check('恢复后同一页面能扫到', resumedScan >= 1, resumedScan);

    cs.document.querySelectorAll = () => [];
    CT.setPaused(false);
  }

  console.log('\n[22] 去重开关与「从白板重建记录」');
  {
    /* --- 22-1 从白板节点认出已收过的 id --- */
    const board = {
      nodes: [
        { type: 'file', file: 'video-covers/douyin-7624861045890288942.jpg' },
        {
          type: 'text',
          text:
            '**标题**\n\n4.8万 · 抖音\n\n[▶ 打开原视频](https://www.douyin.com/video/7624861045890288942)',
        },
        { type: 'text', text: '[▶ 打开原视频](https://www.bilibili.com/video/BV1xx411c7mD)' },
        { type: 'file', file: 'video-covers/xhs-65f1a2b3000000001e02c3d4.webp' },
        { type: 'text', text: '这里是我自己写的一段话，完全不含链接' },
        { type: 'text', text: '参考 https://www.douyin.com/video/123456789' },
      ],
    };
    const ids = T.extractIdsFromCanvas(board);

    check('抖音：封面与正文指向同一 id 只算一条', ids.douyin.filter((x) => x === '7624861045890288942').length === 1);
    check('抖音：正文另外提到的 id 也能认出来', ids.douyin.length === 2, ids.douyin);
    check('B站 BV 号提取', ids.bilibili[0] === 'BV1xx411c7mD', ids.bilibili);
    check('小红书：从封面文件名提取', ids.xhs[0] === '65f1a2b3000000001e02c3d4', ids.xhs);
    check('纯文字节点不产生记录', ids.bilibili.length === 1 && ids.xhs.length === 1);

    const empty = T.extractIdsFromCanvas({ nodes: [] });
    check('空白板返回空记录', empty.douyin.length === 0 && empty.bilibili.length === 0 && empty.xhs.length === 0);
    check('坏数据不崩', T.extractIdsFromCanvas(null).douyin.length === 0);

    /* --- 22-2 去重开关 --- */
    const mkApp = () => ({
      vault: {
        getAbstractFileByPath: () => null,
        adapter: { exists: async () => false, remove: async () => {}, basePath: '' },
        createFolder: async () => {},
        createBinary: async () => {},
        read: async () => JSON.stringify({ nodes: [], edges: [] }),
        modify: async () => {},
        getFiles: () => [],
      },
      workspace: { getLeavesOfType: () => [], getActiveFile: () => null },
    });

    const p6 = new P(mkApp(), { id: 'sfb' });
    await p6.loadSettings();
    p6.queue = new Map();
    p6.settings.autoWrite = false;
    p6.settings.synced = { douyin: ['555'], bilibili: [], xhs: [] };

    p6.settings.dedupe = true;
    await p6.ingest([{ id: '555', platform: 'douyin', title: '已经收过的视频', cover: '', url: 'u' }]);
    check('去重开着：收过的被跳过', !p6.queue.has('douyin:555'), p6.queue.size);

    p6.settings.dedupe = false;
    await p6.ingest([{ id: '555', platform: 'douyin', title: '已经收过的视频', cover: '', url: 'u' }]);
    check('去重关掉：同一视频能再进来', p6.queue.has('douyin:555'));

    /* --- 22-3 从白板重建 --- */
    const idA = '7624861045890288942';
    const idB = '7624861045890288943';
    const canvasA = JSON.stringify({
      nodes: [{ type: 'file', file: `video-covers/douyin-${idA}.jpg` }],
      edges: [],
    });
    const canvasB = JSON.stringify({
      nodes: [{ type: 'text', text: `[▶](https://www.douyin.com/video/${idB})` }],
      edges: [],
    });
    const app7 = mkApp();
    app7.vault.read = async (f) => (f.path === 'a.canvas' ? canvasA : canvasB);
    app7.vault.getFiles = () => [
      { path: 'a.canvas', extension: 'canvas' },
      { path: 'b.canvas', extension: 'canvas' },
      { path: 'note.md', extension: 'md' },
    ];

    const p7 = new P(app7, { id: 'sfb' });
    await p7.loadSettings();
    p7.settings.synced = { douyin: [idA, idB, '999'], bilibili: [], xhs: [] };

    const r = await p7.rebuildSynced();
    check('只扫 canvas，跳过 md', r.canvases === 2, r.canvases);
    check('重建后只留白板上存在的 2 条', r.after === 2, r.after);
    check('白板上不存在的 999 被清掉', p7.settings.synced.douyin.indexOf('999') === -1, p7.settings.synced.douyin);
    check('保留下来的正是白板上那两条', p7.settings.synced.douyin.slice().sort().join(',') === [idA, idB].sort().join(','), p7.settings.synced.douyin);
    check('重建已写回配置', (p7._data && p7._data.synced && p7._data.synced.douyin.length) === 2);
  }

  /* =========================================================
   * 二十三、关键词分类与白板分组
   * ========================================================= */
  console.log('\n[23] 关键词分类与白板分组');
  {
    const cardText = (title, pid, id) =>
      `**${title}**\n\n某某作者 · 抖音\n\n[▶ 打开原视频](https://www.douyin.com/video/${id})\n<!-- ${pid}:${id} -->`;
    const mkCanvasApp = (nodes) => {
      const state = { json: JSON.stringify({ nodes, edges: [] }) };
      const file = { path: 'x.canvas', extension: 'canvas' };
      const app = {
        vault: {
          getAbstractFileByPath: (p) => (p === 'x.canvas' ? file : null),
          read: async () => state.json,
          modify: async (f, s) => {
            state.json = s;
          },
          adapter: { exists: async () => false, remove: async () => {} },
          createFolder: async () => {},
          createBinary: async () => {},
          getFiles: () => [],
        },
        workspace: { getLeavesOfType: () => [], getActiveFile: () => null },
      };
      return { app, state };
    };

    check('关键词按中英文逗号/空格拆分', T.splitKeywords('探店, 菜谱；好吃、下饭 合集').join('|') === '探店|菜谱|好吃|下饭|合集', T.splitKeywords('探店, 菜谱；好吃、下饭 合集'));

    const rules = [
      { id: 'r1', name: '美食', keywords: '探店,菜谱', color: '4' },
      { id: 'r2', name: '旅行', keywords: 'vlog,攻略', color: '2' },
    ];

    check('标题命中就归该类', T.matchRule({ title: '这家店探店真香' }, rules).name === '美食');
    check('标题都没中再退回正文', T.matchRule({ title: '随便', text: '一段旅行vlog' }, rules).name === '旅行');
    check('都没命中返回 null', T.matchRule({ title: '猫猫日常' }, rules) === null);
    check('英文不区分大小写', T.matchRule({ title: '周末 VLOG 记录' }, rules).name === '旅行');
    check(
      '多条都命中时按规则顺序取第一条',
      T.matchRule({ title: '旅行探店' }, rules).name === '美食',
      T.matchRule({ title: '旅行探店' }, rules).name
    );

    /* 卡片单元 = 封面图 + 文字卡 */
    const imgNode = { id: 'img1', type: 'file', file: 'covers/a.jpg', x: 0, y: 0, width: 340, height: 200 };
    const card1 = { id: 't1', type: 'text', text: cardText('探店合集', 'douyin', '111'), x: 0, y: 210, width: 340, height: 150 };
    const userNote = { id: 'u1', type: 'text', text: '我自己的笔记', x: 900, y: 900, width: 300, height: 100 };

    const units = T.collectUnits([imgNode, card1, userNote]);
    check('图片与文字配成一个单元', units.length === 1 && units[0].nodes.length === 2);
    check('单元高度覆盖图 + 文', units[0].h === 360, units[0].h);
    check('用户手写的卡片不算进来', units.every((u) => u.nodes.every((n) => n.id !== 'u1')));

    /* 写入时自动分类：两张卡各进各的组 */
    const p8 = new P(mockApp, { id: 'sfb' });
    await p8.loadSettings();
    const cards = [
      { id: '1', platform: 'douyin', title: '深夜食堂探店', url: 'https://x/1', imagePath: 'covers/1.jpg', imageSize: { w: 16, h: 9 } },
      { id: '2', platform: 'douyin', title: '川西旅行攻略', url: 'https://x/2' },
    ];
    const built = T.buildClassifiedNodes([], cards, p8.settings, rules);
    const groups = built.nodes.filter((n) => n.type === 'group');
    check('两条规则各建一个分组框', groups.length === 2, groups.map((g) => g.label));
    check('分组框带颜色', groups[0].color === '4' && groups[1].color === '2', groups.map((g) => g.color));

    const gFood = groups.find((g) => g.label === '美食');
    const gTrip = groups.find((g) => g.label === '旅行');
    const foodText = built.nodes.find((n) => n.type === 'text' && n.text.indexOf('深夜食堂') >= 0);
    const tripText = built.nodes.find((n) => n.type === 'text' && n.text.indexOf('川西') >= 0);
    const inside = (n, g) =>
      n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height;
    check('美食卡落在美食框里', inside(foodText, gFood));
    check('旅行卡落在旅行框里', inside(tripText, gTrip));
    check('两框互不重叠', gFood.y + gFood.height <= gTrip.y);
    check('卡片带分类标签', foodText.text.indexOf('#美食') >= 0, foodText.text);

    /* 整理整块白板 */
    const messy = [
      { id: 't1', type: 'text', text: cardText('探店合集', 'douyin', '111'), x: 2000, y: 800, width: 340, height: 150 },
      { id: 't2', type: 'text', text: cardText('川西旅行攻略', 'douyin', '222'), x: 2600, y: 1200, width: 340, height: 150 },
      { id: 't3', type: 'text', text: cardText('猫猫日常', 'douyin', '333'), x: 3000, y: 400, width: 340, height: 150 },
      { id: 'u1', type: 'text', text: '我自己的笔记', x: 4000, y: 100, width: 300, height: 100 },
    ];
    const { app: appO, state: stateO } = mkCanvasApp(messy);
    const p9 = new P(mockApp, { id: 'sfb' });
    await p9.loadSettings();
    p9.settings.classifyRules = rules;

    const r1 = await T.organizeCanvas(appO, 'x.canvas', p9.settings);
    check('整理了 3 张卡片', r1.cards === 3, r1);
    check('分成 3 个框（含「其他」）', r1.groups === 3, r1.groups);

    const out1 = JSON.parse(stateO.json);
    const og = out1.nodes.filter((n) => n.type === 'group');
    check('结果写回了白板文件', og.length === 3, og.map((g) => g.label));
    check('「其他」框在', og.some((g) => g.label === '其他'));
    const note = out1.nodes.find((n) => n.id === 'u1');
    check('用户手写卡片原位没动', note && note.x === 4000 && note.y === 100, note && [note.x, note.y]);
    check('分组框在卡片下方空白处，不压原有内容', og.every((g) => g.y > 300), og.map((g) => g.y));

    /* 再整理一次：不会叠加出重复的框 */
    const r2 = await T.organizeCanvas(appO, 'x.canvas', p9.settings);
    const out2 = JSON.parse(stateO.json);
    check('重复整理不叠加分组框', out2.nodes.filter((n) => n.type === 'group').length === 3, out2.nodes.filter((n) => n.type === 'group').length);
    check('重复整理卡片数不变', r2.cards === 3, r2.cards);
    check('重复整理后卡片仍在框里', out2.nodes.filter((n) => n.type === 'text' && n.text.indexOf('打开原视频') >= 0).every((t) => og.some((g) => t.x >= g.x && t.y >= g.y)));
  }

  console.log('\n[24] 小红书卡片链接兜底');
  {
    const topic = { name: '收藏', color: '5' };

    const withTok = T.buildCardText(
      {
        platform: 'xhs',
        title: '露营装备清单',
        author: '某人',
        url: 'https://www.xiaohongshu.com/explore/aaa?xsec_token=TOK&xsec_source=pc_user',
      },
      topic
    );
    check('带 token 时有原帖链接', withTok.indexOf('打开原帖') >= 0, withTok);
    check('带 token 链接原样保留', withTok.indexOf('xsec_token=TOK') >= 0, withTok);
    check('带 token 时仍留搜索兜底', withTok.indexOf('按标题搜索') >= 0, withTok);

    const noTok = T.buildCardText(
      { platform: 'xhs', title: '露营装备清单', url: 'https://www.xiaohongshu.com/explore/aaa' },
      topic
    );
    check('没 token 时不放必然 404 的原链接', noTok.indexOf('explore/aaa') < 0, noTok);
    check('没 token 时给搜索入口', noTok.indexOf('在小红书搜索这条') >= 0, noTok);
    check(
      '搜索链接带标题关键词',
      noTok.indexOf(encodeURIComponent('露营装备清单')) >= 0,
      noTok
    );

    const dy = T.buildCardText(
      { platform: 'douyin', title: '一段视频', url: 'https://www.douyin.com/video/123' },
      topic
    );
    check('抖音卡片照旧给原视频链接', dy.indexOf('[▶ 打开原视频](https://www.douyin.com/video/123)') >= 0, dy);

    const bi = T.buildCardText(
      { platform: 'bilibili', title: '一个视频', url: 'https://www.bilibili.com/video/BV1xx' },
      topic
    );
    check('B站卡片照旧给原视频链接', bi.indexOf('[▶ 打开原视频](https://www.bilibili.com/video/BV1xx)') >= 0, bi);
  }

  console.log('\n[25] 卡片收录日期');
  {
    const topic = { name: '收藏', color: '5' };
    const at = new Date(2026, 9, 31, 12, 0, 0).getTime();

    const withDay = T.buildCardText({ platform: 'douyin', title: 'A', url: 'https://x/1', at }, topic);
    check('抓取时间显示为日期', withDay.indexOf('收录 2026-10-31') >= 0, withDay);
    check('日期在标题下方，链接之前', withDay.indexOf('收录 2026-10-31') < withDay.indexOf('打开原视频'), withDay);

    const noDay = T.buildCardText({ platform: 'douyin', title: 'A', url: 'https://x/1' }, topic);
    check('旧数据没有时间就不显示', noDay.indexOf('收录') < 0, noDay);

    const bad = T.buildCardText({ platform: 'douyin', title: 'A', url: 'https://x/1', at: 'abc' }, topic);
    check('非法时间戳不显示', bad.indexOf('收录') < 0, bad);

    const zero = T.buildCardText({ platform: 'douyin', title: 'A', url: 'https://x/1', at: 0 }, topic);
    check('时间为 0 不显示', zero.indexOf('收录') < 0, zero);
  }

  console.log('\n[26] 平台占位声明过滤');
  {
    const DECL = '｜ 违法和不良信息举报：400-140-2108 feedback@douyin.com ｜ 算法推荐专项举报：sfjubao@bytedance.com | 体育饭圈专项举报：tyfq@bytedance.com';
    check('插件端识别举报声明为垃圾', T.isJunkTitle(DECL) === true);
    check('扩展端识别举报声明为垃圾', CT.isJunkTitle(DECL) === true);
    check('插件端识别许可证占位为垃圾', T.isJunkTitle('｜ 网络文化经营许可证 京网文〔2025〕0181-061号 ｜') === true);
    check('扩展端识别许可证占位为垃圾', CT.isJunkTitle('｜ 网络文化经营许可证 京网文〔2025〕0181-061号 ｜') === true);
    check('正常标题含「许可证」不误伤', T.isJunkTitle('考下一个许可证要多久') === false);
    check('宗教许可证占位（｜…｜包裹）为垃圾', T.isJunkTitle('｜ 互联网宗教信息服务许可证 京（2025）0000017 ｜') === true);
    check('扩展端 ｜…｜ 包裹也为垃圾', CT.isJunkTitle('｜ 互联网宗教信息服务许可证 京（2025）0000017 ｜') === true);
    check('普通句子不含包裹不算垃圾', T.isJunkTitle('今天聊聊｜choose 的事') === false);
    check('含 bytedance 邮箱的标题被过滤', T.isJunkTitle('联系我 sfjubao@bytedance.com 看详情') === true);
    check('正常读书标题不受影响', T.isJunkTitle('认知觉醒 我推荐所有渴望向上的人去读这本书') === false);
    check('正常音乐标题不受影响', T.isJunkTitle('夏天一直循环 直到地球毁灭') === false);
    check('空标题仍是垃圾', T.isJunkTitle('') === true && T.isJunkTitle('a') === true);
  }

  console.log('\n[27] 自动分类不再压到已有卡片上');
  {
    const cardText = (title, id) =>
      `**${title}**\n\n某某 · 抖音\n\n[▶ 打开原视频](https://www.douyin.com/video/${id})`;
    const rules = [{ id: 'r1', name: '美食', keywords: '探店', color: '4' }];

    const hits = (a, b) =>
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

    const mkApp = (nodes) => {
      const state = { json: JSON.stringify({ nodes, edges: [] }) };
      const file = { path: 'x.canvas', extension: 'canvas' };
      return {
        state,
        app: {
          vault: {
            getAbstractFileByPath: (p) => (p === 'x.canvas' ? file : null),
            read: async () => state.json,
            modify: async (f, s2) => {
              state.json = s2;
            },
            adapter: { exists: async () => false, remove: async () => {} },
            createFolder: async () => {},
            createBinary: async () => {},
            getFiles: () => [],
          },
          workspace: { getLeavesOfType: () => [], getActiveFile: () => null },
        },
      };
    };

    /* 一批老卡片：中途就有一列很长的卡，底部延伸得很低 */
    const old = [];
    for (let i = 0; i < 12; i++) {
      old.push({ id: 'old' + i, type: 'text', text: cardText('旧卡' + i, 900 + i), x: 0, y: i * 700, width: 340, height: 500 });
    }

    const p = new P(mockApp, { id: 'sfb' });
    await p.loadSettings();

    const cards = [
      { id: 'a1', platform: 'douyin', title: '深夜探店合集', url: 'https://x/a1' },
      { id: 'a2', platform: 'douyin', title: '街边探店第二弹', url: 'https://x/a2' },
    ];
    const built = T.buildClassifiedNodes(old, cards, p.settings, rules);
    const g = built.nodes.filter((n) => n.type === 'group');
    check('只建了一个框', g.length === 1, g.length);

    const foreign = built.nodes.filter((n) => n.type !== 'group' && n.id.indexOf('old') === 0);
    check('新框没有压住任何旧卡', g.every((box) => foreign.every((n) => !hits(box, n))) === true);

    /* 第二批复用已有框，一张张往下排，也不能互相压 */
    const more = [
      { id: 'b1', platform: 'douyin', title: '探店第三集', url: 'https://x/b1' },
      { id: 'b2', platform: 'douyin', title: '探店第四集', url: 'https://x/b2' },
    ];
    const built2 = T.buildClassifiedNodes(built.nodes, more, p.settings, rules);
    const g2 = built2.nodes.filter((n) => n.type === 'group');
    check('复用原来的框，不新建', g2.length === 1, g2.length);
    const inBox = (t) => t.x >= g2[0].x && t.y >= g2[0].y && t.x + t.width <= g2[0].x + g2[0].width;
    const texts = built2.nodes.filter((n) => n.type === 'text' && n.text.indexOf('打开原视频') >= 0 && inBox(n));
    check('第一批 + 第二批共 4 张都在框内', texts.length === 4, texts.length);
    let cross = 0;
    for (let i = 0; i < texts.length; i++) {
      for (let k = i + 1; k < texts.length; k++) if (hits(texts[i], texts[k])) cross++;
    }
    check('卡片之间一个都不重叠', cross === 0, cross);
    check('框高度能装下所有卡', g2[0].height >= Math.max(...texts.map((t) => t.y + t.height)) - g2[0].y, g2[0].height);
    check('旧卡一张都没被挪动', built2.nodes.filter((n) => n.id.indexOf('old') === 0).every((n, i) => n.x === 0 && n.y === i * 700));

    /* 整理：白板里散乱的卡 + 一个落在很下面的节点 */
    const messy = [
      { id: 't1', type: 'text', text: cardText('探店合集', 111), x: 2000, y: 800, width: 340, height: 150 },
      { id: 't2', type: 'text', text: cardText('猫猫日常', 222), x: 2600, y: 1200, width: 340, height: 150 },
      { id: 't3', type: 'text', text: cardText('探店第二弹', 333), x: 3000, y: 400, width: 340, height: 150 },
      { id: 'u1', type: 'text', text: '我的笔记', x: 4000, y: 100, width: 300, height: 100 },
      { id: 'u2', type: 'group', label: '我自己的框', x: 2100, y: 3000, width: 900, height: 600, color: '3' },
    ];
    const { app: appO, state: stateO } = mkApp(messy);
    const p2 = new P(mockApp, { id: 'sfb' });
    await p2.loadSettings();
    p2.settings.classifyRules = rules;
    await T.organizeCanvas(appO, 'x.canvas', p2.settings);

    const out = JSON.parse(stateO.json);
    const newGroups = out.nodes.filter((n) => n.type === 'group' && n.id !== 'u2');
    const mine = out.nodes.find((n) => n.id === 'u2');
    check('用户自己的框还在原位', mine && mine.x === 2100 && mine.y === 3000, mine && [mine.x, mine.y]);
    check('自动框没有压住用户自己的框', newGroups.every((b) => !hits(b, mine)) === true);
    check('自动框之间不重叠', (() => {
      for (let i = 0; i < newGroups.length; i++)
        for (let k = i + 1; k < newGroups.length; k++) if (hits(newGroups[i], newGroups[k])) return false;
      return true;
    })());
    const cardNodes = out.nodes.filter((n) => n.type === 'text' && n.text.indexOf('打开原视频') >= 0);
    check('卡片都落在某个框里', cardNodes.every((t) => newGroups.concat([mine]).some((b) => hits(t, b))));
  }

  console.log('\n[28] 小红书卡片也认得出来（整理时不漏卡）');
  {
    const dou = '**探店vlog**\n\n某某 · 抖音\n\n[▶ 打开原视频](https://www.douyin.com/video/7300000000000000001)';
    const xhsTok = '**笔记标题**\n\n某某 · 小红书\n\n[▶ 打开原帖](https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f60718293a?xsec_token=ABC)\n[🔍 按标题搜索](https://www.xiaohongshu.com/search_result?keyword=x)';
    const xhsNoTok = '**没 token 的笔记**\n\n某某 · 小红书\n\n[🔍 在小红书搜索这条](https://www.xiaohongshu.com/search_result?keyword=y)';

    check('抖音卡认得出', T.isCardText(dou) === true);
    check('小红书带 token 卡认得出', T.isCardText(xhsTok) === true);
    check('小红书无 token 卡也认得出', T.isCardText(xhsNoTok) === true);
    check('自己写的笔记不算卡片', T.isCardText('我自己的笔记\n随便写点什么') === false);
    check('空文本不算卡片', T.isCardText('') === false);

    /* 小红书的图 + 文要配成一个单元（封面在文字上方 10px） */
    const img = { id: 'xi', type: 'file', file: 'video-covers/xhs-65f0a1b2c3d4e5f60718293a.webp', x: 0, y: 0, width: 340, height: 400 };
    const txt = { id: 'xt', type: 'text', text: xhsNoTok, x: 0, y: 410, width: 340, height: 176 };
    const units = T.collectUnits([img, txt]);
    check('小红书卡片被识别成一个单元', units.length === 1, units.length);
    check('封面和文字都跟着搬', units.length === 1 && units[0].nodes.length === 2);

    /* 整理整块白板：抖音 + 小红书 + 用户笔记，一张都不能少 */
    const state = { json: '' };
    const nodes = [
      { id: 'd1', type: 'text', text: dou, x: 0, y: 0, width: 340, height: 176 },
      { id: 'x1', type: 'text', text: xhsNoTok, x: 0, y: 300, width: 340, height: 176 },
      { id: 'u1', type: 'text', text: '我的笔记', x: 1200, y: 0, width: 300, height: 100 },
    ];
    state.json = JSON.stringify({ nodes, edges: [] });
    const file = { path: 'x.canvas', extension: 'canvas' };
    const app = {
      vault: {
        getAbstractFileByPath: () => file,
        read: async () => state.json,
        modify: async (f, s2) => {
          state.json = s2;
        },
        adapter: { exists: async () => false, remove: async () => {} },
        createFolder: async () => {},
        createBinary: async () => {},
        getFiles: () => [],
      },
      workspace: { getLeavesOfType: () => [], getActiveFile: () => null },
    };
    const p = new P(mockApp, { id: 'sfb' });
    await p.loadSettings();
    p.settings.classifyRules = [{ id: 'r1', name: '美食', keywords: '探店', color: '4' }];

    const r = await T.organizeCanvas(app, 'x.canvas', p.settings);
    check('两张卡都被整理（小红书没被落下）', r.cards === 2, r);
    const out = JSON.parse(state.json);
    const kept = out.nodes.filter((n) => n.type === 'text');
    check('节点总数没变少：3 个文本节点都在', kept.length === 3, kept.map((n) => n.id));
    check('小红书卡进了分组框', (() => {
      const g = out.nodes.find((n) => n.type === 'group' && n.label === '其他');
      const t = out.nodes.find((n) => n.id === 'x1');
      return !!g && t.x >= g.x && t.y >= g.y && t.x + t.width <= g.x + g.width && t.y + t.height <= g.y + g.height;
    })());
    check('用户笔记原位不动', out.nodes.some((n) => n.id === 'u1' && n.x === 1200 && n.y === 0));
  }

  console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试崩了：', e);
  process.exit(1);
});
