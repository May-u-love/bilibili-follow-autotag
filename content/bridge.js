// 隔离世界桥接：接收主世界消息，转发给后台
window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (d && d.source === "__biliAutotag" && d.type === "followed" && d.fid) {
    try {
      chrome.runtime.sendMessage({ type: "followed", fid: d.fid }).catch(() => {});
    } catch (e) {}
  }
});
