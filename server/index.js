// API "Office nội bộ": Workbook lớn (book) chứa nhiều workbook nhỏ (item). Mỗi item được giao riêng cho 1 user.
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const HTMLtoDOCX = require('html-to-docx');
const store = require('./store');
const auth = require('./auth');
const core = require('./core');
const attachLive = require('./live');
const jobs = require('./jobs');
const crypto = require('crypto');
const { parseXlsx, exportXlsx } = require('./excel');
const { samples } = require('./sample');
const { colName } = require('./refs');
const { materialize } = require('./formula');
const { safeHtmlForDocx } = require('./docsafe');
const oo = require('./onlyoffice');

const PORT = process.env.PORT || 4000;
const app = express();
const server = http.createServer(app);
const live = attachLive(server);
const { E } = core;
const SLOT = (req) => req.headers['x-session-slot'];

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1' || process.env.RENDER) app.set('trust proxy', 1); // SỬA: Render đặt proxy HTTPS phía trước, cần tin proxy để req.protocol/req.ip đúng
const ipOf = (req) => req.ip;

// ---------- header bảo mật ----------
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '2mb' }));

// ---------- ONLYOFFICE: Document Server gọi vào đây bằng liên kết ký sẵn + JWT (không có cookie phiên) ----------
oo.mount(app);

// ---------- chống CSRF: cookie SameSite=Strict + kiểm tra Origin cho mọi request ghi ----------
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const o = req.headers.origin;
  if (o) { try { if (new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'Nguồn gửi không hợp lệ' }); } catch { return res.status(403).json({ error: 'Nguồn gửi không hợp lệ' }); } }
  else { const s = req.headers['sec-fetch-site']; if (s && !['same-origin', 'none'].includes(s)) return res.status(403).json({ error: 'Nguồn gửi không hợp lệ' }); }
  next();
});

// ---------- đăng nhập ----------
const DUMMY = store.hashPw('khong-ton-tai');
app.post('/api/login', (req, res) => {
  const ip = ipOf(req);
  if (!auth.hit('login:' + ip, 30, 60000)) return res.status(429).json({ error: 'Quá nhiều yêu cầu, thử lại sau' });
  const { username, password, otp } = req.body || {};
  const kIp = `ip:${ip}:${username}`, kUser = 'u:' + username;
  const wait = Math.max(auth.lockedFor(kIp), auth.lockedFor(kUser));
  if (wait) return res.status(429).json({ error: `Tài khoản tạm khóa, thử lại sau ${Math.ceil(wait / 60)} phút` });
  const u = typeof username === 'string' ? store.findUser(username) : null;
  const ok = auth.verifyPw(String(password || ''), u ? u.pw : DUMMY) && !!u;
  const fail = (msg, action) => {
    auth.failLogin(kIp, 5, 5 * 60000); auth.failLogin(kUser, 12, 10 * 60000);
    store.audit(u?.id, action, null, ip);
    return res.status(401).json({ error: msg });
  };
  if (!ok) return fail('Sai tài khoản hoặc mật khẩu', 'login_fail');
  if (u.totp?.enabled) {
    if (!otp) return res.status(401).json({ error: 'Nhập mã xác thực 2 bước', need2fa: true });
    if (!auth.totpCheck(u.totp, otp)) return fail('Mã xác thực 2 bước không đúng', 'login_2fa_fail');
    store.saveMetaSoon();
  }
  auth.clearFails(kIp); auth.clearFails(kUser);
  const old = auth.getSession(auth.sidFrom(req, SLOT(req)));
  if (old) { auth.revokeById(old.id); live.closeSession(old.h); }
  auth.setCookie(res, auth.createSession(u, ip, req.headers['user-agent']), SLOT(req));
  auth.sweepStaleCookies(req, res, SLOT(req));
  store.audit(u.id, 'login', null, ip);
  res.json({ ok: true });
});

// ---------- mọi route /api bên dưới cần phiên hợp lệ ----------
app.use('/api', (req, res, next) => {
  const s = auth.getSession(auth.sidFrom(req, SLOT(req)));
  const u = s && store.user(s.userId);
  if (!u) { auth.clearCookie(res, SLOT(req)); return res.status(401).json({ error: 'Phiên đã hết hạn, vui lòng đăng nhập lại' }); }
  if (!auth.hit('api:' + s.h, 900, 60000)) return res.status(429).json({ error: 'Quá nhiều yêu cầu' });
  req.user = u; req.session = s;
  next();
});
const adminOnly = (req, res, next) => (core.isAdmin(req.user) ? next() : res.status(403).json({ error: 'Không đủ quyền' }));
const A = (req, action, itemId, extra) => store.audit(req.user.id, action, itemId, ipOf(req), extra);

app.post('/api/logout', (req, res) => {
  auth.revokeById(req.session.id); live.closeSession(req.session.h); auth.clearCookie(res, SLOT(req));
  A(req, 'logout'); res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  auth.sweepStaleCookies(req, res, SLOT(req));
  const u = req.user;
  res.json({
    id: u.id, username: u.username, name: u.name, role: u.role, tag: req.session.id.slice(0, 4),
    defaultPw: !!u.defaultPw, totp: !!u.totp?.enabled, idleMinutes: auth.IDLE_MS / 60000,
  });
});

// ---------- bảo mật tài khoản ----------
app.post('/api/me/password', (req, res) => {
  const { old, next } = req.body || {};
  if (!auth.verifyPw(String(old || ''), req.user.pw)) throw E(403, 'Mật khẩu hiện tại không đúng');
  const bad = auth.pwPolicy(next); if (bad) throw E(400, bad);
  req.user.pw = store.hashPw(next); req.user.defaultPw = false; store.saveMeta();
  auth.revokeUser(req.user.id, req.session.h); live.closeUser(req.user.id, req.session.h); // đăng xuất các thiết bị khác
  A(req, 'password_change'); res.json({ ok: true });
});
app.post('/api/me/2fa/setup', (req, res) => {
  if (req.user.totp?.enabled) throw E(400, '2FA đã được bật');
  const secret = auth.newTotpSecret();
  req.user.totp = { secret, enabled: false, last: 0 }; store.saveMeta();
  res.json({ secret, uri: auth.totpUri(req.user, secret) });
});
app.post('/api/me/2fa/enable', (req, res) => {
  const t = req.user.totp;
  if (!t || t.enabled || !auth.totpCheck(t, req.body?.otp)) throw E(400, 'Mã xác thực không đúng');
  t.enabled = true; store.saveMeta(); A(req, '2fa_enable'); res.json({ ok: true });
});
app.post('/api/me/2fa/disable', (req, res) => {
  const t = req.user.totp;
  if (!t?.enabled || !auth.verifyPw(String(req.body?.password || ''), req.user.pw) || !auth.totpCheck(t, req.body?.otp)) throw E(403, 'Mật khẩu hoặc mã xác thực không đúng');
  req.user.totp = null; store.saveMeta(); A(req, '2fa_disable'); res.json({ ok: true });
});
const sessView = (s, cur) => ({ id: s.id, userId: s.userId, userName: store.user(s.userId)?.name, ip: s.ip, ua: s.ua, created: new Date(s.created).toISOString(), last: new Date(s.last).toISOString(), current: s.h === cur });
app.get('/api/me/sessions', (req, res) => res.json(auth.listSessions(req.user.id).map((s) => sessView(s, req.session.h))));
app.delete('/api/me/sessions/:id', (req, res) => {
  const mine = auth.listSessions(req.user.id).find((s) => s.id === req.params.id);
  if (!mine) throw E(404, 'Không tìm thấy');
  auth.revokeById(mine.id); live.closeSession(mine.h); A(req, 'session_revoke'); res.json({ ok: true });
});
app.get('/api/admin/sessions', adminOnly, (req, res) => res.json(auth.listSessions().map((s) => sessView(s, req.session.h))));
app.delete('/api/admin/sessions/:id', adminOnly, (req, res) => {
  const s = auth.listSessions().find((x) => x.id === req.params.id);
  if (!s) throw E(404, 'Không tìm thấy');
  auth.revokeById(s.id); live.closeSession(s.h); A(req, 'force_logout', null, { user: s.userId }); res.json({ ok: true });
});
app.get('/api/users', adminOnly, (req, res) =>
  res.json(store.meta.users.map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, totp: !!u.totp?.enabled, defaultPw: !!u.defaultPw, online: auth.listSessions(u.id).length > 0 }))));
app.post('/api/admin/users/:id/reset', adminOnly, (req, res) => {
  const u = store.user(req.params.id);
  const bad = auth.pwPolicy(req.body?.password);
  if (!u || u.id === req.user.id) throw E(404, 'Không tìm thấy');
  if (bad) throw E(400, bad);
  u.pw = store.hashPw(req.body.password); u.defaultPw = true; u.totp = null; store.saveMeta();
  auth.revokeUser(u.id); live.closeUser(u.id);
  A(req, 'admin_reset_user', null, { user: u.id }); res.json({ ok: true });
});

// ---------- nhật ký ----------
app.get('/api/audit', adminOnly, (req, res) =>
  res.json(store.recentAudit(400).map((e) => ({ n: e.n, at: e.at, user: store.user(e.u)?.name || e.u, action: e.a, item: e.i, ip: e.ip, extra: e.x }))));
app.get('/api/audit/verify', adminOnly, (req, res) => res.json(store.verifyAudit()));

// ---------- workbook lớn (book) ----------
const bookSummary = (b) => {
  const its = store.bookItems(b);
  return {
    id: b.id, title: b.title, createdAt: b.createdAt, total: its.length,
    assigned: its.filter((i) => i.assigneeId).length, submitted: its.filter((i) => core.FINAL.has(i.status)).length, approved: its.filter((i) => i.status === 'approved').length,
    online: its.filter((i) => live.isOnline(i.id)).length,
  };
};
const getBook = (id) => { const b = store.books.get(id); if (!b) throw E(404, 'Không tìm thấy workbook lớn'); return b; };
const uniqueName = (b, name) => {
  const used = new Set(store.bookItems(b).map((i) => i.name.toLowerCase()));
  let n = String(name || 'Sheet').trim().slice(0, 60) || 'Sheet', k = 2, base = n;
  while (used.has(n.toLowerCase())) n = `${base} (${k++})`;
  return n;
};
const newBook = (title, userId) => {
  const b = { id: store.rid(), title: String(title).slice(0, 120), createdAt: new Date().toISOString(), createdBy: userId, auto: true, itemIds: [] };
  store.saveBook(b);
  return b;
};
const blankGrid = () => ({ rows: 100, cols: 26, colWidths: {}, cells: {} });

app.get('/api/books', adminOnly, (req, res) => res.json([...store.books.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(bookSummary)));
app.post('/api/books', adminOnly, (req, res) => {
  const b = newBook(req.body?.title || 'Workbook lớn mới', req.user.id);
  A(req, 'create_book', null, { book: b.id }); res.json({ id: b.id });
});
app.post('/api/books/sample', adminOnly, (req, res) => {
  const ids = samples().map((s) => {
    const b = newBook(s.title, req.user.id);
    s.items.forEach((x) => store.newItem(b, x.name, x.type, x.data, x.protect ? { protect: { on: x.protect.on, cells: x.protect.cells } } : {}));
    return b.id;
  });
  A(req, 'create_sample'); res.json({ ids });
});

// Tải lên: .xlsx (mỗi sheet thành 1 workbook nhỏ) hoặc .docx (1 văn bản). Có header x-book thì thêm vào workbook lớn đã có.
app.post('/api/books/upload', adminOnly, express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
  try {
    const name = decodeURIComponent(req.headers['x-filename'] || 'tai-lieu');
    const ext = path.extname(name).toLowerCase();
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw E(400, 'File không hợp lệ (chỉ nhận .xlsx hoặc .docx)');
    const book = req.headers['x-book'] ? getBook(String(req.headers['x-book'])) : null;
    const title = path.basename(name, ext).slice(0, 120);
    let parts, warnings = [];
    if (ext === '.xlsx') {
      const r = await parseXlsx(buf);
      if (!r.parts.length) throw E(400, 'File không có sheet nào');
      parts = r.parts.map((p) => ({ ...p, type: 'excel' })); warnings = r.warnings;
    } else if (ext === '.docx') {
      const r = await mammoth.convertToHtml({ buffer: buf });
      if (r.value.length > 5e6) throw E(400, 'Văn bản quá lớn');
      parts = [{ name: title, type: 'word', data: { html: r.value } }];
    } else throw E(400, 'Chỉ nhận .xlsx hoặc .docx');
    const target = book || newBook(title, req.user.id);
    parts.forEach((p) => store.newItem(target, uniqueName(target, p.name), p.type, p.data));
    A(req, 'upload', null, { book: target.id, items: parts.length });
    core.bus.emit('book', { bookId: target.id });
    res.json({ bookId: target.id, added: parts.length, warnings });
  } catch (e) {
    if (e instanceof core.HttpError) return res.status(e.status).json({ error: e.message });
    res.status(400).json({ error: 'Không đọc được file: ' + e.message });
  }
});

app.get('/api/books/:id', adminOnly, (req, res) => {
  const b = getBook(req.params.id);
  res.json({ id: b.id, title: b.title, auto: b.auto !== false, items: store.bookItems(b).map(core.adminView), online: live.onlineIn(b.id) });
});
// Admin tải dữ liệu mọi workbook nhỏ 1 lần để công thức tổng hợp chéo workbook tính được
app.get('/api/books/:id/data', adminOnly, (req, res) => {
  const b = getBook(req.params.id);
  A(req, 'open_book', null, { book: b.id });
  res.json(Object.fromEntries(store.bookItems(b).map((i) => [i.id, { data: i.data, protect: i.protect, version: i.version }])));
});
app.patch('/api/books/:id', adminOnly, (req, res) => {
  const b = getBook(req.params.id);
  b.title = String(req.body?.title || b.title).slice(0, 120); store.saveBook(b);
  core.bus.emit('book', { bookId: b.id }); res.json({ ok: true });
});
app.delete('/api/books/:id', adminOnly, (req, res) => {
  const b = getBook(req.params.id); store.deleteBook(b.id);
  A(req, 'delete_book', null, { book: b.id }); res.json({ ok: true });
});
app.post('/api/books/:id/items', adminOnly, (req, res) => {
  const b = getBook(req.params.id);
  const type = req.body?.type === 'word' ? 'word' : 'excel';
  const it = store.newItem(b, uniqueName(b, req.body?.name || (type === 'word' ? 'Văn bản mới' : 'Sheet mới')), type, type === 'word' ? { html: '<p><br></p>' } : blankGrid());
  A(req, 'create_item', it.id); core.bus.emit('book', { bookId: b.id }); res.json({ id: it.id });
});
app.put('/api/books/:id/assign', adminOnly, (req, res) => {
  const b = getBook(req.params.id);
  const n = core.assign(req.user, b.id, req.body?.assignments, req.body?.deadlines, ipOf(req));
  core.bus.emit('book', { bookId: b.id });
  res.json({ changed: n, items: store.bookItems(b).map(core.adminView) });
});
// Xuất workbook lớn thành 1 file .xlsx gom tất cả sheet (chỉ admin)
app.get('/api/books/:id/export', adminOnly, async (req, res) => {
  const b = getBook(req.params.id);
  const exs = store.bookItems(b).filter((i) => i.type === 'excel');
  const others = Object.fromEntries(exs.map((i) => [i.name, i.data.cells]));
  const parts = exs.map((i) => ({ name: i.name.replace(/[\\/?*[\]:]/g, '-').slice(0, 31), data: materialize(i.data, i.name, others) })); // tính lại công thức theo số liệu hiện tại
  if (!parts.length) throw E(400, 'Workbook lớn không có bảng tính nào');
  const buf = Buffer.from(await exportXlsx({ parts }));
  A(req, 'export_book', null, { book: b.id });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(b.title)}.xlsx` });
  res.send(buf);
});


// ---------- tổng hợp workbook lớn (chạy bằng worker, có phiên bản, tải bằng liên kết ký sẵn) ----------
const consView = (c) => ({
  id: c.id, n: c.n, at: c.at, by: c.by ? store.user(c.by)?.name || c.by : 'Tự động', mode: c.mode, sha: c.sha, size: c.size,
  docx: c.manifest.docx ? { size: c.manifest.docx.size, count: c.manifest.docx.count } : null,
  total: c.manifest.items.length, included: c.manifest.items.filter((r) => r.included).length, changed: c.manifest.changed, sheets: c.manifest.sheets,
  items: c.manifest.items.map((r) => ({ name: r.name, type: r.type, assignee: r.assignee, status: r.status, included: r.included, source: r.source, note: r.note, changed: !!(r.changed || r.isNew) })),
});
app.get('/api/books/:id/consolidations', adminOnly, (req, res) => {
  const b = getBook(req.params.id);
  res.json({ auto: b.auto !== false, job: store.jobState('consolidate', b.id), items: store.listConsolidations(b.id).map(consView) });
});
app.post('/api/books/:id/consolidate', adminOnly, (req, res) => {
  const b = getBook(req.params.id);
  const r = jobs.enqueueConsolidation(b.id, ['latest', 'approved'].includes(req.body?.mode) ? req.body.mode : 'submitted', req.user.id, 0);
  A(req, 'consolidate_request', null, { book: b.id, mode: req.body?.mode });
  res.json({ jobId: r.id, coalesced: r.coalesced });
});
app.put('/api/books/:id/auto', adminOnly, (req, res) => {
  const b = getBook(req.params.id);
  b.auto = !!req.body?.on; store.saveBook(b);
  A(req, 'auto_consolidate', null, { book: b.id, on: b.auto }); res.json({ auto: b.auto });
});
// Liên kết tải xuống ký sẵn: hết hạn sau 5 phút, gắn với đúng admin đã xin, vẫn đòi phiên đăng nhập hợp lệ
const dlSig = (cid, exp, uid, kind) => store.signRaw(`${cid}|${exp}|${uid}|${kind}`);
app.post('/api/consolidations/:cid/link', adminOnly, (req, res) => {
  const c = store.getConsolidation(req.params.cid);
  if (!c) throw E(404, 'Không tìm thấy');
  const kind = req.body?.kind === 'docx' ? 'docx' : 'xlsx';
  if (kind === 'docx' && !c.manifest.docx) throw E(404, 'Bản này không có file văn bản');
  const exp = Date.now() + 5 * 60000;
  A(req, 'download_link', null, { cons: c.id, kind });
  res.json({ path: `/consolidations/${c.id}/download?exp=${exp}&kind=${kind}&sig=${dlSig(c.id, exp, req.user.id, kind)}`, expiresAt: new Date(exp).toISOString(), filename: `${c.manifest.title} - v${c.n}.${kind}` });
});
app.get('/api/consolidations/:cid/download', adminOnly, (req, res) => {
  const c = store.getConsolidation(req.params.cid);
  const exp = Number(req.query.exp), sig = String(req.query.sig || '');
  const kind = req.query.kind === 'docx' ? 'docx' : 'xlsx';
  const want = c ? dlSig(c.id, exp, req.user.id, kind) : '';
  const okSig = sig.length === want.length && want && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  if (!c || !okSig || !(exp > Date.now())) throw E(403, 'Liên kết không hợp lệ hoặc đã hết hạn');
  const f = kind === 'docx' ? c.manifest.docx : { fileKey: c.fileKey, sha: c.sha };
  if (!f) throw E(404, 'Không có file này');
  const buf = store.getBlob(c.bookId, f.fileKey);
  if (crypto.createHash('sha256').update(buf).digest('hex') !== f.sha) throw E(500, 'File tổng hợp đã bị thay đổi, từ chối tải');
  A(req, 'download_consolidation', null, { cons: c.id, n: c.n, kind });
  res.set({ 'Content-Type': kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(c.manifest.title + ' - v' + c.n)}.${kind}` });
  res.send(buf);
});
// So sánh 2 phiên bản tổng hợp: workbook nhỏ nào đổi, đổi bao nhiêu ô, ví dụ vài ô
app.get('/api/books/:id/consolidations/diff', adminOnly, (req, res) => {
  const b = getBook(req.params.id);
  const A_ = store.getConsolidation(String(req.query.a)), B_ = store.getConsolidation(String(req.query.b));
  if (!A_ || !B_ || A_.bookId !== b.id || B_.bookId !== b.id) throw E(404, 'Không tìm thấy phiên bản');
  const mapA = new Map(A_.manifest.items.map((r) => [r.itemId, r])), mapB = new Map(B_.manifest.items.map((r) => [r.itemId, r]));
  const out = [];
  for (const [id, rb] of mapB) {
    const ra = mapA.get(id);
    if (!ra) { out.push({ name: rb.name, change: 'Mới thêm' }); continue; }
    if (ra.hash === rb.hash && ra.included === rb.included) continue;
    const e = { name: rb.name, change: ra.included && !rb.included ? 'Bị gỡ khỏi file' : !ra.included && rb.included ? 'Mới đưa vào file' : 'Có thay đổi' };
    if (ra.snapshotId && rb.snapshotId) {
      const sa = store.getSnapshot(ra.snapshotId), sb = store.getSnapshot(rb.snapshotId);
      if (sa?.data?.cells && sb?.data?.cells) {
        const keys = new Set([...Object.keys(sa.data.cells), ...Object.keys(sb.data.cells)]);
        const ex = []; let n = 0;
        for (const k of keys) {
          const x = sa.data.cells[k], y = sb.data.cells[k];
          if (JSON.stringify(x) === JSON.stringify(y)) continue;
          n++;
          if (ex.length < 6) { const [r, c] = k.split(',').map(Number); ex.push({ cell: colName(c) + (r + 1), from: x ? (x.f ? '=' + x.f : x.v ?? '') : '', to: y ? (y.f ? '=' + y.f : y.v ?? '') : '' }); }
        }
        e.cellsChanged = n; e.examples = ex;
      }
    }
    out.push(e);
  }
  for (const [id, ra] of mapA) if (!mapB.has(id)) out.push({ name: ra.name, change: 'Đã bị xóa khỏi workbook lớn' });
  res.json({ a: A_.n, b: B_.n, changes: out });
});

// ---------- workbook nhỏ (item) ----------
app.get('/api/my-items', (req, res) => {
  const mine = [...store.items.values()].filter((i) => i.assigneeId === req.user.id);
  res.json(mine.map((i) => { const v = core.userView(i, req.user); return { id: v.id, name: v.name, type: v.type, status: v.status, editable: v.editable, deadline: v.deadline, pastDue: v.pastDue, returnNote: v.returnNote }; }));
});
app.get('/api/onlyoffice/status', (req, res) => res.json({ enabled: oo.enabled() }));
app.get('/api/items/:id/onlyoffice', async (req, res, next) => {
  try {
    if (!oo.enabled()) throw E(404, 'ONLYOFFICE chưa được cấu hình');
    // SỬA: dùng ONLYOFFICE_APP_URL (https) thay cho `${req.protocol}://${req.get('host')}` để plugin không bị chặn Mixed Content trên Render
    const r = await oo.editorConfig(req.user, req.params.id, ipOf(req), oo.CFG.appUrl, { watch: req.query.watch === '1' });
    core.markOpened(req.user, core.getReadable(req.user, req.params.id, ipOf(req)));
    A(req, 'open', req.params.id);
    res.json(r);
  } catch (e) { next(e); }
});
app.post('/api/items/:id/onlyoffice/flush', async (req, res, next) => { // ép ONLYOFFICE lưu phần chưa lưu (dùng khi admin đổi giao diện)
  try {
    const cur = core.getReadable(req.user, req.params.id, ipOf(req));
    if ((cur.type === 'word' || cur.type === 'excel') && core.perm(req.user, cur).edit) await oo.flush(cur);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get('/api/items/:id', (req, res) => {
  const it = core.getReadable(req.user, req.params.id, ipOf(req));
  core.markOpened(req.user, it);
  A(req, 'open', it.id);
  const view = core.userView(it, req.user);
  res.json({ item: core.isAdmin(req.user) ? { ...view, ...core.adminView(it) } : view, data: core.dataFor(req.user, it) }); // ô ẩn bị gỡ nội dung với user
});
app.post('/api/items/:id/submit', async (req, res, next) => {
  try {
    // Văn bản mở bằng ONLYOFFICE: ép lưu phần chưa lưu trước khi chốt bản nộp (core.submit vẫn kiểm tra quyền như cũ)
    const cur = core.getReadable(req.user, req.params.id, ipOf(req));
    if ((cur.type === 'word' || cur.type === 'excel') && core.perm(req.user, cur).edit) await oo.flush(cur);
    const it = core.submit(req.user, req.params.id, ipOf(req));
    res.json({ ok: true, submittedAt: it.submittedAt });
  } catch (e) { next(e); }
});
app.post('/api/items/:id/approve', adminOnly, (req, res) => { core.approve(req.user, req.params.id, ipOf(req)); res.json({ ok: true }); });
app.post('/api/items/:id/reopen', adminOnly, (req, res) => { core.reopen(req.user, req.params.id, req.body?.reason, ipOf(req)); res.json({ ok: true }); });
app.put('/api/items/:id/protect', adminOnly, (req, res) => res.json(core.setProtect(req.user, req.params.id, req.body || {}, ipOf(req))));
app.get('/api/items/:id/verify', adminOnly, (req, res) => {
  const it = core.getReadable(req.user, req.params.id, ipOf(req));
  const r = core.verify(it); A(req, 'verify', it.id, { state: r.state }); res.json(r);
});
app.get('/api/items/:id/history', adminOnly, (req, res) => {
  const it = core.getReadable(req.user, req.params.id, ipOf(req));
  res.json(it.history.map((h) => ({ ...h, byName: store.user(h.by)?.name })).reverse());
});
app.patch('/api/items/:id', adminOnly, (req, res) => {
  const it = core.getReadable(req.user, req.params.id, ipOf(req));
  it.name = uniqueName(store.books.get(it.bookId), String(req.body?.name || it.name)); store.saveItem(it, true);
  core.bus.emit('book', { bookId: it.bookId }); res.json({ name: it.name });
});
app.delete('/api/items/:id', adminOnly, (req, res) => {
  const it = core.getReadable(req.user, req.params.id, ipOf(req));
  const prev = it.assigneeId, bookId = it.bookId;
  store.deleteItem(it.id);
  if (prev) core.bus.emit('status', { item: { ...it, assigneeId: null }, prevAssigneeId: prev });
  A(req, 'delete_item', it.id); core.bus.emit('book', { bookId }); res.json({ ok: true });
});
app.get('/api/items/:id/export', adminOnly, async (req, res) => {
  const it = core.getReadable(req.user, req.params.id, ipOf(req));
  let buf, ext, mime;
  const kept = oo.origFile(it); // file gốc do ONLYOFFICE lưu (đủ định dạng Office) nếu còn khớp dữ liệu
  if (kept) { buf = kept; ext = it.type === 'excel' ? 'xlsx' : 'docx'; mime = it.type === 'excel' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; }
  else if (it.type === 'excel') { buf = Buffer.from(await exportXlsx({ parts: [{ name: it.name.slice(0, 31), data: materialize(it.data, it.name, {}) }] })); ext = 'xlsx'; mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
  else { buf = Buffer.from(await HTMLtoDOCX('<html><body>' + safeHtmlForDocx(it.data.html) + '</body></html>')); ext = 'docx'; mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; }
  A(req, 'export_item', it.id);
  res.set({ 'Content-Type': mime, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(it.name)}.${ext}` });
  res.send(buf);
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy' }));

// ---------- phục vụ giao diện đã build trên cùng 1 cổng ----------
const DIST = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(DIST)) {
  app.use((req, res, next) => {
    const ooHost = oo.enabled() ? ' ' + oo.CFG.url : '';
    res.set('Content-Security-Policy', `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'${ooHost}; frame-src 'self'${ooHost}; connect-src 'self' ws: wss:${ooHost}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    next();
  });
  app.use(express.static(DIST));
  app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.use((err, req, res, next) => { // eslint-disable-line
  if (err instanceof core.HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Dữ liệu quá lớn' });
  console.error(err);
  res.status(500).json({ error: 'Lỗi máy chủ' });
});

jobs.start();
server.listen(PORT, () => console.log('API chạy tại http://localhost:' + PORT));