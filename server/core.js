// Lõi nghiệp vụ. MỌI thao tác (REST và WebSocket) đều đi qua đây nên quyền chỉ được kiểm tra ở 1 nơi.
const EventEmitter = require('events');
const store = require('./store');
const { cleanCell, keyOK, cleanWidths, cleanDim, MAX_CELLS } = require('./excel');

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
  const read = admin || own;
  const edit = !FINAL.has(it.status) && (admin || (!pastDue && own));
  return { admin, own, read, edit, pastDue };
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
function userView(it, user) {
  const p = perm(user, it);
  return {
    id: it.id, name: it.name, type: it.type, status: it.status, editable: p.edit, pastDue: p.pastDue,
    deadline: it.deadline, submittedAt: it.submittedAt, approvedAt: it.approvedAt, returnNote: it.returnNote, version: it.version,
    protect: it.protect.on ? { on: true, cells: it.protect.cells } : { on: false, cells: {} },
  }; // KHÔNG có bookId, tên workbook lớn hay thông tin workbook khác
}
function adminView(it) {
  const a = it.assigneeId ? store.user(it.assigneeId) : null;
  return {
    id: it.id, bookId: it.bookId, name: it.name, type: it.type, status: it.status,
    assigneeId: it.assigneeId, assigneeName: a ? a.name : null,
    submittedAt: it.submittedAt, approvedAt: it.approvedAt, returnNote: it.returnNote, submitHash: it.submitHash, updatedAt: it.updatedAt, version: it.version,
    deadline: it.deadline, protectOn: it.protect.on, protectCount: Object.keys(it.protect.cells).length,
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
  if (FINAL.has(it.status)) throw E(409, 'Đã nộp, không thể sửa');
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
  it.protect.cells = cells;
  store.saveItem(it, true);
  store.audit(user.id, 'protect', it.id, ip, { on: it.protect.on, n: Object.keys(cells).length });
  bus.emit('protect', { item: it });
  return it.protect;
}

module.exports = {
  bus, HttpError, E, perm, isAdmin, getReadable, userView, adminView,
  applyEdit, markOpened, submit, approve, reopen, verify, FINAL, assign, setProtect, emitStatus,
};
