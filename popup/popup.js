const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => resolve(r || {}));
  });
}

function fmtTime(ts) {
  if (!ts) return "从未";
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function renderLog(log) {
  const ul = $("logList");
  if (!log || log.length === 0) {
    ul.innerHTML = '<li class="empty">暂无记录</li>';
    return;
  }
  ul.innerHTML = log
    .slice(0, 20)
    .map((l) => {
      const t = new Date(l.time);
      const ts = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
      const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
      return `<li><span class="t">${ts}</span>${esc(l.uname)} → <span class="g">${esc(l.group)}</span><span class="s">${esc(l.stage || "")}</span></li>`;
    })
    .join("");
}

async function loadState() {
  const s = await send({ type: "getState" });
  if (s.error) {
    $("stateText").textContent = "读取失败";
    return;
  }
  $("enabled").checked = !!s.enabled;
  $("interval").value = String(s.intervalMin || 5);
  $("unclear").value = s.unclearTarget || "其他与个人账号";
  $("statusDot").classList.toggle("off", !s.enabled);
  $("stateText").textContent = s.enabled ? "运行中" : "已停用";
  $("baselineCount").textContent = s.baselineReady ? Object.keys(s.baseline || {}).length : "待建立";
  $("processedCount").textContent = s.processedCount ?? 0;
  $("lastCheck").textContent = fmtTime(s.lastCheck);
  renderLog(s.log);
}

$("enabled").addEventListener("change", async (e) => {
  await send({ type: "setSettings", patch: { enabled: e.target.checked } });
  loadState();
});

$("interval").addEventListener("change", async (e) => {
  await send({ type: "setSettings", patch: { intervalMin: Number(e.target.value) } });
});

$("unclear").addEventListener("change", async (e) => {
  await send({ type: "setSettings", patch: { unclearTarget: e.target.value } });
});

$("sweepNow").addEventListener("click", async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = "检查中…";
  const r = await send({ type: "sweepNow" });
  btn.disabled = false;
  btn.textContent = "立即检查新关注";
  if (r.error) {
    btn.textContent = "失败: " + r.error.slice(0, 20);
    setTimeout(loadState, 2000);
  } else if (r.initialized) {
    btn.textContent = `基线已建立(${r.total})`;
  } else {
    btn.textContent = `完成，新分组 ${r.processed} 个`;
  }
  setTimeout(() => {
    loadState();
    btn.textContent = "立即检查新关注";
  }, 2500);
});

$("resetBaseline").addEventListener("click", async (e) => {
  if (!confirm("重建基线将重新记录当前所有关注（不会改动现有分组），确定？")) return;
  const btn = e.target;
  await send({ type: "setSettings", patch: { resetLog: true } });
  btn.textContent = "已重建";
  setTimeout(() => {
    btn.textContent = "重建基线";
    loadState();
  }, 1500);
});

// 打开弹窗时清除角标
chrome.runtime.sendMessage({ type: "clearBadge" }).catch(() => {});
loadState();
