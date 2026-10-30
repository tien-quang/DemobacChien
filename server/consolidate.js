// Tổng hợp workbook lớn: gom các workbook nhỏ ĐÃ NỘP (bản chụp bất biến, đã xác minh chữ ký) thành 1 file Excel
// có phiên bản. Công thức tổng hợp được tính lại bằng dữ liệu đã nộp để giá trị trong file luôn đúng.
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const store = require('./store');
const core = require('./core');
const { materialize } = require('./formula');
const { safeHtmlForDocx } = require('./docsafe');

const safeName = (n) => n.replace(/[\\/?*[\]:]/g, '-').slice(0, 31);
const STATUS_VN = { unassigned: 'Chưa giao', assigned: 'Đã giao', in_progress: 'Đang làm', submitted: 'Đã nộp', approved: 'Đã duyệt' };
const MODE_VN = { submitted: 'bài đã nộp và đã duyệt', approved: 'chỉ bài đã duyệt', latest: 'gồm cả bản nháp' };
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildInWorker(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'build-worker.js'), { workerData });
    w.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(Buffer.from(m.buf))));
    w.once('error', reject);
    w.once('exit', (c) => { if (c !== 0) reject(new Error('Luồng dựng file thoát với mã ' + c)); });
  });
}

function statusGrid(book, n, rows, mode, byName) {
  const cells = {};
  const put = (r, c, o) => { cells[r + ',' + c] = o; };
  put(0, 0, { v: `Tổng hợp: ${book.title} (bản v${n})`, s: { b: 1 } });
  put(1, 0, { v: `Tạo lúc ${new Date().toLocaleString('vi-VN')} bởi ${byName}. Chế độ: ${MODE_VN[mode]}.`, s: { i: 1, c: '#5f6b7a' } });
  ['Workbook nhỏ', 'Loại', 'Người làm', 'Trạng thái', 'Nộp lúc', 'Mã băm SHA-256', 'Đưa vào file', 'Ghi chú'].forEach((h, c) =>
    put(3, c, { v: h, s: { b: 1, c: '#ffffff', bg: '#1d6f42' } }));
  rows.forEach((r, i) => {
    const y = 4 + i;
    put(y, 0, { v: r.name });
    put(y, 1, { v: r.type === 'excel' ? 'Bảng tính' : 'Văn bản' });
    put(y, 2, { v: r.assignee || (r.type === 'excel' ? 'Admin' : '') });
    put(y, 3, { v: STATUS_VN[r.status] });
    put(y, 4, { v: r.submittedAt ? new Date(r.submittedAt).toLocaleString('vi-VN') : '' });
    put(y, 5, { v: r.hash ? r.hash.slice(0, 20) : '' });
    put(y, 6, { v: r.included ? 'Có' : 'Không', s: { b: 1, c: r.included ? '#1d6f42' : '#a4262c' } });
    put(y, 7, { v: r.note || (r.changed ? 'Có thay đổi so với bản trước' : '') });
  });
  return { rows: Math.max(40, rows.length + 6), cols: 9, colWidths: { 0: 190, 1: 80, 2: 130, 3: 90, 4: 150, 5: 190, 6: 100, 7: 260 }, cells };
}

async function consolidate({ bookId, mode, by }) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('Workbook lớn không tồn tại');
  mode = ['latest', 'approved'].includes(mode) ? mode : 'submitted';
  const prev = store.listConsolidations(bookId)[0] || null;
  const prevRows = new Map((prev ? prev.manifest.items : []).map((r) => [r.itemId, r]));
  const rows = [], included = [];

  for (const it of store.bookItems(book)) {
    const row = {
      itemId: it.id, name: it.name, type: it.type, assignee: it.assigneeId ? store.user(it.assigneeId)?.name : null,
      status: it.status, submittedAt: it.submittedAt, included: false, source: null, snapshotId: null, hash: null, note: '',
    };
    let data = null;
    if (!it.assigneeId) { data = it.data; row.source = 'admin'; }
    else if (core.FINAL.has(it.status)) {
      if (mode === 'approved' && it.status !== 'approved') row.note = 'Chờ duyệt: không đưa vào';
      else {
        const v = core.verify(it);
        if (v.state !== 'ok') { row.source = 'tampered'; row.note = 'BỎ QUA: bài nộp không còn toàn vẹn'; }
        else { const sn = store.getSnapshot(it.submitSnapshotId); data = sn.data; row.snapshotId = sn.id; row.hash = sn.hash; row.source = it.status === 'approved' ? 'approved' : 'submitted'; }
      }
    } else if (mode === 'latest') { data = it.data; row.source = 'draft'; row.note = 'Bản nháp (chưa nộp)'; }
    else row.note = 'Chưa nộp: không đưa vào';
    if (data) {
      row.included = true;
      if (!row.hash) row.hash = store.sha(store.canon(data));
      if (!row.snapshotId) row.snapshotId = store.snapshotByHash(it.id, row.hash) || store.createSnapshot(it, 'consolidation', by, row.hash, null);
      included.push({ it, data });
    }
    const p = prevRows.get(it.id);
    row.changed = !!p && (p.hash !== row.hash || p.included !== row.included);
    row.isNew = !p && !!prev;
    rows.push(row);
  }

  const changed = rows.filter((r) => r.changed || r.isNew).length + [...prevRows.keys()].filter((id) => !rows.some((r) => r.itemId === id)).length;
  if (prev && !changed && prev.mode === mode) return { skipped: true, n: prev.n, id: prev.id };

  // tính lại công thức chéo workbook nhỏ bằng dữ liệu sẽ đưa vào file
  const xl = included.filter(({ it }) => it.type === 'excel'), wd = included.filter(({ it }) => it.type === 'word');
  const others = Object.fromEntries(xl.map(({ it, data }) => [it.name, data.cells]));
  const n = (prev ? prev.n : 0) + 1;
  const byName = by ? store.user(by)?.name || by : 'Tự động';
  const used = new Set();
  const uniq = (name) => { let s = safeName(name), k = 2; while (used.has(s.toLowerCase())) s = safeName(name).slice(0, 27) + '_' + k++; used.add(s.toLowerCase()); return s; };
  const parts = [{ name: uniq('Trạng thái nộp'), data: statusGrid(book, n, rows, mode, byName) }]
    .concat(xl.map(({ it, data }) => ({ name: uniq(it.name), data: materialize(data, it.name, others) })));

  const buf = await buildInWorker({ parts });
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const fileKey = store.putBlob(bookId, buf);
  let docx = null; // văn bản Word đã nộp được gom vào 1 file .docx riêng (mỗi văn bản là 1 mục)
  if (wd.length) {
    const html = `<h1>${esc(book.title)} - Tổng hợp văn bản (v${n})</h1>` + wd.map(({ it, data }) => {
      const who = it.assigneeId ? ' - ' + esc(store.user(it.assigneeId)?.name || '') : '';
      return `<h2>${esc(it.name)}${who}</h2>` + safeHtmlForDocx(data.html);
    }).join('<hr/>');
    const db = await buildInWorker({ kind: 'docx', html });
    docx = { fileKey: store.putBlob(bookId, db), sha: crypto.createHash('sha256').update(db).digest('hex'), size: db.length, count: wd.length };
  }
  const c = store.addConsolidation({
    bookId, by: by || null, mode, sha, size: buf.length, fileKey,
    manifest: { title: book.title, mode, items: rows, changed, sheets: parts.length, docx },
  });
  store.audit(by || null, 'consolidate', null, null, { book: bookId, n: c.n, sheets: parts.length, mode });
  core.bus.emit('consolidation', { bookId, c });
  return { skipped: false, n: c.n, id: c.id, sheets: parts.length, docs: wd.length };
}

module.exports = { consolidate };
