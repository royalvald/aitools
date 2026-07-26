// REQ-216 Web 剪藏书签脚本（bookmarklet）生成。

// 生成 bookmarklet：抓取当前页 title + 选中文本（或正文摘要）+ URL，POST 到本地 /api/clip。
// baseUrl 形如 http://127.0.0.1:1234，token 为本地 API token。
export function buildBookmarklet(baseUrl: string, token: string): string {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/clip`
  // bookmarklet 是一个 javascript: 链接，整体 IIFE；URL 编码后可作 href
  const js = `(function(){
  try {
    var title = document.title || location.href;
    var sel = window.getSelection ? window.getSelection().toString() : '';
    var content = sel;
    if(!content){
      var main = document.querySelector('main,article') || document.body;
      content = main ? (main.innerText || '').slice(0, 4000) : '';
    }
    var payload = { title: title, url: location.href, content: content, capturedAt: new Date().toISOString() };
    fetch(${JSON.stringify(endpoint)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ${JSON.stringify(token)} },
      body: JSON.stringify(payload)
    }).then(function(r){ return r.json(); }).then(function(j){
      alert(j.ok ? ('已剪藏到织记：' + (j.title||'')) : ('剪藏失败：' + (j.error||'')));
    }).catch(function(e){ alert('剪藏失败：' + e); });
  } catch(e) { alert('剪藏异常：' + e); }
})();`
  return 'javascript:' + encodeURIComponent(js)
}
