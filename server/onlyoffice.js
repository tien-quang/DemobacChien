// Tích hợp ONLYOFFICE Docs (Document Server) cho MỌI workbook nhỏ: Word (.docx) và Excel (.xlsx).
//
// Mô hình dữ liệu KHÔNG đổi: nội dung văn bản vẫn là HTML trong item.data.html (mã hóa, có phiên bản, có chữ ký khi nộp).
//   Word:  HTML <-> .docx (html-to-docx / mammoth)
//   Excel: lưới ô {v,f,s} <-> .xlsx (exceljs); khi lưu chỉ tính các ô THAY ĐỔI so với bản trên máy chủ rồi áp qua core.applyEdit
//   - Mở:  tạo file -> Document Server tải về qua liên kết ký sẵn, hết hạn nhanh
//   - Lưu: Document Server gọi callback (JWT) -> tải file -> chuyển ngược -> core.applyEdit (kiểm tra quyền, nhật ký, WebSocket)
// Vì lưu đi qua core.applyEdit nên quyền sửa, hạn nộp, trạng thái "đã nộp" vẫn được kiểm tra đúng như trước.
//
// Biến môi trường (không đặt ONLYOFFICE_URL thì tính năng tắt, giao diện dùng trình soạn thảo cũ):
//   ONLYOFFICE_URL           địa chỉ Document Server mà TRÌNH DUYỆT truy cập được, ví dụ http://localhost:8080
//   ONLYOFFICE_INTERNAL_URL  (tùy chọn) địa chỉ Document Server mà MÁY CHỦ NÀY truy cập được, mặc định = ONLYOFFICE_URL
//   ONLYOFFICE_APP_URL       địa chỉ ứng dụng này mà DOCUMENT SERVER truy cập được, ví dụ http://host.docker.internal:4000
//   ONLYOFFICE_JWT_SECRET    khóa JWT, phải trùng JWT_SECRET của Document Server
const crypto = require('crypto');
const mammoth = require('mammoth');
const HTMLtoDOCX = require('html-to-docx');
const store = require('./store');
const core = require('./core');
const { safeHtmlForDocx } = require('./docsafe');
const { parseXlsx, exportXlsx, cleanWidths } = require('./excel');
const { materialize } = require('./formula');

const trim = (s) => String(s || '').replace(/\/+$/, '');
const CFG = {
  url: trim(process.env.ONLYOFFICE_URL),
  internal: trim(process.env.ONLYOFFICE_INTERNAL_URL) || trim(process.env.ONLYOFFICE_URL),
  appUrl: trim(process.env.ONLYOFFICE_APP_URL),
  secret: process.env.ONLYOFFICE_JWT_SECRET || '',
  jwtHeader: process.env.ONLYOFFICE_JWT_HEADER || 'Authorization',
};
const enabled = () => !!(CFG.url && CFG.appUrl && CFG.secret);

// Liên kết tải file chỉ cần sống ngắn (Document Server tải ngay khi mở). Liên kết callback phải sống bằng cả phiên soạn thảo
// (mặc định phiên tối đa 8 giờ) nếu không bản sửa sẽ bị từ chối khi hết hạn. Callback vẫn cần JWT của Document Server + quyền sửa còn hiệu lực.
const TTL_MS = { file: 10 * 60 * 1000, callback: 12 * 3600 * 1000 };
const MAX_DOCX = 20 * 1024 * 1024;
const MIME = {
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const EXT = { word: 'docx', excel: 'xlsx' };
const DOCTYPE = { word: 'word', excel: 'cell' };

// ---------- JWT HS256 tối giản (không cần thêm thư viện) ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
function jwtSign(payload) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', CFG.secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function jwtVerify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    if (JSON.parse(Buffer.from(parts[0], 'base64url').toString()).alg !== 'HS256') return null; // chặn alg=none
    const want = crypto.createHmac('sha256', CFG.secret).update(`${parts[0]}.${parts[1]}`).digest();
    const got = Buffer.from(parts[2], 'base64url');
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { return null; }
}
function jwtFromRequest(req) {
  const configured = req.headers[CFG.jwtHeader.toLowerCase()];
  const authorization = req.headers.authorization;
  return String(configured || authorization || req.body?.token || '').replace(/^Bearer\s+/i, '');
}

// ---------- liên kết ký sẵn cho Document Server (không có cookie phiên) ----------
const linkSig = (purpose, itemId, userId, exp) => store.signRaw(`oo|${purpose}|${itemId}|${userId}|${exp}`);
function link(purpose, itemId, userId) {
  const exp = Date.now() + TTL_MS[purpose];
  return `${CFG.appUrl}/oo/${purpose}/${itemId}?u=${encodeURIComponent(userId)}&exp=${exp}&sig=${linkSig(purpose, itemId, userId, exp)}`;
}
function checkLink(purpose, req) {
  const { u, exp, sig } = req.query;
  const e = Number(exp);
  if (!u || !sig || !Number.isFinite(e) || e < Date.now()) return null;
  const want = Buffer.from(linkSig(purpose, req.params.id, String(u), e));
  const got = Buffer.from(String(sig));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return store.user(String(u)) || null;
}

// ---------- chuyển đổi ----------
const htmlToDocx = async (html) => Buffer.from(await HTMLtoDOCX('<html><body>' + safeHtmlForDocx(html || '<p><br></p>') + '</body></html>'));
async function docxToHtml(buf) {
  const r = await mammoth.convertToHtml({ buffer: buf });
  return safeHtmlForDocx(r.value || '<p><br></p>');
}

// ---------- Excel ----------
const excelToXlsx = async (it) => Buffer.from(await exportXlsx({ parts: [{ name: it.name.slice(0, 31), data: materialize(it.data, it.name, {}) }] }));
const sameCell = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// So file .xlsx vừa lưu với dữ liệu hiện có, trả về đúng các ô đã đổi (định dạng giống thao tác sửa từ WebSocket)
async function xlsxToEdit(it, buf) {
  const { parts } = await parseXlsx(buf);
  if (!parts.length) throw new Error('File không có sheet');
  const nd = parts[0].data, old = it.data;
  const patch = {};
  for (const k of Object.keys(nd.cells)) if (!sameCell(old.cells[k], nd.cells[k])) patch[k] = nd.cells[k];
  for (const k of Object.keys(old.cells)) if (!(k in nd.cells)) patch[k] = null;
  const widths = {};
  for (const [k, v] of Object.entries(nd.colWidths || {})) if ((old.colWidths || {})[k] !== v) widths[k] = v;
  return {
    patch,
    dims: { rows: Math.max(old.rows, nd.rows), cols: Math.max(old.cols, nd.cols) }, // không thu nhỏ lưới
    widths: cleanWidths(widths),
  };
}
// Áp thay đổi Excel qua core.applyEdit, chia lô (mỗi lô tối đa 4000 ô) và lọc ô bị khóa với người không phải admin.
// (Chỉ đổi độ rộng cột / kích thước lưới mà không đổi ô nào thì bỏ qua: core.applyEdit yêu cầu có ít nhất 1 ô.)
function applyExcel(user, it, edit, ip) {
  let keys = Object.keys(edit.patch), blocked = 0;
  if (!core.isAdmin(user) && it.protect.on) {
    const allowed = keys.filter((k) => it.protect.cells[k]);
    blocked = keys.length - allowed.length; keys = allowed;
  }
  for (let i = 0; i < keys.length; i += 4000) {
    const msg = { patch: Object.fromEntries(keys.slice(i, i + 4000).map((k) => [k, edit.patch[k]])) };
    if (i === 0) {
      if (edit.dims.rows !== it.data.rows || edit.dims.cols !== it.data.cols) msg.dims = edit.dims;
      if (Object.keys(edit.widths).length) msg.widths = edit.widths;
    }
    core.applyEdit(user, it.id, msg, ip);
  }
  return { blocked, applied: keys.length };
}

// Chỉ tải file từ chính Document Server (chống SSRF qua trường "url" trong callback)
function allowedDownload(u) {
  try {
    const t = new URL(u);
    return [CFG.url, CFG.internal].filter(Boolean).some((b) => new URL(b).host === t.host) && /^https?:$/.test(t.protocol);
  } catch { return false; }
}
// URL trong callback có thể mang địa chỉ công khai của Document Server; nếu máy chủ này gọi qua địa chỉ nội bộ thì đổi gốc
function toInternal(u) {
  const t = new URL(u), pub = new URL(CFG.url), inn = new URL(CFG.internal);
  if (t.host === pub.host) { t.protocol = inn.protocol; t.host = inn.host; }
  return t.toString();
}
async function download(url, magic = true) {
  const res = await fetch(toInternal(url), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('Không tải được file từ Document Server: ' + res.status);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DOCX) throw new Error('File quá lớn');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOCX) throw new Error('File quá lớn');
  if (magic && (buf[0] !== 0x50 || buf[1] !== 0x4b)) throw new Error('File không phải .docx/.xlsx');
  return buf;
}

// ---------- theo dõi phiên soạn thảo để ép lưu trước khi nộp bài ----------
const openKeys = new Map(); // itemId -> Map<key, mở lúc nào>
function trackKey(itemId, key) {
  if (!openKeys.has(itemId)) openKeys.set(itemId, new Map());
  openKeys.get(itemId).set(key, Date.now());
  for (const [id, m] of openKeys) { // dọn phiên cũ hơn 12 giờ
    for (const [k, t] of m) if (Date.now() - t > 12 * 3600 * 1000) m.delete(k);
    if (!m.size) openKeys.delete(id);
  }
}
// Gọi Command Service của Document Server: ép lưu mọi thay đổi chưa lưu của item này về máy chủ (callback status 6).
// Gọi trước khi nộp bài, nếu không phần user mới gõ trong trình soạn thảo chưa nằm trong bản nộp.
async function flush(it) {
  if (!enabled()) return;
  const keys = [...(openKeys.get(it.id)?.keys() || [])];
  if (!keys.length) return;
  const v0 = it.version;
  let asked = false;
  for (const key of keys) {
    try {
      const payload = { c: 'forcesave', key };
      const res = await fetch(`${CFG.internal}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [CFG.jwtHeader]: 'Bearer ' + jwtSign(payload) },
        body: JSON.stringify({ ...payload, token: jwtSign(payload) }),
        signal: AbortSignal.timeout(8000),
      });
      const r = await res.json().catch(() => ({}));
      if (r.error === 0) asked = true; // 4 = không có thay đổi, 1 = phiên không tồn tại (đã đóng): bỏ qua
    } catch { /* Document Server không trả lời: bỏ qua, tiếp tục nộp bản đã lưu */ }
  }
  if (!asked) return;
  const t0 = Date.now(); // chờ callback ghi xong (version tăng), tối đa 10 giây
  while (it.version === v0 && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 250));
}

// ---------- cấu hình trả về cho trình duyệt ----------
async function editorConfig(user, itemId, ip) {
  const it = core.getReadable(user, itemId, ip);
  if (!EXT[it.type]) throw core.E(400, 'Loại workbook không hỗ trợ');
  const p = core.userView(it, user);
  const admin = core.isAdmin(user);
  const editable = p.editable;
  const key = crypto.createHash('sha256').update(`${it.id}|${it.version}`).digest('hex').slice(0, 40);
  trackKey(it.id, key);
  const cfg = {
    documentType: DOCTYPE[it.type],
    document: {
      fileType: EXT[it.type],
      // key đổi mỗi khi nội dung lưu (version tăng) -> Document Server không dùng bản cache cũ.
      // Cùng item + cùng version = cùng key: admin và user mở cùng lúc sẽ cộng tác trong 1 phiên.
      key,
      title: `${it.name}.${EXT[it.type]}`,
      url: link('file', it.id, user.id),
      permissions: {
        edit: editable,
        review: false, comment: editable, chat: false,
        // user bình thường: không tải xuống/in/copy ra ngoài (khớp chế độ "restricted" của trình soạn thảo cũ)
        download: admin, print: admin, copy: admin,
      },
    },
    editorConfig: {
      mode: editable ? 'edit' : 'view',
      lang: 'vi',
      user: { id: user.id, name: user.name || user.username },
      callbackUrl: link('callback', it.id, user.id),
      customization: { forcesave: true, autosave: true, compactHeader: true, hideRightMenu: true, about: false, feedback: false },
    },
  };
  cfg.token = jwtSign(cfg);
  return { config: cfg, scriptUrl: `${CFG.url}/web-apps/apps/api/documents/api.js` };
}

// ---------- gắn route (PHẢI gọi trước middleware phiên của /api vì Document Server không có cookie) ----------
function mount(app) {
  // Document Server tải file về để mở
  app.get('/oo/file/:id', async (req, res) => {
    try {
      if (!enabled()) return res.status(404).end();
      const user = checkLink('file', req);
      const it = user && store.items.get(req.params.id);
      if (!it || !EXT[it.type]) return res.status(404).end();
      core.getReadable(user, it.id, req.ip); // người ký liên kết phải còn quyền đọc
      const buf = it.type === 'word' ? await htmlToDocx(it.data.html) : await excelToXlsx(it);
      res.set({ 'Content-Type': MIME[it.type], 'Cache-Control': 'no-store', 'Content-Length': buf.length });
      res.send(buf);
    } catch (e) { res.status(e.status || 500).end(); }
  });

  // Document Server báo trạng thái / gửi bản đã sửa
  app.post('/oo/callback/:id', require('express').json({ limit: '1mb' }), async (req, res) => {
    const fail = (msg) => { console.error('[onlyoffice]', msg); res.json({ error: 1 }); };
    try {
      if (!enabled()) return fail('tắt');
      const user = checkLink('callback', req);
      if (!user) return res.status(403).json({ error: 1 });

      // Xác thực JWT của Document Server (header Authorization hoặc body.token)
      const raw = jwtFromRequest(req);
      const claims = jwtVerify(raw);
      if (!claims) return res.status(403).json({ error: 1 });
      const body = claims.payload && typeof claims.payload === 'object' ? claims.payload : claims;

      // 2 = đóng và sẵn sàng lưu, 6 = lưu bắt buộc (forcesave). Các trạng thái khác chỉ ghi nhận.
      if (body.status === 2 || body.status === 6) {
        if (!body.url || !allowedDownload(body.url)) return fail('url callback không hợp lệ');
        const it = store.items.get(req.params.id);
        if (!it || !EXT[it.type]) return fail('không có item');
        const file = await download(body.url);
        let result = {};
        try {
          if (it.type === 'word') core.applyEdit(user, it.id, { html: await docxToHtml(file) }, req.ip); // kiểm tra quyền, hạn nộp, trạng thái; ghi nhật ký; phát WebSocket
          else result = applyExcel(user, it, await xlsxToEdit(it, file), req.ip);
        } catch (e) {
          // Hết quyền sửa giữa chừng (đã nộp, quá hạn, bị thu hồi): không ghi đè, ghi nhật ký rồi báo xong để Document Server không gọi lại mãi
          store.audit(user.id, 'oo_save_denied', it.id, req.ip, { reason: e.message });
          return res.json({ error: 0 });
        }
        store.audit(user.id, 'oo_save', it.id, req.ip, { status: body.status, ...(result.blocked ? { blockedLockedCells: result.blocked } : {}) });
      }
      res.json({ error: 0 });
    } catch (e) { fail(e.message); }
  });
}

module.exports = { enabled, editorConfig, flush, mount, CFG, jwtSign, jwtVerify, docxToHtml, htmlToDocx, excelToXlsx, xlsxToEdit };
