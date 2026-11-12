// Plugin "Quản trị ô" cho ONLYOFFICE Spreadsheet Editor (chỉ nạp cho admin).
// Thêm tab "Quản trị ô" vào ribbon: Cho phép nhập / Khóa ô / Ẩn ô / Hiện ô / Bật-Tắt bảo vệ.
// Plugin KHÔNG tự gọi API: nó đọc vùng đang chọn rồi gửi postMessage lên trang ứng dụng (cùng origin), trang đó mới gọi API quyền
// bằng phiên đăng nhập của admin. Máy chủ vẫn là nơi quyết định quyền (core.setProtect chỉ cho admin).
const fs = require('fs');
const path = require('path');

const GUID = 'asc.{8A3D5E0C-7B1F-4C2A-9D64-5F0E1B2C3A47}';
const CODE = path.join(__dirname, 'oo-plugin', 'code.js');
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="5" y="9" width="22" height="18" rx="2" fill="#1d6f42"/><path d="M11 9V7a5 5 0 0 1 10 0v2" fill="none" stroke="#1d6f42" stroke-width="2.5"/><circle cx="16" cy="18" r="2.5" fill="#fff"/></svg>';

function mount(app, getCfg) {
  const open = (res, type) => {
    const cfg = getCfg();
    res.removeHeader('X-Frame-Options'); // phải cho Document Server nhúng trang plugin vào khung của nó
    res.set({
      'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
      'Content-Security-Policy': `frame-ancestors 'self' ${cfg.url}`,
    });
  };
  const guard = (req, res, next) => (getCfg().enabled ? next() : res.status(404).end());
  const id = '/oo-plugin/:item';

  app.options(`${id}/*`, guard, (req, res) => { open(res, 'text/plain'); res.set('Access-Control-Allow-Headers', '*').status(204).end(); });

  app.get(`${id}/config.json`, guard, (req, res) => {
    open(res, 'application/json; charset=utf-8');
    res.send(JSON.stringify({
      name: 'Quản trị ô', guid: GUID, baseUrl: '',
      variations: [{
        description: 'Cho phép nhập, khóa và ẩn ô khi giao bài', url: 'index.html', icons: ['icon.svg'],
        isViewer: false, EditorsSupport: ['cell'], isVisual: false, isModal: false, isInsideMode: false,
        initDataType: 'none', initData: '', isUpdateOleOnResize: false, buttons: [], events: ['onToolbarMenuClick'],
      }],
    }));
  });

  // Trang plugin tải thư viện plugins.js từ chính Document Server (không cần Internet); nếu máy chủ không có thì dùng bản trên CDN của hãng.
  let sdk = { at: 0, src: null };
  async function sdkSrc() {
    const cfg = getCfg();
    if (sdk.src && Date.now() - sdk.at < 60000) return sdk.src;
    let src = 'https://onlyoffice.github.io/sdkjs-plugins/v1/plugins.js';
    try {
      const r = await fetch(`${cfg.internal || cfg.url}/sdkjs-plugins/v1/plugins.js`, { method: 'GET', signal: AbortSignal.timeout(4000) });
      if (r.ok) src = `${cfg.url}/sdkjs-plugins/v1/plugins.js`;
    } catch { /* dùng CDN */ }
    sdk = { at: Date.now(), src };
    return src;
  }
  app.get(`${id}/index.html`, guard, async (req, res) => {
    open(res, 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quản trị ô</title></head><body>\n<script src="${await sdkSrc()}"></script>\n<script src="code.js"></script>\n</body></html>`);
  });
  app.get(`${id}/code.js`, guard, (req, res) => { open(res, 'application/javascript; charset=utf-8'); res.send(fs.readFileSync(CODE, 'utf8')); });
  app.get(`${id}/icon.svg`, guard, (req, res) => { open(res, 'image/svg+xml'); res.send(ICON); });
}

module.exports = { GUID, mount };
