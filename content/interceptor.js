// 注入到页面主世界：包装 fetch/XHR，捕获关注动作
(function () {
  if (window.__biliAutotagHooked) return;
  window.__biliAutotagHooked = true;

  const post = (fid) => {
    try {
      window.postMessage({ source: "__biliAutotag", type: "followed", fid: String(fid) }, "*");
    } catch (e) {}
  };

  const extractFollow = (url, body) => {
    const u = String(url || "");
    if (!u.includes("/x/relation/modify")) return;
    const text = `${u} ${body ? String(body) : ""}`;
    const m = text.match(/(?:^|[?&])fid=(\d+)/);
    const a = text.match(/(?:^|[?&])act=(\d+)/);
    // act=1 才是关注
    if (m && a && a[1] === "1") post(m[1]);
  };

  const of = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (init && String(init.method || "GET").toUpperCase() === "POST") {
        extractFollow(url, init.body);
      }
    } catch (e) {}
    return of.apply(this, arguments);
  };

  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__btU = u;
    this.__btM = m;
    return oo.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    try {
      if (this.__btU && String(this.__btM || "").toUpperCase() === "POST") {
        extractFollow(this.__btU, b);
      }
    } catch (e) {}
    return os.apply(this, arguments);
  };
})();
