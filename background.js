// B站关注自动分组 - 后台服务
import { classifyByNameAndSign, classifyByTitles, GROUPS, UNCLEAR_GROUP_FALLBACK } from "./rules.js";

const VMID = "25126230"; // 你的B站UID（如需给其他账号使用，改成对方UID）
const API = "https://api.bilibili.com";
const DEV =
  "x-bili-device-req-json=" +
  encodeURIComponent('{"platform":"web","device":"pc","spmid":"333.1387","mobi_app":"web_cn"}');

const DEFAULTS = {
  enabled: true,
  intervalMin: 5,
  unclearTarget: UNCLEAR_GROUP_FALLBACK, // "其他与个人账号" 或 "default"
  baseline: {},        // mid -> 1（已记录的关注）
  baselineReady: false,
  log: [],             // 最近操作日志
  lastCheck: 0,
  processedCount: 0,   // 累计自动分组数
};

let tagCache = { ts: 0, tags: null };
const inFlight = new Set();

// ───────────────────────── 基础工具 ─────────────────────────

async function getSettings() {
  const cur = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...cur };
}

async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

async function getCsrf() {
  const c = await chrome.cookies.get({ url: "https://www.bilibili.com", name: "bili_jct" });
  return c ? c.value : null;
}

async function bapi(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: { Referer: "https://space.bilibili.com/" + VMID + "/" },
    ...opts,
  });
  return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function appendLog(entry) {
  const { log } = await getSettings();
  const next = [{ time: Date.now(), ...entry }, ...log].slice(0, 50);
  await saveSettings({ log: next });
}

async function setBadge(text) {
  try {
    await chrome.action.setBadgeText({ text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ color: "#FB7299" });
      await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    }
  } catch (e) {}
}

// ───────────────────────── B站接口封装 ─────────────────────────

async function getCsrfGuarded() {
  const csrf = await getCsrf();
  if (!csrf) throw new Error("未登录B站或Cookie不可用");
  return csrf;
}

async function fetchTags(force = false) {
  if (!force && tagCache.tags && Date.now() - tagCache.ts < 5 * 60 * 1000) return tagCache.tags;
  const j = await bapi(`/x/relation/tags?vmid=${VMID}`);
  if (j.code !== 0) throw new Error("获取分组失败: " + j.message);
  tagCache = { ts: Date.now(), tags: j.data || [] };
  return tagCache.tags;
}

async function createTag(name) {
  const csrf = await getCsrfGuarded();
  const j = await bapi(`/x/relation/tag/create?${DEV}&csrf=${csrf}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `tag=${encodeURIComponent(name)}&csrf=${csrf}`,
  });
  if (j.code === 0) {
    tagCache.ts = 0;
    return j.data.tagid;
  }
  throw new Error("创建分组失败: " + j.code + " " + j.message);
}

// 找到分组，没有则创建；创建失败返回 null
async function ensureTag(name) {
  const tags = await fetchTags();
  const hit = tags.find((t) => t.name === name);
  if (hit) return hit.tagid;
  try {
    return await createTag(name);
  } catch (e) {
    console.warn("[自动分组] 创建分组失败:", e.message);
    return null;
  }
}

async function getUsersToTag(tagName, unclearTarget) {
  // 返回目标tagid；分组缺失时按设置兜底
  let tagid = await ensureTag(tagName);
  if (tagid) return { tagid, resolved: tagName };
  if (unclearTarget !== "default") {
    tagid = await ensureTag(UNCLEAR_GROUP_FALLBACK);
    if (tagid) return { tagid, resolved: UNCLEAR_GROUP_FALLBACK };
  }
  return { tagid: null, resolved: "默认分组" };
}

async function assignToTag(mid, tagid) {
  const csrf = await getCsrfGuarded();
  const j = await bapi(`/x/relation/tags/addUsers?${DEV}&csrf=${csrf}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `fids=${mid}&tagids=${tagid}&csrf=${csrf}`,
  });
  if (j.code !== 0) throw new Error("移动分组失败: " + j.code + " " + j.message);
}

// 拉取全部关注列表（含名称/签名/认证）
async function fetchAllFollowings() {
  const out = [];
  for (let pn = 1; pn <= 40; pn++) {
    const j = await bapi(`/x/relation/followings?vmid=${VMID}&pn=${pn}&ps=50`);
    if (j.code !== 0) throw new Error("获取关注列表失败: " + j.message);
    const list = j.data?.list || [];
    out.push(...list);
    if (out.length >= (j.data?.total || 0) || list.length === 0) break;
    await sleep(200);
  }
  return out;
}

// 单个用户信息：优先从关注列表第一页找（新关注会在最前），找不到用card接口
async function fetchUserInfo(mid) {
  const j = await bapi(`/x/relation/followings?vmid=${VMID}&pn=1&ps=50`);
  if (j.code === 0) {
    const hit = (j.data?.list || []).find((u) => String(u.mid) === String(mid));
    if (hit) {
      return {
        uname: hit.uname,
        sign: hit.sign || "",
        verifyType: hit.official_verify?.type ?? -1,
        verifyDesc: hit.official_verify?.desc || "",
      };
    }
  }
  const c = await bapi(`/x/web-interface/card?mid=${mid}`);
  if (c.code === 0 && c.data?.card) {
    return { uname: c.data.card.name, sign: c.data.card.sign || "", verifyType: -1, verifyDesc: "" };
  }
  return { uname: "mid:" + mid, sign: "", verifyType: -1, verifyDesc: "" };
}

// 最近投稿标题（动态接口，免签名）
async function fetchRecentTitles(mid) {
  try {
    const j = await bapi(`/x/polymer/web-dynamic/v1/feed/space?host_mid=${mid}`);
    if (j.code !== 0) return [];
    const items = j.data?.items || [];
    return items
      .filter((it) => it.type === "DYNAMIC_TYPE_AV")
      .map((it) => it.modules?.module_dynamic?.major?.archive?.title || "")
      .filter(Boolean)
      .slice(0, 10);
  } catch (e) {
    return [];
  }
}

// ───────────────────────── 核心逻辑 ─────────────────────────

async function handleNewFollow(mid) {
  const { enabled, unclearTarget } = await getSettings();
  if (!enabled) return;
  mid = String(mid);
  if (inFlight.has(mid)) return;
  inFlight.add(mid);
  try {
    await sleep(2500); // 等关注关系生效
    const info = await fetchUserInfo(mid);

    // 阶段1：名称+签名+认证
    let group = classifyByNameAndSign(info);
    let stage = "名称签名";

    // 阶段2：投稿标题
    if (!group) {
      const titles = await fetchRecentTitles(mid);
      group = classifyByTitles(titles);
      stage = "投稿分析";
    }

    let result;
    if (!group) {
      // 无法判定
      if (unclearTarget === "default") {
        await appendLog({ uname: info.uname, group: "留在默认分组", stage: "无法判定" });
        await bumpProcessed();
        return;
      }
      result = await getUsersToTag(UNCLEAR_GROUP_FALLBACK, unclearTarget);
      group = result.resolved;
      stage = "无法判定";
    } else {
      result = await getUsersToTag(group, unclearTarget);
      group = result.resolved;
    }

    if (!result.tagid) {
      await appendLog({ uname: info.uname, group: "默认分组(创建分组失败)", stage });
      await bumpProcessed();
      return;
    }

    await assignToTag(mid, result.tagid);
    await bumpProcessed();
    await appendLog({ uname: info.uname, group, stage });
    await refreshBadge();
  } catch (e) {
    console.warn("[自动分组] 处理失败:", mid, e.message);
    await appendLog({ uname: "mid:" + mid, group: "处理失败: " + e.message, stage: "错误" });
  } finally {
    inFlight.delete(mid);
  }
}

async function bumpProcessed() {
  const { processedCount } = await getSettings();
  await saveSettings({ processedCount: processedCount + 1 });
  const { log } = await getSettings();
  const todayCount = log.filter((l) => Date.now() - l.time < 24 * 3600 * 1000).length;
  await setBadge(String(todayCount));
}

async function refreshBadge() {
  const { log } = await getSettings();
  const todayCount = log.filter((l) => Date.now() - l.time < 24 * 3600 * 1000 && !l.group.includes("失败")).length;
  await setBadge(todayCount > 0 ? String(todayCount) : "");
}

// 全量扫描：对比基线，找出新关注并归类
async function runSweep() {
  const { enabled, baselineReady, baseline, unclearTarget } = await getSettings();
  if (!enabled) return { processed: 0, total: 0, skipped: "已停用" };

  const list = await fetchAllFollowings();
  const currentMids = new Set(list.map((u) => String(u.mid)));
  const baseMap = baselineReady ? baseline : {};

  // 首次运行：仅建立基线，不改动任何分组
  if (!baselineReady) {
    const b = {};
    for (const u of list) b[String(u.mid)] = 1;
    await saveSettings({ baseline: b, baselineReady: true, lastCheck: Date.now() });
    await appendLog({ uname: `基线建立完成（${list.length}个关注）`, group: "初始化", stage: "首次运行" });
    return { processed: 0, total: list.length, initialized: true };
  }

  // 新关注
  const newMids = list.map((u) => String(u.mid)).filter((m) => !baseMap[m]);
  // 已取关：从基线移除
  const b = { ...baseMap };
  for (const m of Object.keys(b)) if (!currentMids.has(m)) delete b[m];

  let processed = 0;
  for (const mid of newMids) {
    b[mid] = 1;
    if (!inFlight.has(mid)) {
      try {
        const info = list.find((u) => String(u.mid) === mid);
        const infoObj = {
          uname: info.uname,
          sign: info.sign || "",
          verifyType: info.official_verify?.type ?? -1,
          verifyDesc: info.official_verify?.desc || "",
        };
        let group = classifyByNameAndSign(infoObj);
        let stage = "名称签名";
        if (!group) {
          const titles = await fetchRecentTitles(mid);
          group = classifyByTitles(titles);
          stage = "投稿分析";
        }
        if (!group) {
          if (unclearTarget === "default") {
            await appendLog({ uname: infoObj.uname, group: "留在默认分组", stage: "无法判定" });
            processed++;
            continue;
          }
          const r = await getUsersToTag(UNCLEAR_GROUP_FALLBACK, unclearTarget);
          group = r.resolved;
          if (r.tagid) await assignToTag(mid, r.tagid);
        } else {
          const r = await getUsersToTag(group, unclearTarget);
          group = r.resolved;
          if (r.tagid) await assignToTag(mid, r.tagid);
          else await appendLog({ uname: infoObj.uname, group: "默认分组(创建分组失败)", stage });
        }
        await appendLog({ uname: infoObj.uname, group, stage });
        processed++;
        await sleep(400);
      } catch (e) {
        await appendLog({ uname: "mid:" + mid, group: "处理失败: " + e.message, stage: "错误" });
      }
    }
  }

  await saveSettings({ baseline: b, lastCheck: Date.now() });
  if (processed > 0) {
    const { processedCount } = await getSettings();
    await saveSettings({ processedCount: processedCount + processed });
    await refreshBadge();
  }
  return { processed, total: list.length };
}

// ───────────────────────── 生命周期 ─────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ ...DEFAULTS, ...cur, log: cur.log || [], baselineReady: false, baseline: {} });
  chrome.alarms.create("sweep", { periodInMinutes: cur.intervalMin || 5 });
  // 首次运行立即建立基线
  setTimeout(() => runSweep().catch(console.warn), 3000);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("sweep", { periodInMinutes: 5 });
  setTimeout(() => runSweep().catch(console.warn), 5000);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sweep") {
    runSweep().catch((e) => console.warn("[自动分组] 扫描失败:", e.message));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "followed" && msg.fid) {
    handleNewFollow(msg.fid).catch(console.warn);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "sweepNow") {
    runSweep()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: e.message }));
    return true; // 异步响应
  }
  if (msg.type === "getState") {
    getSettings()
      .then((s) => sendResponse(s))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "setSettings") {
    saveSettings(msg.patch)
      .then(async () => {
        if (msg.patch.intervalMin) {
          chrome.alarms.create("sweep", { periodInMinutes: msg.patch.intervalMin });
        }
        if (msg.patch.resetLog) await saveSettings({ log: [], processedCount: 0, baselineReady: false, baseline: {} });
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "clearBadge") {
    setBadge("");
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
