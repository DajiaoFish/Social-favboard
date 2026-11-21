/**
 * background.js —— 后台服务
 *
 * 负责：把页面收集到的条目暂存到扩展本地存储，并转发给本机的 Obsidian 插件。
 * 只和 127.0.0.1 通信，不接触任何平台。
 */

const PORT_RANGE = [27123, 27124, 27125, 27126, 27127, 27128];
const APP_TAG = 'social-favboard';

let bridgeCache = null;

async function getBridge(force) {
  if (bridgeCache && !force) return bridgeCache;

  const st = await chrome.storage.local.get(['sfbPort', 'sfbToken']);
  if (st.sfbPort && !force) {
    try {
      const r = await fetch(`http://127.0.0.1:${st.sfbPort}/ping`);
      if (r.ok) {
        const j = await r.json();
        if (j && j.app === APP_TAG) {
          bridgeCache = { port: st.sfbPort, token: j.token || st.sfbToken || '' };
          return bridgeCache;
        }
      }
    } catch (e) {
      /* 落到下面的探测 */
    }
  }

  for (const p of PORT_RANGE) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/ping`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.app === APP_TAG) {
        bridgeCache = { port: p, token: j.token || '' };
        await chrome.storage.local.set({ sfbPort: p, sfbToken: bridgeCache.token });
        return bridgeCache;
      }
    } catch (e) {
      /* 端口没开，继续试下一个 */
    }
  }
  return null;
}

async function loadPending() {
  const st = await chrome.storage.local.get('sfbPending');
  return Array.isArray(st.sfbPending) ? st.sfbPending : [];
}

async function savePending(arr) {
  await chrome.storage.local.set({ sfbPending: arr.slice(-5000) });
}

async function postItems(items) {
  const b = await getBridge(false);
  if (!b) throw new Error('没找到 Obsidian 插件，请确认插件已启用');

  const res = await fetch(`http://127.0.0.1:${b.port}/collect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SFB-Token': b.token,
    },
    body: JSON.stringify({ items }),
  });

  if (res.status === 401) {
    bridgeCache = null;
    await chrome.storage.local.remove(['sfbPort', 'sfbToken']);
    throw new Error('配对令牌不匹配，请重新打开 Obsidian 插件');
  }
  if (!res.ok) throw new Error('插件返回 HTTP ' + res.status);

  return await res.json();
}

async function handleItems(incoming) {
  const existing = await loadPending();
  const map = new Map();
  for (const it of existing) {
    if (it && it.id) map.set(it.platform + ':' + it.id, it);
  }
  for (const it of incoming) {
    if (it && it.id) map.set(it.platform + ':' + it.id, it);
  }
  const all = Array.from(map.values());
  await savePending(all);

  /* 自检用：记下最近一条能用的链接，弹窗里一眼看出小红书有没有带 xsec_token */
  try {
    const withTok = incoming.filter((it) => it.platform === 'xhs' && /xsec_token=/.test(it.url || ''));
    const last = withTok.length ? withTok[withTok.length - 1] : incoming[incoming.length - 1];
    if (last && last.url) {
      await chrome.storage.local.set({
        sfbLast: { url: String(last.url).slice(0, 600), platform: last.platform || '', at: Date.now() },
      });
    }
  } catch (e) {
    /* ignore */
  }

  let sent = 0;
  let error = '';
  try {
    /*
     * 连以前积压的一起发。
     * 旧版只发 incoming，只要有一次没连上 Obsidian，那批就永远卡在暂存里，
     * 用户看不到任何提示 —— 这正是「滚了半天白板没反应」的根因。
     */
    const batch = all.slice(-300);
    const j = await postItems(batch);
    if (j && j.ok) {
      sent = j.accepted || 0;
      /* 插件已经处理过的（含被它过滤掉的）都算送达，不再重发，否则角标永远清不掉 */
      const done = new Set(batch.map((it) => it.platform + ':' + it.id));
      const rest = (await loadPending()).filter((it) => !done.has(it.platform + ':' + it.id));
      await savePending(rest);
    }
  } catch (e) {
    error = (e && e.message) || String(e);
  }

  await refreshBadge();
  return { ok: !error, sent, total: (await loadPending()).length, error };
}

/**
 * 工具栏角标：
 *   暂停 → OFF（灰）
 *   有积压没送出去 → 数字（橙），用户不用打开弹窗就知道还有东西没进 Obsidian
 *   正常 → 空
 */
async function updateBadge(paused, count) {
  try {
    let text = '';
    if (paused) text = 'OFF';
    else if (count > 0) text = count > 99 ? '99+' : String(count);
    await chrome.action.setBadgeText({ text });

    if (paused) {
      await chrome.action.setBadgeBackgroundColor({ color: '#b4b2a9' });
      await chrome.action.setTitle({ title: 'Social Favboard · 已暂停' });
    } else if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#e08a3c' });
      await chrome.action.setTitle({ title: `Social Favboard · 还有 ${count} 条待发送` });
    } else {
      await chrome.action.setBadgeBackgroundColor({ color: '#4a8f5b' });
      await chrome.action.setTitle({ title: 'Social Favboard · 正在收集' });
    }
  } catch (e) {
    /* 旧版浏览器可能不支持，不影响主流程 */
  }
}

/* 读一次状态再刷新角标，避免各处重复算 */
async function refreshBadge() {
  let paused = false;
  try {
    const v = await chrome.storage.local.get({ sfbPaused: false });
    paused = !!(v && v.sfbPaused);
  } catch (e) {
    /* ignore */
  }
  const pending = await loadPending();
  await updateBadge(paused, pending.length);
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;

  if (msg.type === 'sfb-badge') {
    refreshBadge();
    return;
  }

  if (msg.type === 'sfb-items') {
    (async function () {
      try {
        const r = await handleItems(Array.isArray(msg.items) ? msg.items : []);
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'sfb-status') {
    (async function () {
      const b = await getBridge(false);
      const pending = await loadPending();
      sendResponse({ connected: !!b, port: b ? b.port : null, pending: pending.length });
    })();
    return true;
  }

  if (msg.type === 'sfb-flush') {
    (async function () {
      try {
        const all = await loadPending();
        if (!all.length) {
          sendResponse({ ok: true, sent: 0, total: 0 });
          return;
        }
        const j = await postItems(all);
        const done = new Set((j && j.ids) || []);
        const rest = all.filter((it) => !done.has(it.platform + ':' + it.id));
        await savePending(rest);
        sendResponse({ ok: true, sent: (j && j.accepted) || 0, total: rest.length });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'sfb-clear') {
    (async function () {
      await savePending([]);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'sfb-reset-bridge') {
    (async function () {
      bridgeCache = null;
      await chrome.storage.local.remove(['sfbPort', 'sfbToken']);
      const b = await getBridge(true);
      sendResponse({ ok: !!b, port: b ? b.port : null });
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(function () {
  getBridge(true);
});

// 浏览器重启后角标要跟着恢复，否则 Icon 上什么都不显示，看不出已暂停 / 还有积压
try {
  refreshBadge();
} catch (e) {
  /* 忽略 */
}
