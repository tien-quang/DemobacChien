// So sánh 2 bản dữ liệu bảng tính, trả về danh sách ô đã đổi (ví dụ D5: 100 → 200).
// Dùng cho: admin xem user đã sửa những ô nào khi nộp bài (tab Tổng hợp > Chi tiết, và nút "Ô đã đổi" ở Tổng quan).
const { colName } = require('./refs');
const { canon } = require('./store');

const show = (c) => (!c ? '' : c.f ? '=' + c.f : c.v === undefined || c.v === null ? '' : String(c.v));
// Ô công thức mà công thức không đổi thì KHÔNG phải do user sửa (chỉ là kết quả tính đổi theo ô khác)
const sameValue = (x, y) => (x?.f || y?.f ? (x?.f || '') === (y?.f || '') : show(x) === show(y));

function diffCells(a = {}, b = {}, limit = 500) {
  const rows = [];
  let formatOnly = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (sameValue(x, y)) {
      if (canon((x && x.s) || null) !== canon((y && y.s) || null)) formatOnly++;
      continue;
    }
    const [r, c] = k.split(',').map(Number);
    const from = show(x), to = show(y);
    rows.push({ r, c, cell: colName(c) + (r + 1), from, to, change: from === '' ? 'added' : to === '' ? 'cleared' : 'edited' });
  }
  rows.sort((p, q) => p.r - q.r || p.c - q.c);
  return { total: rows.length, formatOnly, truncated: rows.length > limit, list: rows.slice(0, limit).map(({ cell, from, to, change }) => ({ cell, from, to, change })) };
}

// base, cur: dữ liệu của workbook nhỏ (excel: { cells }, word: { html })
function diffData(type, base, cur, limit) {
  if (type === 'word') {
    const same = (base?.html || '') === (cur?.html || '');
    return { total: same ? 0 : 1, formatOnly: 0, truncated: false, list: [], word: true };
  }
  return diffCells(base?.cells, cur?.cells, limit);
}

module.exports = { diffCells, diffData };
