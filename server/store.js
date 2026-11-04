// Lớp lưu trữ v4: SQLite (có sẵn trong Node 22.13+, không cần cài thêm) + mã hóa theo lớp khóa.
//  - Khóa chủ (DATA_KEY hoặc data/.key) chỉ dùng để BỌC khóa dữ liệu của từng workbook lớn (DEK).
//  - Nội dung sheet chia thành khối 200 dòng, mỗi khối nén + mã hóa AES-256-GCM riêng (AAD = mã workbook:khối),
//    nên không thể tráo khối giữa các workbook. Sửa 1 ô chỉ ghi lại đúng 1 khối.
//  - Mỗi chỉnh sửa được ghi vào nhật ký thao tác (ops) ngay lập tức; khối được ghi sau (gộp). Sập máy giữa chừng:
//    khi khởi động lại, hệ thống phát lại ops chưa ghi vào khối nên không mất dữ liệu.
//  - Bản chụp lúc nộp (snapshots) và file tổng hợp (blobs) là bất biến.
//  Muốn chuyển sang PostgreSQL: giữ nguyên các hàm xuất ra ở cuối file, chỉ thay phần SQL.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA, 'blobs'), { recursive: true });
const CH = 200; // số dòng mỗi khối

// ---------- khóa chủ ----------
let keySource = 'env';
function loadMaster() {
  if (process.env.DATA_KEY) {
    const k = Buffer.from(process.env.DATA_KEY, 'hex');
    if (k.length !== 32) throw new Error('DATA_KEY phải gồm 64 ký tự hex (32 byte)');
    return k;
  }
  keySource = 'file';
  const kf = path.join(DATA, '.key');
  if (fs.existsSync(kf)) return Buffer.from(fs.readFileSync(kf, 'utf8').trim(), 'hex');
  const k = crypto.randomBytes(32);
  fs.writeFileSync(kf, k.toString('hex'), { mode: 0o600 });
  console.warn('[CẢNH BÁO] Chưa đặt DATA_KEY: đã tạo khóa tại data/.key. Production hãy dùng biến môi trường hoặc KMS.');
  return k;
}
let MASTER = loadMaster();

// ---------- mã hóa ----------
const seal = (key, buf, aad) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
};
const open = (key, blob, aad) => {
  const b = Buffer.from(blob);
  if (b[0] !== 1) throw new Error('Định dạng dữ liệu không hợp lệ');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(1, 13));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(13, 29)); // sai khóa / bị sửa / bị tráo: lỗi tại đây
  return Buffer.concat([d.update(b.subarray(29)), d.final()]);
};
const pack = (key, obj, aad) => seal(key, zlib.deflateSync(Buffer.from(JSON.stringify(obj))), aad);
const unpack = (key, blob, aad) => JSON.parse(zlib.inflateSync(open(key, blob, aad)).toString('utf8'));

const rid = () => crypto.randomBytes(6).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canon = (x) => {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
  return JSON.stringify(x === undefined ? null : x);
};
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');

// ---------- cơ sở dữ liệu ----------
const db = new DatabaseSync(path.join(DATA, 'office.db'));
db.exec(`
PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, val BLOB);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, name TEXT, role TEXT, pw TEXT, default_pw INTEGER, totp BLOB);
CREATE TABLE IF NOT EXISTS audit(n INTEGER PRIMARY KEY, at TEXT, u TEXT, a TEXT, i TEXT, ip TEXT, x TEXT, h TEXT);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit chi duoc ghi them'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit chi duoc ghi them'); END;
CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY, created_at TEXT, created_by TEXT, auto INTEGER DEFAULT 1, dek BLOB, meta BLOB);
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, book_id TEXT, ord INTEGER, type TEXT, assignee_id TEXT, status TEXT,
  version INTEGER, flushed INTEGER, updated_at TEXT, submitted_at TEXT, submit_hash TEXT, deadline TEXT, meta BLOB);
CREATE INDEX IF NOT EXISTS items_book ON items(book_id, ord);
CREATE TABLE IF NOT EXISTS chunks(item_id TEXT, chunk INTEGER, data BLOB, PRIMARY KEY(item_id, chunk));
CREATE TABLE IF NOT EXISTS ops(id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, v INTEGER, user_id TEXT, at TEXT, patch BLOB);
CREATE INDEX IF NOT EXISTS ops_item ON ops(item_id, v);
CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, item_id TEXT, kind TEXT, v INTEGER, at TEXT, by TEXT, hash TEXT, sig TEXT, data BLOB);
CREATE INDEX IF NOT EXISTS snap_item ON snapshots(item_id, kind, at);
CREATE TRIGGER IF NOT EXISTS snap_no_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT, 'ban chup la bat bien'); END;
CREATE TABLE IF NOT EXISTS consolidations(id TEXT PRIMARY KEY, book_id TEXT, n INTEGER, at TEXT, by TEXT, mode TEXT, sha TEXT, size INTEGER, file_key TEXT, manifest BLOB);
CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, key TEXT, payload TEXT, status TEXT, attempts INTEGER DEFAULT 0,
  run_at INTEGER, created_at TEXT, result TEXT, error TEXT);
`);
const P = (() => { const m = new Map(); return (sql) => { if (!m.has(sql)) m.set(sql, db.prepare(sql)); return m.get(sql); }; })();
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// khóa ký (độc lập với khóa chủ để đổi khóa chủ không làm mất hiệu lực chữ ký bài nộp)
let SIGN_KEY;
{
  const r = P('SELECT val FROM settings WHERE key=?').get('sign');
  if (r) SIGN_KEY = open(MASTER, r.val, 'setting:sign');
  else { SIGN_KEY = crypto.randomBytes(32); P('INSERT INTO settings VALUES(?,?)').run('sign', seal(MASTER, SIGN_KEY, 'setting:sign')); }
}
const sign = (msg) => crypto.createHmac('sha256', SIGN_KEY).update(msg).digest('hex');
const signRaw = (msg) => crypto.createHmac('sha256', SIGN_KEY).update('dl|' + msg).digest('hex');

// ---------- tài khoản ----------
const meta = { users: [] };
const rowToUser = (r) => ({
  id: r.id, username: r.username, name: r.name, role: r.role, pw: r.pw, defaultPw: !!r.default_pw,
  totp: r.totp ? JSON.parse(open(MASTER, r.totp, 'totp:' + r.id).toString()) : null,
});
function saveUser(u) {
  P('INSERT OR REPLACE INTO users VALUES(?,?,?,?,?,?,?)').run(
    u.id, u.username, u.name, u.role, u.pw, u.defaultPw ? 1 : 0,
    u.totp ? seal(MASTER, Buffer.from(JSON.stringify(u.totp)), 'totp:' + u.id) : null);
}
const saveMeta = () => tx(() => meta.users.forEach(saveUser));
let metaTimer = null;
const saveMetaSoon = () => { if (!metaTimer) metaTimer = setTimeout(() => { metaTimer = null; saveMeta(); }, 300); };
{
  const rows = P('SELECT * FROM users').all();
  if (!rows.length) {
    const seed = [{ id: 'u0', username: 'admin', name: 'Quản trị viên', role: 'admin', pw: hashPw('admin123'), defaultPw: true, totp: null }];
    for (let i = 1; i <= 10; i++) seed.push({ id: 'u' + i, username: 'user' + i, name: 'Nhân viên ' + i, role: 'user', pw: hashPw('user123'), defaultPw: true, totp: null });
    seed.forEach((u) => { meta.users.push(u); });
    saveMeta();
  } else rows.forEach((r) => meta.users.push(rowToUser(r)));
}

// ---------- nhật ký chuỗi băm, chỉ ghi thêm (có trigger chặn sửa/xóa ở tầng cơ sở dữ liệu) ----------
const auditBody = (e) => canon([e.n, e.at, e.u, e.a, e.i, e.ip, e.x]);
let lastN = 0, lastH = 'GENESIS';
{ const r = P('SELECT n,h FROM audit ORDER BY n DESC LIMIT 1').get(); if (r) { lastN = r.n; lastH = r.h; } }
function audit(userId, action, itemId, ip, extra) {
  const e = { n: lastN + 1, at: new Date().toISOString(), u: userId || null, a: action, i: itemId || null, ip: ip || null, x: extra ? JSON.stringify(extra) : null };
  e.h = sha(lastH + '|' + auditBody(e));
  P('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(e.n, e.at, e.u, e.a, e.i, e.ip, e.x, e.h);
  lastN = e.n; lastH = e.h;
}
function verifyAudit() {
  let prev = 'GENESIS', count = 0;
  for (const r of P('SELECT * FROM audit ORDER BY n').all()) {
    if (sha(prev + '|' + auditBody(r)) !== r.h) return { ok: false, brokenAt: r.n, count };
    prev = r.h; count++;
  }
  return { ok: true, count, head: prev.slice(0, 16) };
}
const recentAudit = (limit) => P('SELECT * FROM audit ORDER BY n DESC LIMIT ?').all(limit).map((r) => ({ ...r, x: r.x ? JSON.parse(r.x) : null }));

// ---------- workbook lớn (book) ----------
const books = new Map();
const items = new Map();
const deks = new Map();
const dekOf = (bookId) => { const k = deks.get(bookId); if (!k) throw new Error('Không có khóa dữ liệu cho workbook lớn'); return k; };

function saveBook(b) {
  if (!deks.has(b.id)) deks.set(b.id, crypto.randomBytes(32));
  const dek = deks.get(b.id);
  P('INSERT OR REPLACE INTO books VALUES(?,?,?,?,?,?)').run(
    b.id, b.createdAt, b.createdBy, b.auto === false ? 0 : 1, seal(MASTER, dek, 'dek:' + b.id), pack(dek, { title: b.title }, 'book:' + b.id));
  books.set(b.id, b);
}
for (const r of P('SELECT * FROM books').all()) {
  const dek = open(MASTER, r.dek, 'dek:' + r.id);
  deks.set(r.id, dek);
  books.set(r.id, { id: r.id, title: unpack(dek, r.meta, 'book:' + r.id).title, createdAt: r.created_at, createdBy: r.created_by, auto: !!r.auto, itemIds: [] });
}

// ---------- workbook nhỏ (item): metadata luôn nằm trong RAM, dữ liệu nạp theo nhu cầu ----------
const cache = new Map(); // itemId -> { data, idx: Map(chunk -> Set(key)), count, dirty:Set, layout, last }
const chunkOf = (key) => Math.floor(parseInt(key, 10) / CH);
const MAX_CACHE = Number(process.env.CACHE_ITEMS) || 48;

function makeItem(row, m) {
  const it = {
    id: row.id, bookId: row.book_id, ord: row.ord, type: row.type, assigneeId: row.assignee_id, status: row.status,
    version: row.version, flushed: row.flushed, updatedAt: row.updated_at, submittedAt: row.submitted_at,
    submitHash: row.submit_hash, deadline: row.deadline,
    name: m.name, protect: m.protect, history: m.history, submitSig: m.submitSig || null, submitSnapshotId: m.submitSnapshotId || null,
    returnNote: m.returnNote || null, approvedAt: m.approvedAt || null,
  };
  Object.defineProperty(it, 'data', { get() { return entry(it).data; }, set(v) { replaceData(it, v); }, enumerable: false, configurable: true });
  return it;
}
function writeItemRow(it) {
  const dek = dekOf(it.bookId);
  const m = { name: it.name, protect: it.protect, history: it.history, submitSig: it.submitSig, submitSnapshotId: it.submitSnapshotId, returnNote: it.returnNote, approvedAt: it.approvedAt };
  P('INSERT OR REPLACE INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    it.id, it.bookId, it.ord, it.type, it.assigneeId, it.status, it.version, it.flushed, it.updatedAt, it.submittedAt, it.submitHash, it.deadline,
    pack(dek, m, 'item:' + it.id));
}
for (const r of P('SELECT * FROM items ORDER BY book_id, ord').all()) {
  const b = books.get(r.book_id);
  if (!b) continue;
  const it = makeItem(r, unpack(dekOf(r.book_id), r.meta, 'item:' + r.id));
  items.set(it.id, it); b.itemIds.push(it.id);
}

function buildEntry(it, data) {
  const e = { data, idx: new Map(), count: 0, dirty: new Set(), layout: false, last: Date.now() };
  if (it.type === 'excel') for (const k in data.cells) { const c = chunkOf(k); if (!e.idx.has(c)) e.idx.set(c, new Set()); e.idx.get(c).add(k); e.count++; }
  return e;
}
function entry(it) {
  let e = cache.get(it.id);
  if (e) { e.last = Date.now(); return e; }
  const dek = dekOf(it.bookId);
  let data;
  if (it.type === 'word') {
    const r = P('SELECT data FROM chunks WHERE item_id=? AND chunk=0').get(it.id);
    data = r ? unpack(dek, r.data, `chunk:${it.id}:0`) : { html: '' };
  } else if (it.type === 'pdf') {
    const r = P('SELECT data FROM chunks WHERE item_id=? AND chunk=0').get(it.id);
    data = r ? unpack(dekOf(it.bookId), r.data, `chunk:${it.id}:0`) : { pdf: '' };
  } else {
    data = { rows: 100, cols: 26, colWidths: {}, cells: {} };
    for (const r of P('SELECT chunk, data FROM chunks WHERE item_id=?').all(it.id)) {
      const o = unpack(dek, r.data, `chunk:${it.id}:${r.chunk}`);
      if (r.chunk === -1) Object.assign(data, o); else Object.assign(data.cells, o);
    }
  }
  e = buildEntry(it, data);
  cache.set(it.id, e);
  return e;
}
const dataKeepAlive = (it) => entry(it);

function writeAll(it, data) { // ghi toàn bộ dữ liệu (khi tạo mới hoặc thay thế)
  const dek = dekOf(it.bookId);
  P('DELETE FROM chunks WHERE item_id=?').run(it.id);
  if (it.type === 'word') P('INSERT INTO chunks VALUES(?,?,?)').run(it.id, 0, pack(dek, { html: data.html }, `chunk:${it.id}:0`));
  else if (it.type === 'pdf') P('INSERT INTO chunks VALUES(?,?,?)').run(it.id, 0, pack(dek, { pdf: data.pdf }, `chunk:${it.id}:0`));
  else {
    P('INSERT INTO chunks VALUES(?,?,?)').run(it.id, -1, pack(dek, { rows: data.rows, cols: data.cols, colWidths: data.colWidths }, `chunk:${it.id}:-1`));
    const by = new Map();
    for (const k in data.cells) { const c = chunkOf(k); if (!by.has(c)) by.set(c, {}); by.get(c)[k] = data.cells[k]; }
    for (const [c, o] of by) P('INSERT INTO chunks VALUES(?,?,?)').run(it.id, c, pack(dek, o, `chunk:${it.id}:${c}`));
  }
}
function replaceData(it, data) { tx(() => writeAll(it, data)); cache.set(it.id, buildEntry(it, data)); }

function newItem(book, name, type, data, extra = {}) {
  const it = makeItem({
    id: rid(), book_id: book.id, ord: book.itemIds.length, type, assignee_id: null, status: 'unassigned', version: 0, flushed: 0,
    updated_at: null, submitted_at: null, submit_hash: null, deadline: null,
  }, { name, protect: { on: false, cells: {} }, history: [], ...extra });
  items.set(it.id, it); book.itemIds.push(it.id);
  tx(() => { writeItemRow(it); writeAll(it, data); });
  cache.set(it.id, buildEntry(it, data));
  return it;
}
function saveItem(it, immediate) {
  items.set(it.id, it);
  writeItemRow(it);
  if (immediate) flush();
}

// áp 1 thao tác vào bộ nhớ (dùng chung cho chỉnh sửa mới và phát lại sau sập máy)
function applyToEntry(it, e, op) {
  const d = e.data;
  if (it.type === 'word') { d.html = op.html; e.dirty.add(0); return; }
  if (op.patch) {
    for (const [k, v] of Object.entries(op.patch)) {
      const c = chunkOf(k);
      if (v === null) { if (k in d.cells) { delete d.cells[k]; e.idx.get(c)?.delete(k); e.count--; } }
      else { if (!(k in d.cells)) { if (!e.idx.has(c)) e.idx.set(c, new Set()); e.idx.get(c).add(k); e.count++; } d.cells[k] = v; }
      e.dirty.add(c);
    }
  }
  if (op.dims) { d.rows = op.dims.rows; d.cols = op.dims.cols; e.layout = true; }
  if (op.widths) { d.colWidths = { ...d.colWidths, ...op.widths }; e.layout = true; }
}
function applyPatch(it, op, userId) {
  const e = entry(it);
  applyToEntry(it, e, op);
  it.version++; it.updatedAt = new Date().toISOString();
  P('INSERT INTO ops(item_id,v,user_id,at,patch) VALUES(?,?,?,?,?)').run(it.id, it.version, userId, it.updatedAt, pack(dekOf(it.bookId), op, 'op:' + it.id));
  scheduleFlush();
}
const cellCount = (it) => entry(it).count;

let flushTimer = null;
const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(flush, 500); };
function flush() {
  clearTimeout(flushTimer); flushTimer = null;
  const done = [];
  tx(() => {
    for (const [id, e] of cache) {
      if (!e.dirty.size && !e.layout) continue;
      const it = items.get(id); if (!it) continue;
      const dek = dekOf(it.bookId);
      if (it.type === 'word') P('INSERT OR REPLACE INTO chunks VALUES(?,?,?)').run(id, 0, pack(dek, { html: e.data.html }, `chunk:${id}:0`));
      else {
        for (const c of e.dirty) {
          const o = {};
          for (const k of e.idx.get(c) || []) o[k] = e.data.cells[k];
          P('INSERT OR REPLACE INTO chunks VALUES(?,?,?)').run(id, c, pack(dek, o, `chunk:${id}:${c}`));
        }
        if (e.layout) P('INSERT OR REPLACE INTO chunks VALUES(?,?,?)').run(id, -1, pack(dek, { rows: e.data.rows, cols: e.data.cols, colWidths: e.data.colWidths }, `chunk:${id}:-1`));
      }
      it.flushed = it.version;
      P('UPDATE items SET version=?, flushed=?, updated_at=? WHERE id=?').run(it.version, it.flushed, it.updatedAt, id);
      e.dirty.clear(); e.layout = false; done.push(it);
    }
    for (const it of done) P('DELETE FROM ops WHERE item_id=? AND v <= ?').run(it.id, it.flushed - 500); // nén nhật ký, giữ 500 thao tác gần nhất
  });
  if (cache.size > MAX_CACHE) { // giải phóng RAM: bỏ các workbook ít dùng nhất
    [...cache.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, cache.size - MAX_CACHE)
      .forEach(([id, e]) => { if (!e.dirty.size && !e.layout) cache.delete(id); });
  }
}

// phục hồi sau sập máy: phát lại các thao tác chưa kịp ghi vào khối
{
  let replayed = 0;
  for (const it of items.values()) {
    if (it.version <= it.flushed) continue;
    const e = entry(it), dek = dekOf(it.bookId);
    for (const r of P('SELECT v, patch FROM ops WHERE item_id=? AND v > ? ORDER BY v').all(it.id, it.flushed)) {
      applyToEntry(it, e, unpack(dek, r.patch, 'op:' + it.id)); replayed++;
    }
  }
  if (replayed) { flush(); console.log(`[Phục hồi] đã phát lại ${replayed} thao tác chưa kịp ghi trước khi sập máy`); }
}

function deleteItem(id) {
  const it = items.get(id); if (!it) return;
  const b = books.get(it.bookId);
  tx(() => { for (const t of ['chunks', 'ops', 'snapshots']) P(`DELETE FROM ${t} WHERE item_id=?`).run(id); P('DELETE FROM items WHERE id=?').run(id); });
  if (b) b.itemIds = b.itemIds.filter((x) => x !== id);
  items.delete(id); cache.delete(id);
}
function deleteBook(id) {
  const b = books.get(id); if (!b) return;
  [...b.itemIds].forEach(deleteItem);
  for (const c of P('SELECT file_key FROM consolidations WHERE book_id=?').all(id)) deleteBlob(c.file_key);
  tx(() => { P('DELETE FROM consolidations WHERE book_id=?').run(id); P('DELETE FROM books WHERE id=?').run(id); });
  books.delete(id); deks.delete(id);
}
const bookItems = (b) => b.itemIds.map((i) => items.get(i)).filter(Boolean);

// ---------- bản chụp bất biến ----------
function createSnapshot(it, kind, by, hash, sigv) {
  const id = rid();
  P('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(id, it.id, kind, it.version, new Date().toISOString(), by || null, hash, sigv || null, pack(dekOf(it.bookId), it.data, 'snap:' + id));
  return id;
}
function readSnap(r) {
  if (!r) return null;
  const it = items.get(r.item_id);
  return { id: r.id, itemId: r.item_id, kind: r.kind, v: r.v, at: r.at, by: r.by, hash: r.hash, sig: r.sig, data: it ? unpack(dekOf(it.bookId), r.data, 'snap:' + r.id) : null };
}
const getSnapshot = (id) => readSnap(P('SELECT * FROM snapshots WHERE id=?').get(id));
const snapshotByHash = (itemId, hash) => { const r = P('SELECT id FROM snapshots WHERE item_id=? AND hash=? LIMIT 1').get(itemId, hash); return r ? r.id : null; };
const latestSubmitSnapshot = (itemId) => readSnap(P("SELECT * FROM snapshots WHERE item_id=? AND kind='submit' ORDER BY at DESC, rowid DESC LIMIT 1").get(itemId));

// ---------- kho file (đối tượng) mã hóa theo khóa của workbook lớn ----------
const blobPath = (k) => path.join(DATA, 'blobs', k);
function putBlob(bookId, buf) {
  const key = rid() + rid();
  fs.writeFileSync(blobPath(key), seal(dekOf(bookId), buf, 'blob:' + key));
  return key;
}
const getBlob = (bookId, key) => open(dekOf(bookId), fs.readFileSync(blobPath(key)), 'blob:' + key);
function deleteBlob(key) { try { fs.unlinkSync(blobPath(key)); } catch { /* đã xóa */ } }

// ---------- bản tổng hợp workbook lớn (bất biến, có phiên bản) ----------
function addConsolidation(c) {
  const id = rid();
  const n = (P('SELECT MAX(n) AS m FROM consolidations WHERE book_id=?').get(c.bookId).m || 0) + 1;
  const at = new Date().toISOString();
  P('INSERT INTO consolidations VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, c.bookId, n, at, c.by, c.mode, c.sha, c.size, c.fileKey, pack(dekOf(c.bookId), c.manifest, 'cons:' + id));
  return { id, bookId: c.bookId, n, at, by: c.by, mode: c.mode, sha: c.sha, size: c.size, manifest: c.manifest };
}
const readCons = (r) => r && ({ id: r.id, bookId: r.book_id, n: r.n, at: r.at, by: r.by, mode: r.mode, sha: r.sha, size: r.size, fileKey: r.file_key, manifest: unpack(dekOf(r.book_id), r.manifest, 'cons:' + r.id) });
const listConsolidations = (bookId) => P('SELECT * FROM consolidations WHERE book_id=? ORDER BY n DESC').all(bookId).map(readCons);
const getConsolidation = (id) => readCons(P('SELECT * FROM consolidations WHERE id=?').get(id));

// ---------- hàng đợi việc (bền vững, có thử lại, gộp việc trùng) ----------
P("UPDATE jobs SET status='pending' WHERE status='running'").run(); // việc đang chạy khi sập máy: chạy lại
function enqueueJob(type, key, payload, delayMs = 0) {
  const ex = P("SELECT id FROM jobs WHERE type=? AND key=? AND status='pending'").get(type, key);
  const runAt = Date.now() + delayMs;
  if (ex) { P('UPDATE jobs SET run_at=MIN(run_at, ?), payload=? WHERE id=?').run(runAt, JSON.stringify(payload), ex.id); return { id: ex.id, coalesced: true }; }
  const r = P("INSERT INTO jobs(type,key,payload,status,run_at,created_at) VALUES(?,?,?,'pending',?,?)").run(type, key, JSON.stringify(payload), runAt, new Date().toISOString());
  return { id: Number(r.lastInsertRowid), coalesced: false };
}
function claimJob() {
  const j = P("SELECT * FROM jobs WHERE status='pending' AND run_at <= ? ORDER BY id LIMIT 1").get(Date.now());
  if (!j) return null;
  P("UPDATE jobs SET status='running', attempts=attempts+1 WHERE id=?").run(j.id);
  return { ...j, attempts: j.attempts + 1 };
}
const finishJob = (id, result) => P("UPDATE jobs SET status='done', result=? WHERE id=?").run(JSON.stringify(result || null), id);
function failJob(id, error, attempts) {
  if (attempts < 3) P("UPDATE jobs SET status='pending', run_at=?, error=? WHERE id=?").run(Date.now() + 2000 * attempts, String(error), id);
  else P("UPDATE jobs SET status='failed', error=? WHERE id=?").run(String(error), id);
}
const jobState = (type, key) => {
  const r = P("SELECT status, attempts, error FROM jobs WHERE type=? AND key=? ORDER BY id DESC LIMIT 1").get(type, key);
  return r || null;
};
const countJobs = (status) => P('SELECT COUNT(*) AS n FROM jobs WHERE status=?').get(status).n;

// ---------- đổi khóa chủ (không cần mã hóa lại dữ liệu: chỉ bọc lại khóa dữ liệu) ----------
function rotateMasterKey(newHex) {
  const NEW = Buffer.from(newHex, 'hex');
  if (NEW.length !== 32) throw new Error('Khóa mới phải gồm 64 ký tự hex');
  tx(() => {
    for (const [id, dek] of deks) P('UPDATE books SET dek=? WHERE id=?').run(seal(NEW, dek, 'dek:' + id), id);
    for (const u of meta.users) if (u.totp) P('UPDATE users SET totp=? WHERE id=?').run(seal(NEW, Buffer.from(JSON.stringify(u.totp)), 'totp:' + u.id), u.id);
    P('UPDATE settings SET val=? WHERE key=?').run(seal(NEW, SIGN_KEY, 'setting:sign'), 'sign');
  });
  MASTER = NEW;
  if (keySource === 'file') fs.writeFileSync(path.join(DATA, '.key'), NEW.toString('hex'), { mode: 0o600 });
  return keySource;
}

const exit = () => { try { flush(); saveMeta(); } catch { /* đang thoát */ } };
process.on('exit', exit);
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { exit(); process.exit(0); }));

module.exports = {
  DATA, meta, rid, sha, canon, sign, signRaw, hashPw, audit, verifyAudit, recentAudit, saveMeta, saveMetaSoon,
  books, items, saveItem, saveBook, deleteItem, deleteBook, bookItems, newItem, flushItems: flush, applyPatch, cellCount, dataKeepAlive,
  user: (id) => meta.users.find((u) => u.id === id) || null,
  findUser: (n) => meta.users.find((u) => u.username === n) || null,
  createSnapshot, getSnapshot, snapshotByHash, latestSubmitSnapshot,
  putBlob, getBlob, deleteBlob, addConsolidation, listConsolidations, getConsolidation,
  enqueueJob, claimJob, finishJob, failJob, jobState, countJobs, rotateMasterKey, keySource: () => keySource, CH,
};
