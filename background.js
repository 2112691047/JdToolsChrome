'use strict';

// ====== 京东客服工具集 - Chrome MV3 Service Worker ======
// 合并了三个扩展的后台逻辑：
//   1. UadTool - UAD_FETCH 代理
//   2. JingDouQueryTool - JD_BEAN_TOOL_FETCH_TEXT 代理
//   3. SmsQueryTool - JD_SMS_TOOL_FETCH_TEXT / BUNDLE_HASH / WARM_TOKEN
//   4. page-hook.js 动态注入（Chrome MV3 不支持 content_scripts world: "MAIN"）

// —— 域名白名单 ——
const ALLOWED_ORIGINS = new Set([
  'https://crm.jd.com',
  'http://crm.jd.com',
  'http://newadmin.jpos.jd.com',
  'http://kfuad.jd.com',
  'https://kfuad.jd.com',
  'http://sms.jd.com',
  'https://sms.jd.com',
  'https://man-sff.jd.com',
  'https://storage.360buyimg.com',
  'https://case-monitor-new.jd.com'
]);

function normalizeCredentialsMode(value, fallback) {
  return ['include', 'omit', 'same-origin'].includes(value) ? value : fallback;
}

function inferCredentialsMode(url) {
  if (url.hostname === 'storage.360buyimg.com') return 'omit';
  return 'include';
}

function normalizeHeaders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { Accept: '*/*' };
  return Object.assign({ Accept: '*/*' }, input);
}

// —— UadTool: UAD_FETCH ——
function handleUadFetch(message, sendResponse) {
  const { url, method, headers, body } = message;
  (async () => {
    const target = new URL(url);
    if (target.origin !== 'https://case-monitor-new.jd.com' && target.origin !== 'http://case-monitor-new.jd.com') {
      throw new Error('UAD_FETCH 不允许访问的地址：' + target.origin);
    }
    const res = await fetch(target.href, {
      method: method || 'POST',
      headers: headers || {},
      body: body || null,
      credentials: 'include'
    });
    const text = await res.text();
    sendResponse({ ok: res.ok, status: res.status, text });
  })().catch(err => {
    sendResponse({ ok: false, status: 0, text: '', error: err && err.message ? err.message : String(err) });
  });
}

// —— JingDouQueryTool & SmsQueryTool: JD_BEAN_TOOL_FETCH_TEXT / JD_SMS_TOOL_FETCH_TEXT ——
function handleWhitelistedFetch(message, sendResponse) {
  const opts = message.options || {};
  (async () => {
    const target = new URL(message.url);
    if (!ALLOWED_ORIGINS.has(target.origin)) {
      throw new Error('不允许访问的地址：' + target.origin);
    }

    const method = String(opts.method || 'GET').toUpperCase();
    const credentials = normalizeCredentialsMode(opts.credentials, inferCredentialsMode(target));
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 30000, 1000), 120000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(target.href, {
        method,
        headers: normalizeHeaders(opts.headers),
        body: opts.body || undefined,
        credentials,
        redirect: 'follow',
        signal: controller.signal
      });
      const text = await res.text();
      sendResponse({
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: res.url,
        text
      });
    } finally {
      clearTimeout(timer);
    }
  })().catch(err => {
    sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
  });
}

// —— 鉴权自动预热 ——
const TOKEN_KEY = 'jd_sms_mlaas_token';
const TOKEN_TS_KEY = 'jd_sms_mlaas_token_ts';
const WARM_TIMEOUT_MS = 12000;
const KFUAD_WARM_URL = 'https://kfuad.jd.com/';

let _warmPromise = null;

function getStored() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get([TOKEN_KEY, TOKEN_TS_KEY], r => {
        resolve({ token: (r && r[TOKEN_KEY]) || '', ts: Number((r && r[TOKEN_TS_KEY]) || 0) });
      });
    } catch (_) { resolve({ token: '', ts: 0 }); }
  });
}

function findExistingKfuadTab() {
  return new Promise(resolve => {
    try {
      chrome.tabs.query({ url: ['*://kfuad.jd.com/*'] }, tabs => {
        resolve(Array.isArray(tabs) ? tabs : []);
      });
    } catch (_) { resolve([]); }
  });
}

function createBackgroundTab(url) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create({ url, active: false }, tab => {
        const err = chrome.runtime.lastError;
        if (err || !tab) return reject(new Error((err && err.message) || 'tab_create_failed'));
        resolve(tab);
      });
    } catch (e) { reject(e); }
  });
}

function removeTabQuiet(id) {
  return new Promise(resolve => {
    try { chrome.tabs.remove(id, () => { void chrome.runtime.lastError; resolve(); }); }
    catch (_) { resolve(); }
  });
}

async function doWarm() {
  const before = await getStored();
  const beforeTs = before.ts || 0;

  const existing = await findExistingKfuadTab();
  let createdTabId = null;
  if (!existing.length) {
    try {
      const tab = await createBackgroundTab(KFUAD_WARM_URL);
      createdTabId = tab.id;
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'tab_create_failed', token_ts: beforeTs };
    }
  }

  const refreshed = await new Promise(resolve => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); };
    const onChange = (changes, area) => {
      if (area !== 'local') return;
      const c = changes[TOKEN_TS_KEY];
      if (c && Number(c.newValue) > beforeTs) {
        try { chrome.storage.onChanged.removeListener(onChange); } catch (_) {}
        finish(true);
      }
    };
    try { chrome.storage.onChanged.addListener(onChange); } catch (_) {}
    setTimeout(() => {
      try { chrome.storage.onChanged.removeListener(onChange); } catch (_) {}
      finish(false);
    }, WARM_TIMEOUT_MS);
  });

  if (createdTabId != null) await removeTabQuiet(createdTabId);

  const after = await getStored();
  const ok = refreshed && after.token && after.ts > beforeTs;
  return {
    ok,
    error: ok ? '' : (existing.length
      ? '已打开 kfuad 页面但未检测到新鉴权，请在该页面随便点击一次后重试'
      : '未能自动刷新鉴权（可能未登录 kfuad）。请手动打开 https://kfuad.jd.com 完成登录后重试'),
    token_ts: after.ts || 0,
    created_tab: createdTabId != null,
    reused_existing: !!existing.length
  };
}

function warmTokenOnce() {
  if (_warmPromise) return _warmPromise;
  _warmPromise = doWarm().finally(() => { _warmPromise = null; });
  return _warmPromise;
}

// —— 统一消息监听 ——
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'UAD_FETCH':
      handleUadFetch(message, sendResponse);
      return true;

    case 'JD_BEAN_TOOL_FETCH_TEXT':
    case 'JD_SMS_TOOL_FETCH_TEXT':
      handleWhitelistedFetch(message, sendResponse);
      return true;

    case 'JD_SMS_TOOL_WARM_TOKEN':
      warmTokenOnce()
        .then(data => sendResponse({ ok: true, data }))
        .catch(err => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
      return true;

    default:
      return false;
  }
});

// —— Chrome MV3: 动态注入 page-hook.js 到 MAIN world ——
// Chrome MV3 不支持 manifest.json 的 content_scripts.world: "MAIN"，
// 改用 chrome.scripting.registerContentScripts 在安装时注册。
const PAGE_HOOK_MATCHES = [
  'http://kfuad.jd.com/*',
  'https://kfuad.jd.com/*',
  'https://crm.jd.com/*',
  'http://crm.jd.com/*',
  'https://sms.jd.com/*',
  'http://sms.jd.com/*'
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.scripting.registerContentScripts([{
    id: 'jd-page-hook',
    matches: PAGE_HOOK_MATCHES,
    js: ['page-hook.js'],
    runAt: 'document_start',
    world: 'MAIN'
  }]).catch(() => {});
});

// Service Worker 启动时也尝试注册（防止 onInstalled 未触发）
chrome.scripting.getRegisteredContentScripts({ ids: ['jd-page-hook'] }).then(scripts => {
  if (!scripts || !scripts.length) {
    chrome.scripting.registerContentScripts([{
      id: 'jd-page-hook',
      matches: PAGE_HOOK_MATCHES,
      js: ['page-hook.js'],
      runAt: 'document_start',
      world: 'MAIN'
    }]).catch(() => {});
  }
}).catch(() => {});