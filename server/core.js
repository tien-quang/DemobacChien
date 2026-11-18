// Lõi nghiệp vụ. MỌI thao tác (REST và WebSocket) đều đi qua đây nên quyền chỉ được kiểm tra ở 1 nơi.
const EventEmitter = require('events');
const store = require('./store');
const { cleanCell, keyOK, cleanWidths, cleanDim, MAX_CELLS } = require('./excel');
const { materialize, makeEvaluator } = require('./formula');

const bus = new EventEmitter();
const isAdmin = (u) => u.role === 'admin';
const FINAL = new Set(['submitted', 'approved']); // đã nộp hoặc đã duyệt: khóa sửa

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const E = (s, m) => new HttpError(s, m);

// Quyền của 1 người trên 1 workbook nhỏ
function perm(user, it) {
  const admin = isAdmin(user);
  const own = it.assigneeId === user.id;
  const pastDue = !!(it.deadline && Date.now() > Date.parse(it.deadline));
  // viewer: được admin cấp quyền CHỈ XEM bảng tổng hợp (không bao giờ sửa được, không thấy công thức và các sheet nguồn)
  const viewer = !admin && !own && it.type === 'excel' && (it.viewerIds || []).includes(user.id);
  const read = admin || own || viewer;
  const edit = admin || (!FINAL.has(it.status) && !pastDue && own);
  return { admin, own, viewer, read, edit, pastDue };
}

// Lấy item mà người dùng được phép đọc; không được phép thì báo 404 (không lộ item có tồn tại) và ghi nhật ký
function getReadable(user, id, ip) {
  const it = store.items.get(id);
  if (!it || !perm(user, it).read) {
    if (it) store.audit(user.id, 'denied', id, ip);
    throw E(404, 'Không tìm thấy');
  }
  return it;
}

// ---------- hình dạng dữ liệu gửi ra ngoài ----------
// Quyền ô gửi ra ngoài. rev tăng mỗi lần admin đổi khóa/ẩn: trang của user dựa vào đó để nạp lại bảng tính. Chỉ admin mới biết số ô ẩn.
function protectView(it, admin) {
  const v = it.protect.on ? { on: true, cells: it.protect.cells } : { on: false, cells: {} };
  v.rev = it.protect.rev || 0;
  if (admin) v.hidden = Object.keys(it.protect.hidden || {}).length;
  return v;
}
const hiddenKeys = (it) => Object.keys((it.protect && it.protect.hidden) || {});
function colIndex(name) {
  let n = 0;
  for (const c of name) n = n * 26 + c.charCodeAt(0) - 64;
  return n - 1;
}
function formulaUsesHidden(formula, hidden) {
  const refs = [...String(formula || '').toUpperCase().matchAll(/(?:[A-Z_][A-Z0-9_. ]*!|')?\$?([A-Z]{1,3})\$?(\d+)/g)];
  for (const m of refs) if (hidden.has(`${Number(m[2]) - 1},${colIndex(m[1])}`)) return true;
  return false;
}
// Dữ liệu cho người chỉ được XEM bảng tổng hợp: máy chủ tự tính công thức (lấy số liệu mới nhất của các sheet nguồn, kể cả bài đang làm dở)
// rồi chỉ gửi GIÁ TRỊ. Công thức, tên và nội dung các sheet nguồn không bao giờ rời khỏi máy chủ.
function viewerData(it) {
  const book = store.books.get(it.bookId);
  const others = {};
  for (const o of store.bookItems(book)) if (o.type === 'excel' && o.id !== it.id) others[o.name] = o.data.cells;
  const hid = hiddenKeys(it);
  const hidden = new Set(hid);
  const cells = {};
  for (const [k, c] of Object.entries(materialize(it.data, it.name, others).cells)) {
    const { f, ...rest } = c;
    if (hidden.has(k) || (f && formulaUsesHidden(f, hidden))) { if (c.s) cells[k] = { s: c.s }; continue; } // ô ẩn, hoặc ô tính từ ô ẩn: không hiện số
    cells[k] = rest;
  }
  return { ...it.data, cells };
}

// ---------- bảng tổng hợp "lai" cho người VỪA làm 1 sheet nguồn VỪA được xem tổng hợp ----------
// Mục tiêu: user sửa sheet của mình (ví dụ tổng nợ 2 triệu -> 4 triệu) thì bảng tổng hợp họ đang xem đổi theo NGAY khi gõ, không chờ lưu / tải lại.
// Cách làm: trong công thức của bảng tổng hợp, phần trỏ tới sheet CỦA CHÍNH user được giữ nguyên (trình soạn thảo tự tính lại tức thì),
// còn phần trỏ tới sheet của NGƯỜI KHÁC được thay bằng số liệu hiện tại của họ (chỉ giá trị, không lộ tên/ nội dung sheet đó).
const SHEET_REF = /('(?:[^']|'')+'|[^\s!'"(),;:+\-*\/^&=<>{}[\]]+)!(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?/g;
const MAX_RANGE = 400;
function splitStrings(f) { // tách công thức thành đoạn trong / ngoài dấu nháy kép (không đụng vào chuỗi chữ)
  const out = [];
  let i = 0, cur = '';
  while (i < f.length) {
    if (f[i] !== '"') { cur += f[i++]; continue; }
    if (cur) { out.push({ text: cur, str: false }); cur = ''; }
    let j = i + 1;
    while (j < f.length) { if (f[j] === '"') { if (f[j + 1] === '"') { j += 2; continue; } break; } j++; }
    out.push({ text: f.slice(i, j + 1), str: true });
    i = j + 1;
  }
  if (cur) out.push({ text: cur, str: false });
  return out;
}
const refRC = (a) => { const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a); return [Number(m[2]) - 1, colIndex(m[1].toUpperCase())]; };
const literal = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string' && v !== '' && !v.startsWith('#')) return '"' + v.replace(/"/g, '""') + '"';
  return null; // trống, lỗi: không thay được an toàn
};
// Trả { f, keep } nếu thay được; null nếu phải chuyển ô thành giá trị tĩnh (không thay an toàn)
function substituteForeign(formula, ownName, lookup, valueAt) {
  let ok = true, usesOwn = false;
  const parts = splitStrings(formula).map((seg) => {
    if (seg.str) return seg.text;
    return seg.text.replace(SHEET_REF, (m, sh, a, b) => {
      const name = sh.startsWith("'") ? sh.slice(1, -1).replace(/''/g, "'") : sh;
      if (name.toLowerCase() === ownName.toLowerCase()) { usesOwn = true; return m; } // sheet của chính user: giữ công thức sống
      const real = lookup(name);
      if (!real) { ok = false; return m; }
      const [r1, c1] = refRC(a);
      if (!b) { const lit = literal(valueAt(real, r1, c1)); if (lit === null) { ok = false; return m; } return lit; }
      const [r2, c2] = refRC(b);
      const R1 = Math.min(r1, r2), R2 = Math.max(r1, r2), C1 = Math.min(c1, c2), C2 = Math.max(c1, c2);
      if ((R2 - R1 + 1) * (C2 - C1 + 1) > MAX_RANGE) { ok = false; return m; }
      const rows = [];
      for (let r = R1; r <= R2; r++) {
        const row = [];
        for (let c = C1; c <= C2; c++) { const lit = literal(valueAt(real, r, c)); if (lit === null) { ok = false; return m; } row.push(lit); }
        rows.push(row.join(','));
      }
      return '{' + rows.join(';') + '}';
    });
  });
  if (!ok) return null;
  const f = parts.join('');
  const bare = splitStrings(f).filter((s) => !s.str).map((s) => s.text).join(' ');
  const hasRef = /(?<![A-Za-z0-9_!'.])\$?[A-Z]{1,3}\$?\d+(?![A-Za-z0-9_(])/i.test(bare.replace(/\{[^}]*\}/g, ''));
  return { f, keep: usesOwn || hasRef };
}

// Bảng tổng hợp mà user được xem. own = sheet user đang làm (nếu có): công thức trỏ tới own giữ nguyên để tính lại tức thì.
// Trả { data, rev, live }. rev chỉ đổi khi số liệu của NGƯỜI KHÁC đổi (user tự sửa sheet mình không làm rev đổi, nên không bị tải lại giữa chừng).
function summaryFor(summary, user, own) {
  if (!own || own.type !== 'excel' || own.id === summary.id) {
    const data = viewerData(summary);
    return { data, rev: store.sha(store.canon(data)), live: false };
  }
  const book = store.books.get(summary.bookId);
  const all = {}, lower = {};
  for (const o of store.bookItems(book)) if (o.type === 'excel' && o.id !== summary.id) { all[o.name] = o.data.cells; lower[o.name.toLowerCase()] = o.name; }
  const evs = {};
  const valueAt = (name, r, c) => (evs[name] ||= makeEvaluator(name, all[name], all)).valueAt(r, c);
  const hidden = new Set(hiddenKeys(summary));
  // Sheet của user có ô bị ẩn: trình soạn thảo của họ không có số thật của ô ẩn nên tự tính sẽ SAI. Khi đó thay mọi số bằng giá trị đúng từ máy chủ (không sống).
  const ownName = hiddenKeys(own).length ? '\u0000' : own.name;
  const mat = materialize(summary.data, summary.name, all).cells;
  const cells = {};
  for (const [k, c] of Object.entries(summary.data.cells)) {
    const { f, ...rest } = c;
    if (hidden.has(k) || (f && formulaUsesHidden(f, hidden))) { if (c.s) cells[k] = { s: c.s }; continue; }
    if (!f) { cells[k] = c; continue; }
    const v = mat[k].v;
    const sub = substituteForeign(f, ownName, (n) => lower[n.toLowerCase()], valueAt);
    cells[k] = sub && sub.keep ? { ...rest, f: sub.f, v } : { ...rest, v };
  }
  const fingerprint = Object.entries(cells).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, c]) => [k, c.f ? c.f : c.v ?? null, c.s || null]);
  return { data: { ...summary.data, cells }, rev: store.sha(store.canon(fingerprint)), live: ownName === own.name };
}
// Các bảng tổng hợp user được xem, dùng khi user mở sheet `it` của mình
function summariesFor(user, it) {
  if (!user || isAdmin(user) || it.type !== 'excel' || it.assigneeId !== user.id) return [];
  const book = store.books.get(it.bookId);
  if (!book) return [];
  return store.bookItems(book)
    .filter((s) => s.type === 'excel' && s.id !== it.id && (s.viewerIds || []).includes(user.id))
    .map((s) => ({ id: s.id, name: s.name, ...summaryFor(s, user, it) }));
}

// Những sheet nguồn mà công thức của bảng tổng hợp này lấy số liệu (và ai đang làm sheet đó): gợi ý cấp quyền xem cho đúng người
function relatedSources(it) {
  const book = store.books.get(it.bookId);
  const text = Object.values(it.data.cells).filter((c) => c.f).map((c) => c.f.toLowerCase()).join('\n');
  if (!text) return [];
  return store.bookItems(book).filter((o) => o.id !== it.id && o.type === 'excel' && (text.includes(`'${o.name.toLowerCase()}'!`) || text.includes(`${o.name.toLowerCase()}!`)))
    .map((o) => ({ itemId: o.id, itemName: o.name, userId: o.assigneeId || null, userName: o.assigneeId ? store.user(o.assigneeId)?.name || null : null }));
}

// Dữ liệu ô mà người này được thấy: ô ẩn bị gỡ nội dung (giữ định dạng) với mọi người không phải admin
function dataFor(user, it) {
  if (isAdmin(user) || it.type !== 'excel') return it.data;
  if (perm(user, it).viewer) return viewerData(it);
  const hid = hiddenKeys(it);
  if (!hid.length) return it.data;
  const cells = { ...it.data.cells };
  const hidden = new Set(hid);
  for (const k of hid) {
    const c = cells[k];
    if (c) { if (c.s) cells[k] = { s: c.s }; else delete cells[k]; }
  }
  for (const [k, c] of Object.entries(cells)) {
    if (c.f && formulaUsesHidden(c.f, hidden)) cells[k] = c.s ? { s: c.s, f: c.f } : { f: c.f };
  }
  return { ...it.data, cells };
}

function userView(it, user) {
  const p = perm(user, it);
  return {
    id: it.id, name: it.name, type: it.type, status: it.status, editable: p.edit, pastDue: p.pastDue, viewOnly: p.viewer,
    deadline: it.deadline, submittedAt: it.submittedAt, approvedAt: it.approvedAt, returnNote: it.returnNote, version: it.version,
    protect: protectView(it),
  }; // KHÔNG có bookId, tên workbook lớn hay thông tin workbook khác
}
function adminView(it) {
  const a = it.assigneeId ? store.user(it.assigneeId) : null;
  return {
    id: it.id, bookId: it.bookId, name: it.name, type: it.type, status: it.status, editable: true,
    assigneeId: it.assigneeId, assigneeName: a ? a.name : null,
    submittedAt: it.submittedAt, approvedAt: it.approvedAt, returnNote: it.returnNote, submitHash: it.submitHash, updatedAt: it.updatedAt, version: it.version,
    viewerIds: it.viewerIds || [], viewerNames: (it.viewerIds || []).map((id) => store.user(id)?.name).filter(Boolean),
    deadline: it.deadline, protectOn: it.protect.on, protectCount: Object.keys(it.protect.cells).length, hiddenCount: hiddenKeys(it).length,
    pastDue: !!(it.deadline && Date.now() > Date.parse(it.deadline)),
  };
}

// ---------- chỉnh sửa (từ WebSocket) ----------
function cleanPatch(patch) {
  if (!patch || typeof patch !== 'object') return null;
  const keys = Object.keys(patch);
  if (!keys.length || keys.length > 5000) return null;
  const out = {};
  for (const k of keys) {
    if (!keyOK(k)) return null;
    if (patch[k] === null) { out[k] = null; continue; }
    const c = cleanCell(patch[k]);
    if (!c) return null;
    out[k] = Object.keys(c).length ? c : null;
  }
  return out;
}

function applyEdit(user, id, msg, ip) {
  const it = getReadable(user, id, ip);
  const p = perm(user, it);
  if (FINAL.has(it.status) && !p.admin) throw E(409, 'Đã nộp, không thể sửa');
  if (!p.edit) throw E(403, p.pastDue ? 'Đã quá hạn nộp' : 'Bạn chỉ được xem phần này');
  const out = { itemId: it.id, bookId: it.bookId, by: user.id };
  let op;
  if (it.type === 'word') {
    if (typeof msg.html !== 'string' || msg.html.length > 5e6) throw E(400, 'Dữ liệu không hợp lệ');
    op = { html: msg.html };
    out.html = msg.html;
  } else {
    const patch = cleanPatch(msg.patch);
    if (!patch) throw E(400, 'Dữ liệu không hợp lệ');
    if (!p.admin) {
      const hid = it.protect.hidden || {};
      for (const k of Object.keys(patch)) if (hid[k]) throw E(403, 'Ô này đã bị ẩn, bạn không được sửa');
    }
    if (!p.admin && it.protect.on) {
      for (const k of Object.keys(patch)) if (!it.protect.cells[k]) throw E(403, 'Ô này đã bị khóa, bạn không được sửa');
    }
    if (store.cellCount(it) + Object.keys(patch).length > MAX_CELLS) throw E(400, 'Quá nhiều ô');
    op = { patch };
    if (msg.dims) {
      op.dims = { rows: cleanDim(msg.dims.rows, it.data.rows), cols: cleanDim(msg.dims.cols, it.data.cols) };
      out.dims = op.dims;
    }
    if (msg.widths) { op.widths = cleanWidths(msg.widths); out.widths = op.widths; }
    out.patch = patch;
  }
  store.applyPatch(it, op, user.id); // ghi nhật ký thao tác ngay; khối dữ liệu được ghi gộp sau
  out.version = it.version;
  let statusChanged = false;
  if (it.assigneeId && it.status === 'assigned') { it.status = 'in_progress'; statusChanged = true; store.saveItem(it); }
  bus.emit('patch', out);
  if (statusChanged) emitStatus(it);
  return out;
}

function emitStatus(it) { bus.emit('status', { item: it }); }

// ---------- mở lần đầu / nộp / mở lại ----------
function markOpened(user, it) {
  if (it.assigneeId === user.id && it.status === 'assigned') {
    it.status = 'in_progress';
    store.saveItem(it);
    emitStatus(it);
  }
}

const sigMsg = (it, hash) => `${it.id}|${hash}|${it.submittedAt}|${it.assigneeId}`;
function submit(user, id, ip) {
  const it = getReadable(user, id, ip);
  if (it.assigneeId !== user.id) throw E(403, 'Chỉ người được giao mới được nộp');
  if (FINAL.has(it.status)) throw E(409, 'Đã nộp rồi');
  if (it.deadline && Date.now() > Date.parse(it.deadline)) throw E(403, 'Đã quá hạn nộp');
  store.flushItems();
  it.returnNote = null;
  it.status = 'submitted';
  it.submittedAt = new Date().toISOString();
  it.submitHash = store.sha(store.canon(it.data));
  it.submitSig = store.sign(sigMsg(it, it.submitHash)); // chữ ký HMAC của server: không thể giả mạo nếu không có khóa
  it.submitSnapshotId = store.createSnapshot(it, 'submit', user.id, it.submitHash, it.submitSig); // bản chụp bất biến làm bằng chứng
  it.history.push({ at: it.submittedAt, action: 'submit', by: user.id, hash: it.submitHash });
  store.saveItem(it, true);
  store.audit(user.id, 'submit', it.id, ip, { hash: it.submitHash.slice(0, 12) });
  emitStatus(it);
  bus.emit('submitted', { item: it });
  return it;
}

// Admin duyệt bài đã nộp: khóa hẳn, được tính là bài chuẩn để tổng hợp
function approve(user, id, ip) {
  const it = store.items.get(id);
  if (!isAdmin(user) || !it) throw E(404, 'Không tìm thấy');
  if (it.status !== 'submitted') throw E(409, 'Chỉ duyệt được bài đã nộp');
  it.status = 'approved'; it.approvedAt = new Date().toISOString();
  it.history.push({ at: it.approvedAt, action: 'approve', by: user.id, hash: it.submitHash });
  store.saveItem(it, true);
  store.audit(user.id, 'approve', it.id, ip);
  emitStatus(it);
  return it;
}

// Admin trả lại để làm lại (kèm lý do); dùng được cho cả bài đã nộp lẫn đã duyệt
function reopen(user, id, reason, ip) {
  const it = store.items.get(id);
  if (!isAdmin(user) || !it || !it.assigneeId || !FINAL.has(it.status)) throw E(404, 'Không tìm thấy');
  const note = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
  it.history.push({ at: new Date().toISOString(), action: 'return', by: user.id, hash: it.submitHash, note });
  it.status = 'in_progress'; it.submittedAt = null; it.approvedAt = null; it.submitHash = null; it.submitSig = null; it.submitSnapshotId = null;
  it.returnNote = note || null;
  store.saveItem(it, true);
  store.audit(user.id, 'return', it.id, ip, note ? { note: note.slice(0, 80) } : null);
  emitStatus(it);
  return it;
}

// Kiểm tra toàn vẹn bài nộp: dữ liệu hiện tại + chữ ký + bản chụp bất biến phải khớp nhau
function verify(it) {
  if (!FINAL.has(it.status)) return { state: 'not_submitted' };
  const hash = store.sha(store.canon(it.data));
  const sigOk = it.submitSig === store.sign(sigMsg(it, it.submitHash));
  const dataOk = hash === it.submitHash;
  let snapOk = false;
  try {
    const sn = store.getSnapshot(it.submitSnapshotId);
    snapOk = !!sn && sn.hash === it.submitHash && sn.sig === it.submitSig && store.sha(store.canon(sn.data)) === it.submitHash;
  } catch { snapOk = false; }
  return { state: sigOk && dataOk && snapOk ? 'ok' : 'tampered', sigOk, dataOk, snapOk, hash: it.submitHash, submittedAt: it.submittedAt };
}

// ---------- phân quyền ----------
function assign(user, bookId, assignments, deadlines, ip) {
  const book = store.books.get(bookId);
  if (!book) throw E(404, 'Không tìm thấy');
  const own = (id) => book.itemIds.includes(id);
  for (const [iid, uid] of Object.entries(assignments || {})) {
    if (!own(iid)) throw E(400, 'Workbook nhỏ không tồn tại');
    if (uid !== null && !(store.user(uid) && store.user(uid).role === 'user')) throw E(400, 'Người dùng không hợp lệ');
  }
  for (const [iid, d] of Object.entries(deadlines || {})) {
    if (!own(iid)) throw E(400, 'Workbook nhỏ không tồn tại');
    if (d !== null && Number.isNaN(Date.parse(d))) throw E(400, 'Hạn nộp không hợp lệ');
  }
  const changed = [];
  for (const [iid, uid] of Object.entries(assignments || {})) {
    const it = store.items.get(iid);
    if (it.assigneeId === uid) continue;
    const prev = it.assigneeId;
    it.assigneeId = uid;
    // Mốc so sánh: bản chụp bất biến của bảng ngay lúc giao. Khi user nộp, admin so với mốc này để biết user đã đổi những ô nào.
    it.baseSnapshotId = uid ? store.createSnapshot(it, 'assign', user.id, store.sha(store.canon(it.data)), null) : null;
    if (uid) it.viewerIds = (it.viewerIds || []).filter((x) => x !== uid); // đã là người làm bài thì không còn là "người chỉ xem"
    if (uid && it.protect.on) {
      it.protect.on = false;
      it.protect.rev = (it.protect.rev || 0) + 1;
    }
    it.status = uid ? 'assigned' : 'unassigned';
    it.submittedAt = null; it.approvedAt = null; it.returnNote = null; it.submitHash = null; it.submitSig = null; it.submitSnapshotId = null;
    it.history.push({ at: new Date().toISOString(), action: uid ? 'assign:' + uid : 'unassign', by: user.id });
    store.saveItem(it);
    store.audit(user.id, uid ? 'assign:' + uid : 'unassign', iid, ip);
    changed.push({ it, prev });
  }
  for (const [iid, d] of Object.entries(deadlines || {})) {
    const it = store.items.get(iid);
    const nd = d ? new Date(d).toISOString() : null;
    if (it.deadline === nd) continue;
    it.deadline = nd; store.saveItem(it);
    store.audit(user.id, 'deadline', iid, ip, { to: nd });
    if (!changed.find((c) => c.it === it)) changed.push({ it, prev: it.assigneeId });
  }
  store.flushItems();
  changed.forEach(({ it, prev }) => bus.emit('status', { item: it, prevAssigneeId: prev }));
  return changed.length;
}

// ---------- bảo vệ ô (khóa ô chỉ cho phép nhập vào ô được đánh dấu) ----------
function setProtect(user, id, body, ip) {
  const it = store.items.get(id);
  if (!isAdmin(user) || !it || it.type !== 'excel') throw E(404, 'Không tìm thấy');
  if (typeof body.on === 'boolean') it.protect.on = body.on;
  const cells = { ...it.protect.cells };
  for (const [list, val] of [[body.allow, true], [body.deny, false]]) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 60000 || !list.every((k) => typeof k === 'string' && keyOK(k))) throw E(400, 'Danh sách ô không hợp lệ');
    list.forEach((k) => { if (val) cells[k] = 1; else delete cells[k]; });
  }
  if (Array.isArray(body.deny) && body.deny.length) it.protect.on = true;
  it.protect.cells = cells;
  const hidden = { ...(it.protect.hidden || {}) };
  for (const [list, val] of [[body.hide, true], [body.show, false]]) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 60000 || !list.every((k) => typeof k === 'string' && keyOK(k))) throw E(400, 'Danh sách ô không hợp lệ');
    list.forEach((k) => { if (val) hidden[k] = 1; else delete hidden[k]; });
  }
  if (Array.isArray(body.hide) && body.hide.length) it.protect.on = true;
  it.protect.hidden = hidden;
  it.protect.rev = (it.protect.rev || 0) + 1;
  store.saveItem(it, true);
  store.audit(user.id, 'protect', it.id, ip, { on: it.protect.on, n: Object.keys(cells).length, hidden: Object.keys(hidden).length });
  bus.emit('protect', { item: it });
  return protectView(it, true);
}

// ---------- cấp quyền XEM bảng tổng hợp cho user (chỉ admin) ----------
function setViewers(user, id, userIds, ip) {
  const it = store.items.get(id);
  if (!isAdmin(user) || !it || it.type !== 'excel') throw E(404, 'Không tìm thấy');
  if (!Array.isArray(userIds) || userIds.length > 200 || !userIds.every((x) => typeof x === 'string')) throw E(400, 'Danh sách người dùng không hợp lệ');
  const next = [...new Set(userIds)].filter((uid) => uid !== it.assigneeId);
  if (!next.every((uid) => store.user(uid) && store.user(uid).role === 'user')) throw E(400, 'Người dùng không hợp lệ');
  const prev = it.viewerIds || [];
  const added = next.filter((x) => !prev.includes(x)), removed = prev.filter((x) => !next.includes(x));
  if (!added.length && !removed.length) return { viewerIds: prev, added, removed };
  it.viewerIds = next;
  const at = new Date().toISOString();
  added.forEach((uid) => it.history.push({ at, action: 'view_grant:' + uid, by: user.id }));
  removed.forEach((uid) => it.history.push({ at, action: 'view_revoke:' + uid, by: user.id }));
  store.saveItem(it, true);
  store.audit(user.id, 'viewers', it.id, ip, { added, removed });
  bus.emit('viewers', { item: it, added, removed });
  return { viewerIds: next, added, removed };
}

module.exports = {
  setViewers, relatedSources, viewerData, summaryFor, summariesFor,
  bus, HttpError, E, perm, isAdmin, getReadable, userView, adminView, protectView, hiddenKeys, dataFor,
  applyEdit, markOpened, submit, approve, reopen, verify, FINAL, assign, setProtect, emitStatus,
};
