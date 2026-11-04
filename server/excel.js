// Đọc .xlsx thành các "part" (mỗi sheet 1 part) và xuất ngược lại thành 1 file .xlsx nguyên vẹn.
// Mô hình ô: cells["r,c"] = { v: giá trị, f: công thức (không có dấu =), s: style }
// s = { b, i, u, c (màu chữ #rrggbb), bg (màu nền), al (left|center|right), nf (định dạng số) }
const ExcelJS = require('exceljs');

const MAX_ROWS = 2000;
const MAX_COLS = 60;
const MAX_CELLS = 200000;
const MAX_OBJECTS = 500;

const argb = (c) => (c && typeof c.argb === 'string' && c.argb.length === 8 ? '#' + c.argb.slice(2).toLowerCase() : undefined);
const toSerial = (d) => d.getTime() / 86400000 + 25569;
const isDateFmt = (nf) => /[dmy]/i.test(String(nf || '').replace(/"[^"]*"|\\./g, '')) && !/^general$/i.test(nf);

function norm(x) {
  if (x == null) return undefined;
  if (x instanceof Date) return toSerial(x);
  if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') return x;
  if (Array.isArray(x.richText)) return x.richText.map((t) => t.text).join('');
  if (x.error) return String(x.error);
  if (x.text !== undefined) return norm(x.text);
  if (x.result !== undefined) return norm(x.result);
  return undefined;
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const parts = [];
  const warnings = [];
  wb.worksheets.forEach((ws) => {
    if (ws.state && ws.state !== 'visible') return; // bỏ sheet ẩn
    const cells = {};
    let maxR = 0, maxC = 0, count = 0;
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      if (rn > MAX_ROWS) return;
      row.eachCell({ includeEmpty: false }, (cell, cn) => {
        if (cn > MAX_COLS || count >= MAX_CELLS) return;
        const o = {};
        const isFormula = cell.type === ExcelJS.ValueType.Formula;
        if (isFormula) {
          const f = cell.formula;
          if (f) o.f = String(f).replace(/^=/, '');
          const v = norm(cell.result);
          if (v !== undefined) o.v = v;
        } else {
          const v = norm(cell.value);
          if (v !== undefined) o.v = v;
        }
        const s = {};
        const font = cell.font;
        if (font) {
          if (font.bold) s.b = 1;
          if (font.italic) s.i = 1;
          if (font.underline) s.u = 1;
          const c = argb(font.color);
          if (c && c !== '#000000') s.c = c;
        }
        const fill = cell.fill;
        if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
          const bg = argb(fill.fgColor);
          if (bg && bg !== '#ffffff') s.bg = bg;
        }
        const al = cell.alignment && cell.alignment.horizontal;
        if (['left', 'center', 'right'].includes(al)) s.al = al;
        if (cell.value instanceof Date && !isDateFmt(cell.numFmt)) s.nf = 'dd/mm/yyyy';
        else if (cell.numFmt && cell.numFmt !== 'General') s.nf = String(cell.numFmt);
        if (Object.keys(s).length) o.s = s;
        if (o.v === undefined && o.f === undefined && !o.s) return;
        cells[(rn - 1) + ',' + (cn - 1)] = o;
        count++;
        if (rn > maxR) maxR = rn;
        if (cn > maxC) maxC = cn;
      });
    });
    if (ws.rowCount > MAX_ROWS || ws.columnCount > MAX_COLS) {
      warnings.push(`Sheet "${ws.name}" bị cắt còn ${MAX_ROWS} dòng x ${MAX_COLS} cột`);
    }
    const colWidths = {};
    for (let c = 1; c <= maxC; c++) {
      const w = ws.getColumn(c).width;
      if (w) colWidths[c - 1] = Math.max(40, Math.min(400, Math.round(w * 7 + 5)));
    }
    parts.push({
      name: ws.name.slice(0, 60),
      data: { rows: Math.max(maxR, 1), cols: Math.max(maxC, 1), colWidths, cells },
    });
  });
  return { parts, warnings };
}

async function exportXlsx(doc) {
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true; // Excel tự tính lại công thức khi mở
  doc.parts.forEach((p) => {
    const ws = wb.addWorksheet(p.name.replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Sheet');
    const d = p.data;
    Object.entries(d.colWidths || {}).forEach(([c, px]) => { ws.getColumn(Number(c) + 1).width = Math.max(1, (px - 5) / 7); });
    Object.entries(d.cells || {}).forEach(([key, cell]) => {
      const [r, c] = key.split(',').map(Number);
      const x = ws.getCell(r + 1, c + 1);
      if (cell.f) x.value = { formula: cell.f, result: cell.v };
      else if (cell.v !== undefined) x.value = cell.v;
      const s = cell.s;
      if (s) {
        const font = {};
        if (s.b) font.bold = true;
        if (s.i) font.italic = true;
        if (s.u) font.underline = true;
        if (s.c) font.color = { argb: 'FF' + s.c.slice(1) };
        if (Object.keys(font).length) x.font = font;
        if (s.bg) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + s.bg.slice(1) } };
        if (s.al) x.alignment = { horizontal: s.al };
        if (s.nf) x.numFmt = s.nf;
      }
    });
  });
  return wb.xlsx.writeBuffer();
}

// ---------- kiểm tra dữ liệu client gửi lên (không tin client) ----------
const COLOR = /^#[0-9a-f]{6}$/i;
const KEY = /^\d{1,4},\d{1,3}$/;
function cleanCell(x) {
  if (!x || typeof x !== 'object') return null;
  const o = {};
  if (x.v !== undefined) {
    if (!['string', 'number', 'boolean'].includes(typeof x.v)) return null;
    if (typeof x.v === 'string' && x.v.length > 5000) return null;
    if (typeof x.v === 'number' && !Number.isFinite(x.v)) return null;
    o.v = x.v;
  }
  if (x.f !== undefined) {
    if (typeof x.f !== 'string' || x.f.length > 2000) return null;
    o.f = x.f;
  }
  if (x.s && typeof x.s === 'object') {
    const s = {};
    ['b', 'i', 'u'].forEach((n) => { if (x.s[n]) s[n] = 1; });
    ['c', 'bg'].forEach((n) => { if (typeof x.s[n] === 'string' && COLOR.test(x.s[n])) s[n] = x.s[n].toLowerCase(); });
    if (['left', 'center', 'right'].includes(x.s.al)) s.al = x.s.al;
    if (typeof x.s.nf === 'string' && x.s.nf.length <= 60) s.nf = x.s.nf;
    if (Object.keys(s).length) o.s = s;
  }
  return o.v !== undefined || o.f !== undefined || o.s ? o : {};
}
const keyOK = (k) => {
  if (!KEY.test(k)) return false;
  const [r, c] = k.split(',').map(Number);
  return r < 5000 && c < 200;
};
const cleanWidths = (w) => {
  const out = {};
  if (w && typeof w === 'object') for (const [k, v] of Object.entries(w)) if (/^\d{1,3}$/.test(k) && Number.isFinite(v)) out[k] = Math.max(30, Math.min(500, Math.round(v)));
  return out;
};
const cleanDim = (n, def) => (Number.isInteger(n) && n > 0 && n <= 5000 ? n : def);
const cleanObjects = (objects) => {
  if (!Array.isArray(objects) || objects.length > MAX_OBJECTS) return null;
  const allowed = new Set(['table', 'chart', 'shape', 'textbox', 'hyperlink', 'symbol', 'picture']);
  const out = [];
  for (const x of objects) {
    if (!x || typeof x !== 'object' || !allowed.has(x.type) || typeof x.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(x.id)) return null;
    if (!Number.isInteger(x.r) || !Number.isInteger(x.c) || x.r < 0 || x.r >= 5000 || x.c < 0 || x.c >= 200) return null;
    const o = { id: x.id, type: x.type, r: x.r, c: x.c, w: Math.max(60, Math.min(1200, Number(x.w) || 220)), h: Math.max(30, Math.min(800, Number(x.h) || 100)) };
    if (typeof x.title === 'string') o.title = x.title.slice(0, 200);
    if (typeof x.text === 'string') o.text = x.text.slice(0, 5000);
    if (typeof x.url === 'string' && /^https?:\/\//i.test(x.url)) o.url = x.url.slice(0, 1000);
    if (typeof x.symbol === 'string') o.symbol = x.symbol.slice(0, 8);
    if (typeof x.src === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(x.src) && x.src.length <= 1_500_000) o.src = x.src;
    if (x.color && COLOR.test(x.color)) o.color = x.color.toLowerCase();
    out.push(o);
  }
  return out;
};

function cleanGrid(d) {
  if (!d || typeof d !== 'object' || typeof d.cells !== 'object' || d.cells === null) return null;
  const keys = Object.keys(d.cells);
  if (keys.length > MAX_CELLS) return null;
  const cells = {};
  for (const k of keys) {
    if (!keyOK(k)) return null;
    const o = cleanCell(d.cells[k]);
    if (!o) return null;
    if (Object.keys(o).length) cells[k] = o;
  }
  return { rows: cleanDim(d.rows, 100), cols: cleanDim(d.cols, 26), colWidths: cleanWidths(d.colWidths), cells };
}

module.exports = { parseXlsx, exportXlsx, cleanGrid, cleanCell, keyOK, cleanWidths, cleanDim, cleanObjects, MAX_CELLS };
