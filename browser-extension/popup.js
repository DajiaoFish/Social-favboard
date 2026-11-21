const $ = (id) => document.getElementById(id);

let paused = false;

function setMsg(text, isErr) {
  const el = $('msg');
  el.textContent = text || '';
  el.className = 'msg' + (isErr ? ' err' : '');
}

function renderPower() {
  const b = $('toggle');
  b.textContent = paused ? '恢复收集' : '暂停收集';
  b.className = 'power' + (paused ? ' paused' : '');
  $('powerHint').textContent = paused
    ? '已暂停，不扫描、不抓取、不发送'
    : '正在收集，滚动页面时自动抓取';
}

chrome.storage.local.get({ sfbPaused: false }, (v) => {
  paused = !!(v && v.sfbPaused);
  renderPower();
});

$('toggle').addEventListener('click', () => {
  paused = !paused;
  renderPower();
  chrome.storage.local.set({ sfbPaused: paused }, () => {
    chrome.runtime.sendMessage({ type: 'sfb-badge', paused: paused });
    setMsg(paused ? '已暂停，所有标签页立即停止抓取' : '已恢复收集');
  });
});

async function refresh() {
  chrome.runtime.sendMessage({ type: 'sfb-status' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      $('statusText').textContent = '无法读取状态';
      return;
    }
    const dot = $('dot');
    dot.className = 'dot ' + (res.connected ? 'on' : 'off');
    $('statusText').textContent = res.connected
      ? '已连接 Obsidian 插件'
      : '未连接，请先启用 Obsidian 插件';
    $('pending').textContent = res.pending || 0;
    $('port').textContent = res.port ? '127.0.0.1:' + res.port : '—';
  });

  $('ver').textContent = 'v' + (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '?');

  /* 自检：最近抓到的一条链接长什么样，小红书有没有带上 xsec_token */
  chrome.storage.local.get('sfbLast', (st) => {
    const raw = (st && st.sfbLast && st.sfbLast.url) || '';
    const el = $('lastUrl');
    if (!raw) {
      el.textContent = '—';
      el.title = '';
      return;
    }
    if (/xiaohongshu\.com/.test(raw)) {
      el.textContent = /xsec_token=/.test(raw) ? '小红书 · 带 token ✓' : '小红书 · 缺 token ✗';
    } else if (/douyin\.com/.test(raw)) {
      el.textContent = '抖音 · 正常';
    } else if (/bilibili\.com/.test(raw)) {
      el.textContent = 'B站 · 正常';
    } else {
      el.textContent = raw.slice(0, 40);
    }
    el.title = raw;
  });
}

$('flush').addEventListener('click', () => {
  setMsg('发送中…');
  chrome.runtime.sendMessage({ type: 'sfb-flush' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      setMsg('发送失败', true);
      return;
    }
    if (res.ok) {
      setMsg(`已发送 ${res.sent} 条，剩余 ${res.total} 条`);
    } else {
      setMsg(res.error || '发送失败', true);
    }
    refresh();
  });
});

$('clear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'sfb-clear' }, () => {
    setMsg('已清空暂存');
    refresh();
  });
});

refresh();
setInterval(refresh, 1500);
