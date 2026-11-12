// Tích hợp ONLYOFFICE Docs (Document Server) cho workbook nhỏ loại "word" (.docx) và "excel" (.xlsx).
//
// Mô hình dữ liệu KHÔNG đổi: nội dung văn bản vẫn là HTML trong item.data.html (mã hóa, có phiên bản, có chữ ký khi nộp).
//   - Mở:  HTML  -> .docx (html-to-docx)  -> Document Server tải về qua liên kết ký sẵn, hết hạn nhanh
//   - Lưu: Document Server gọi callback -> tải .docx -> .docx -> HTML (mammoth) -> core.applyEdit (kiểm tra quyền, nhật ký, WebSocket)
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
const plugin = require('./oo-plugin');
const { parseXlsx, exportXlsx, cleanCell, keyOK, cleanWidths } = require('./excel');

const trim = (s) => String(s || '').replace(/\/+$/, '');
const CFG = {
  url: trim(process.env.ONLYOFFICE_URL),
  internal: trim(process.env.ONLYOFFICE_INTERNAL_URL) || trim(process.env.ONLYOFFICE_URL),
  appUrl: trim(process.env.ONLYOFFICE_APP_URL),
  secret: process.env.ONLYOFFICE_JWT_SECRET || '',
};
const enabled = () => !!(CFG.url && CFG.appUrl && CFG.secret);

// Liên kết tải file chỉ cần sống ngắn (Document Server tải ngay khi mở). Liên kết callback phải sống bằng cả phiên soạn thảo
// (mặc định phiên tối đa 8 giờ) nếu không bản sửa sẽ bị từ chối khi hết hạn. Callback vẫn cần JWT của Document Server + quyền sửa còn hiệu lực.
const TTL_MS = { file: 10 * 60 * 1000, callback: 12 * 3600 * 1000 };
const MAX_DOCX = 20 * 1024 * 1024;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const supported = (it) => it && (it.type === 'word' || it.type === 'excel');

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
async function download(url) {
  const res = await fetch(toInternal(url), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('Không tải được file từ Document Server: ' + res.status);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DOCX) throw new Error('File quá lớn');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOCX) throw new Error('File quá lớn');
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('File không phải .docx/.xlsx');
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
  for (const [k, b] of baselines) if (Date.now() - b.at > 12 * 3600 * 1000) baselines.delete(k);
}
// Khóa phiên: mọi người cùng vai trò mở cùng 1 file phải dùng CHUNG 1 key thì Document Server mới ghép họ vào 1 phiên (cộng tác, xem trực tiếp).
// Nếu key đổi theo version thì khi tự lưu làm version tăng liên tục, người vào sau sẽ rơi vào phiên khác. Vì vậy: còn phiên đang mở thì dùng lại key đó;
// hết phiên (Document Server báo đóng) thì key mới theo version hiện tại để không bị dính bản cache cũ.
// Vai trò (variant): word = cả admin và user chung 1 phiên; excel: a = admin (đủ quyền), u = người được giao (khóa/ẩn ô).
const sessions = new Map(); // `${itemId}|${variant}` -> { key, rev }
function sessionKey(it, variant, rev) {
  const sk = `${it.id}|${variant}`;
  const cur = sessions.get(sk);
  if (cur && cur.rev === rev && openKeys.get(it.id)?.has(cur.key)) return cur.key;
  const key = crypto.createHash('sha256').update(`${it.id}|${it.version}|${variant}|${rev}`).digest('hex').slice(0, 40);
  sessions.set(sk, { key, rev });
  return key;
}
function dropSession(itemId, key) { // Document Server báo phiên này đã đóng
  const m = openKeys.get(itemId);
  if (m) { m.delete(key); if (!m.size) openKeys.delete(itemId); }
  baselines.delete(key);
}

// Tự lưu định kỳ: cứ vài giây ép Document Server lưu phần mới gõ (callback status 6 -> core.applyEdit -> WebSocket tới admin).
// Nhờ đó dữ liệu ở máy chủ, bảng tính theo dõi của admin và bản nộp luôn mới nhất, kể cả khi user tắt trình duyệt đột ngột.
// OO_AUTOSAVE_SECONDS=0 để tắt (mặc định 5 giây). Document Server trả error 4 khi không có gì mới nên chu kỳ rảnh rất nhẹ.
const AUTOSAVE_MS = Math.max(0, Number(process.env.OO_AUTOSAVE_SECONDS ?? 5)) * 1000;
let autoSaving = false;
async function forceSaveKey(key) {
  const payload = { c: 'forcesave', key };
  const res = await fetch(`${CFG.internal}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwtSign(payload) },
    body: JSON.stringify({ ...payload, token: jwtSign(payload) }),
    signal: AbortSignal.timeout(8000),
  });
  return res.json().catch(() => ({}));
}
async function autoSaveTick() {
  if (autoSaving || !enabled()) return;
  autoSaving = true;
  try {
    for (const [itemId, m] of [...openKeys]) {
      for (const key of [...m.keys()]) {
        try {
          const r = await forceSaveKey(key);
          if (r.error === 1) dropSession(itemId, key); // phiên đã đóng: thôi theo dõi
        } catch { /* Document Server bận: thử lại chu kỳ sau */ }
      }
      if (!m.size) openKeys.delete(itemId);
    }
  } finally { autoSaving = false; }
}

// Gọi Command Service của Document Server: ép lưu mọi thay đổi chưa lưu của item này về máy chủ (callback status 6).
// Gọi trước khi nộp bài, nếu không phần user mới gõ trong trình soạn thảo chưa nằm trong bản nộp.
async function flush(it) {
  if (!enabled() || !supported(it)) return;
  const keys = [...(openKeys.get(it.id)?.keys() || [])];
  if (!keys.length) return;
  const v0 = it.version;
  let asked = false;
  for (const key of keys) {
    try {
      const payload = { c: 'forcesave', key };
      const res = await fetch(`${CFG.internal}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwtSign(payload) },
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


// ---------- file gửi cho Document Server ----------
// Ưu tiên file gốc đã lưu (giữ nguyên định dạng Office) nếu dữ liệu chưa bị đổi bằng đường khác; không thì dựng từ dữ liệu.
// 1 nếu workbook đang có khóa ô/ẩn ô: lúc đó file của user là bản có bảo vệ + gỡ ô ẩn nên KHÔNG dùng được file gốc (xem keepOrig)
const protSig = (it) => (it.protect && (it.protect.on || core.hiddenKeys(it).length) ? 1 : 0);
const hashOf = (it) => (it.type === 'word' ? store.sha(it.data.html || '') : store.sha(store.canon({ c: it.data.cells, g: protSig(it) })));
function origFile(it) {
  try {
    const o = store.getOrig(it);
    if (o && o.h === hashOf(it)) return Buffer.from(store.getBlob(it.bookId, o.key));
  } catch { /* không đọc được: dựng lại từ dữ liệu */ }
  return null;
}
// File .xlsx theo vai trò: admin thấy đủ và sửa được mọi ô; user bị gỡ nội dung ô ẩn và (khi bật bảo vệ) chỉ nhập được ở ô cho phép
async function buildXlsx(it, user) {
  let data = it.data, protect;
  if (!core.isAdmin(user)) {
    data = core.dataFor(user, it);
    if (it.protect.on) {
      const hid = it.protect.hidden || {};
      protect = { unlock: Object.keys(it.protect.cells).filter((k) => !hid[k]), password: store.sign('sheetpw|' + it.id) };
    }
  }
  return Buffer.from(await exportXlsx({ parts: [{ name: it.name, data, protect }] }));
}
async function fileOf(it, user) {
  return origFile(it) || (it.type === 'excel' ? buildXlsx(it, user) : await htmlToDocx(it.data.html));
}

// ---------- Excel: dữ liệu ô <-> .xlsx ----------
// Với Excel, dữ liệu là it.data = { rows, cols, colWidths, cells }. Khi mở: xuất .xlsx. Khi lưu: nhập .xlsx rồi chỉ áp các ô MÀ USER ĐÃ ĐỔI
// so với bản đã đưa cho họ lúc mở (baseline), để không đè lên những ô admin/người khác sửa trong lúc đó.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((q) => [q, x[q]])) : x));
const baselines = new Map(); // key phiên -> { at, grid }
function diffCells(base, next) {
  const patch = {};
  for (const k of Object.keys(next.cells)) if (!base.cells[k] || canon(base.cells[k]) !== canon(next.cells[k])) patch[k] = next.cells[k];
  for (const k of Object.keys(base.cells)) if (!(k in next.cells)) patch[k] = null;
  return patch;
}
// Làm sạch patch: bỏ ô không hợp lệ thay vì làm hỏng cả lần lưu
function cleanPatchLoose(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!keyOK(k)) continue;
    if (v === null) { out[k] = null; continue; }
    const c = cleanCell(v);
    if (!c) continue;
    out[k] = Object.keys(c).length ? c : null;
  }
  return out;
}
// Lưu bản .xlsx do ONLYOFFICE gửi về vào item (qua core.applyEdit: quyền, hạn nộp, trạng thái, nhật ký, WebSocket đều như cũ)
async function saveExcel(user, it, key, buf, ip) {
  const { parts } = await parseXlsx(buf);
  if (!parts.length) throw new Error('File .xlsx không có sheet nào');
  const next = parts[0].data; // chỉ lấy sheet đầu: mỗi workbook nhỏ = 1 bảng
  const known = baselines.get(key);
  const base = known ? known.grid : (await parseXlsx(await fileOf(it, user))).parts[0].data;
  let patch = cleanPatchLoose(diffCells(base, next));
  baselines.set(key, { at: Date.now(), grid: next }); // phiên vẫn mở: lần lưu sau so với bản này
  const p = core.perm(user, it);
  let reverted = 0;
  if (!p.admin) { // máy chủ là nơi quyết định cuối cùng; giao diện ONLYOFFICE chỉ là lớp chặn sớm
    const hid = it.protect.hidden || {};
    for (const k of Object.keys(patch)) {
      if (hid[k]) { delete patch[k]; continue; } // ô ẩn: user không thấy nên không có quyền ghi gì vào đó
      if (it.protect.on && !it.protect.cells[k]) {
        const old = it.data.cells[k], nw = patch[k];
        const derived = !!(old && nw && old.f && nw.f === old.f && canon(old.s || null) === canon(nw.s || null)); // ô công thức chỉ đổi kết quả tính: không phải user sửa
        delete patch[k];
        if (!derived) reverted++;
      }
    }
  }
  if (reverted) store.audit(user.id, 'oo_locked_reverted', it.id, ip, { cells: reverted });
  const keys = Object.keys(patch);
  // Giữ file gốc (biểu đồ, ô gộp, định dạng...) CHỈ khi dữ liệu sau khi lưu khớp đúng nội dung file (không có ô bị bỏ/khóa/đổi bởi người khác)
  // Khi đang khóa/ẩn ô thì file của user là bản đã bảo vệ + gỡ ô ẩn: không giữ làm file gốc
  const keepOrig = () => { if (!protSig(it) && store.sha(store.canon({ c: next.cells, g: 0 })) === hashOf(it)) store.setOrig(it, buf, hashOf(it)); };
  if (!keys.length) { keepOrig(); return { changed: 0, reverted }; }
  const dims = { rows: Math.max(it.data.rows, next.rows), cols: Math.max(it.data.cols, next.cols) };
  const widths = {};
  for (const [c, w] of Object.entries(cleanWidths(next.colWidths))) if ((base.colWidths || {})[c] !== next.colWidths[c]) widths[c] = w;
  for (let i = 0; i < keys.length; i += 4000) { // core giới hạn 5000 ô mỗi lần
    const chunk = Object.fromEntries(keys.slice(i, i + 4000).map((k) => [k, patch[k]]));
    const msg = { patch: chunk };
    if (i === 0) {
      if (dims.rows !== it.data.rows || dims.cols !== it.data.cols) msg.dims = dims;
      if (Object.keys(widths).length) msg.widths = widths;
    }
    core.applyEdit(user, it.id, msg, ip);
  }
  keepOrig();
  return { changed: keys.length, reverted };
}

// ---------- cấu hình trả về cho trình duyệt ----------
async function editorConfig(user, itemId, ip, appOrigin, opts = {}) {
  const it = core.getReadable(user, itemId, ip);
  if (!supported(it)) throw core.E(400, 'Chỉ dùng cho văn bản Word hoặc bảng tính');
  const isXl = it.type === 'excel';
  // Chế độ XEM TRỰC TIẾP (Live Viewer) cho admin: vào ĐÚNG phiên mà người được giao đang sửa (cùng file, cùng key) ở chế độ chỉ xem.
  // Admin thấy từng ký tự và con trỏ của user ngay khi gõ. File, liên kết tải và callback đều ký theo người được giao nên
  // mọi lần lưu từ phiên này vẫn đi qua đúng bộ lọc quyền của người đó.
  const watch = !!opts.watch;
  let as = user; // người mà file/phiên này thuộc về
  if (watch) {
    if (!core.isAdmin(user) || !isXl) throw core.E(400, 'Chỉ admin xem trực tiếp bảng tính của người được giao');
    as = it.assigneeId && store.user(it.assigneeId);
    if (!as) throw core.E(400, 'Workbook này chưa giao cho ai');
  }
  const p = core.userView(it, as);
  const admin = core.isAdmin(as);
  const editable = watch ? false : p.editable;
  // Word: cùng item + version = cùng key (admin và user cộng tác 1 phiên). Excel: file của admin (đủ, sửa mọi ô) khác file của user (khóa/ẩn ô)
  // nên mỗi vai trò 1 phiên riêng, và khóa của user đổi theo rev để mọi thay đổi quyền đều ra file mới.
  const variant = isXl ? (admin ? 'a' : 'u') : 'w';
  const key = sessionKey(it, variant, variant === 'u' ? (it.protect.rev || 0) : 0);
  trackKey(it.id, key);
  if (isXl && !baselines.has(key)) baselines.set(key, { at: Date.now(), grid: (await parseXlsx(await fileOf(it, as))).parts[0].data });
  const cfg = {
    documentType: isXl ? 'cell' : 'word',
    document: {
      fileType: isXl ? 'xlsx' : 'docx',
      // key đổi mỗi khi nội dung lưu (version tăng) -> Document Server không dùng bản cache cũ.
      // Cùng item + cùng version = cùng key: admin và user mở cùng lúc sẽ cộng tác trong 1 phiên.
      key,
      title: `${it.name}.${isXl ? 'xlsx' : 'docx'}`,
      url: link('file', it.id, as.id),
      permissions: {
        edit: editable,
        review: false, comment: editable, chat: false,
        ...(watch ? { userInfoGroups: [''] } : {}), // hiện con trỏ của người đang sửa trong chế độ xem trực tiếp
        // user bình thường: không tải xuống/in/copy ra ngoài (khớp chế độ "restricted" của trình soạn thảo cũ)
        download: admin, print: admin, copy: admin,
        protect: admin, // user không có tab Bảo vệ (không bỏ được khóa sheet)
      },
    },
    editorConfig: {
      mode: editable ? 'edit' : 'view',
      lang: 'vi',
      user: { id: user.id, name: user.name || user.username },
      callbackUrl: link('callback', it.id, as.id),
      // Co-editing luôn ở chế độ nhanh (fast) và không cho người dùng đổi sang "nghiêm ngặt" (sẽ giấu thay đổi khỏi admin đang xem trực tiếp)
      coEditing: { mode: 'fast', change: false },
      // Giao diện giống MS Office: thanh ribbon đầy đủ có tab (Trang đầu, Chèn, Bố cục, Công thức...), chủ đề Classic Light
      customization: { forcesave: true, autosave: true, compactHeader: false, compactToolbar: false, toolbarNoTabs: false, hideRightMenu: true, uiTheme: 'theme-classic-light', about: false, feedback: false, help: false },
    },
  };
  // Admin sửa Excel: nạp plugin tab "Quản trị ô" (cho phép nhập / khóa / ẩn ô ngay trong ribbon). Trình duyệt tải plugin từ chính máy chủ này.
  if (isXl && admin && !watch && appOrigin) cfg.editorConfig.plugins = { autostart: [plugin.GUID], pluginsData: [`${appOrigin}/oo-plugin/${it.id}/config.json`] };
  cfg.token = jwtSign(cfg);
  return { config: cfg, scriptUrl: `${CFG.url}/web-apps/apps/api/documents/api.js` };
}

// ---------- gắn route (PHẢI gọi trước middleware phiên của /api vì Document Server không có cookie) ----------
function mount(app) {
  if (AUTOSAVE_MS) setInterval(autoSaveTick, AUTOSAVE_MS).unref();
  plugin.mount(app, () => ({ enabled: enabled(), url: CFG.url, internal: CFG.internal }));
  // Document Server tải file về để mở
  app.get('/oo/file/:id', async (req, res) => {
    try {
      if (!enabled()) return res.status(404).end();
      const user = checkLink('file', req);
      const it = user && store.items.get(req.params.id);
      if (!supported(it)) return res.status(404).end();
      core.getReadable(user, it.id, req.ip); // người ký liên kết phải còn quyền đọc
      const buf = await fileOf(it, user);
      res.set({ 'Content-Type': it.type === 'excel' ? XLSX_MIME : DOCX_MIME, 'Cache-Control': 'no-store', 'Content-Length': buf.length });
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
      const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.body?.token;
      const claims = jwtVerify(raw);
      if (!claims) return res.status(403).json({ error: 1 });
      const body = claims.payload && typeof claims.payload === 'object' ? claims.payload : claims;

      // 2 = đóng và sẵn sàng lưu, 6 = lưu bắt buộc (forcesave). Các trạng thái khác chỉ ghi nhận.
      if (body.status === 2 || body.status === 6) {
        if (!body.url || !allowedDownload(body.url)) return fail('url callback không hợp lệ');
        const it = store.items.get(req.params.id);
        if (!supported(it)) return fail('không có item');
        const file = await download(body.url);
        try {
          if (it.type === 'excel') await saveExcel(user, it, String(body.key || ''), file, req.ip);
          else {
            const html = await docxToHtml(file);
            core.applyEdit(user, it.id, { html }, req.ip); // kiểm tra quyền, hạn nộp, trạng thái; ghi nhật ký thao tác; phát WebSocket
            store.setOrig(it, file, hashOf(it)); // giữ file .docx gốc: mở lại không mất đầu trang, mục lục, phông...
          }
        } catch (e) {
          if (!e.status) throw e; // lỗi đọc/chuyển file (không phải bị từ chối quyền): báo error 1 để Document Server gọi lại
          // Hết quyền sửa giữa chừng (đã nộp, quá hạn, bị thu hồi): không ghi đè, ghi nhật ký rồi báo xong để Document Server không gọi lại mãi
          store.audit(user.id, 'oo_save_denied', it.id, req.ip, { reason: e.message });
          if (body.status === 2) dropSession(req.params.id, String(body.key || ''));
          return res.json({ error: 0 });
        }
        store.audit(user.id, 'oo_save', it.id, req.ip, { status: body.status });
      }
      if (body.status === 2 || body.status === 4) dropSession(req.params.id, String(body.key || '')); // 2 = đóng sau khi lưu, 4 = đóng không có thay đổi
      res.json({ error: 0 });
    } catch (e) { fail(e.message); }
  });
}

module.exports = { enabled, editorConfig, flush, mount, origFile, CFG, jwtSign, jwtVerify, docxToHtml, htmlToDocx };
