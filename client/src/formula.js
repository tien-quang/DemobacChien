// Tính công thức + định dạng hiển thị. Chạy hoàn toàn trên dữ liệu client ĐƯỢC PHÉP thấy:
// user chỉ có dữ liệu sheet của mình, công thức trỏ sang sheet khác sẽ dùng giá trị đã lưu sẵn.
import FormulaParser from 'fast-formula-parser';

const { FormulaError } = FormulaParser;
const ERRORS = {
  '#DIV/0!': FormulaError.DIV0, '#N/A': FormulaError.NA, '#NAME?': FormulaError.NAME,
  '#NULL!': FormulaError.NULL, '#NUM!': FormulaError.NUM, '#REF!': FormulaError.REF, '#VALUE!': FormulaError.VALUE,
};
const isErrString = (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERRORS, v);

export const colName = (i) => {
  let s = ''; i++;
  while (i > 0) { s = String.fromCharCode(65 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); }
  return s;
};
export const colIndex = (s) => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
export const key = (r, c) => r + ',' + c;
export const refName = (r, c) => colName(c) + (r + 1);

/* ---------- bộ tính công thức ---------- */
export function makeEvaluator(sheetName, cells, others = {}) {
  const cache = new Map();
  const visiting = new Set();
  const stack = [];
  const parsers = [];
  const dims = new Map();
  const mapOf = (n) => (n === sheetName ? cells : others[n]);
  const dimsOf = (n) => {
    if (!dims.has(n)) {
      let R = 0, C = 0;
      for (const k in mapOf(n)) { const [r, c] = k.split(','); if (+r > R) R = +r; if (+c > C) C = +c; }
      dims.set(n, [R, C]);
    }
    return dims.get(n);
  };

  function parserAt(i) {
    if (!parsers[i]) {
      parsers[i] = new FormulaParser({
        onCell: (ref) => raw(ref.sheet || stack[i], ref.row - 1, ref.col - 1),
        onRange: (ref) => {
          const n = ref.sheet || stack[i];
          if (!mapOf(n)) throw new Error('unavailable');
          const [R, C] = dimsOf(n);
          const out = [];
          for (let r = ref.from.row - 1; r <= Math.min(ref.to.row - 1, R); r++) {
            const row = [];
            for (let c = ref.from.col - 1; c <= Math.min(ref.to.col - 1, C); c++) row.push(raw(n, r, c));
            out.push(row);
          }
          return out.length ? out : [[null]];
        },
      });
    }
    return parsers[i];
  }

  const errText = (e) => (e && (e._error || String(e))) || '#VALUE!';

  function evalCell(sheet, r, c, cell) {
    const k = sheet + '!' + r + ',' + c;
    if (cache.has(k)) return cache.get(k);
    if (visiting.has(k) || stack.length > 40) return FormulaError.REF;
    visiting.add(k);
    stack.push(sheet);
    let out;
    try {
      let res = parserAt(stack.length - 1).parse(cell.f, { sheet, row: r + 1, col: c + 1 });
      if (Array.isArray(res)) res = res[0]?.[0];
      out = res instanceof FormulaError ? errText(res) : res ?? '';
    } catch (e) {
      // công thức không tính được (hàm chưa hỗ trợ / trỏ sang sheet không có quyền): dùng giá trị đã lưu
      out = cell.v !== undefined ? cell.v : errText(e.details || e);
    } finally {
      stack.pop();
      visiting.delete(k);
    }
    cache.set(k, out);
    return out;
  }

  function raw(sheet, r, c) {
    const m = mapOf(sheet);
    if (!m) throw new Error('unavailable');
    const cell = m[key(r, c)];
    if (!cell) return null;
    const v = cell.f ? evalCell(sheet, r, c, cell) : cell.v;
    if (v === undefined) return null;
    return isErrString(v) ? ERRORS[v] : v;
  }

  return {
    valueAt(r, c) {
      const cell = cells[key(r, c)];
      if (!cell) return '';
      if (!cell.f) return cell.v ?? '';
      const v = evalCell(sheetName, r, c, cell);
      return v ?? '';
    },
  };
}

// Điền sẵn giá trị tính được vào các ô công thức trước khi lưu (để xuất Excel/tham chiếu chéo luôn có số liệu)
export function materialize(data, sheetName, others) {
  const ev = makeEvaluator(sheetName, data.cells, others);
  const cells = {};
  for (const [k, cell] of Object.entries(data.cells)) {
    if (cell.f) {
      const [r, c] = k.split(',').map(Number);
      const v = ev.valueAt(r, c);
      cells[k] = { ...cell, v: typeof v === 'object' ? String(v) : v };
    } else cells[k] = cell;
  }
  return { ...data, cells };
}

/* ---------- nhập liệu ---------- */
export function parseInput(text) {
  if (text === '') return {};
  if (text[0] === '=' && text.length > 1) return { f: text.slice(1) };
  const t = text.trim();
  if (/^[-+]?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(t)) return { v: Number(t) };
  if (/^[-+]?\d+(\.\d+)?%$/.test(t)) return { v: Number(t.slice(0, -1)) / 100, nf: t.includes('.') ? '0.00%' : '0%' };
  if (/^(true|false)$/i.test(t)) return { v: t.toLowerCase() === 'true' };
  return { v: text };
}

export const rawText = (cell) => (!cell ? '' : cell.f ? '=' + cell.f : cell.v === undefined ? '' : String(cell.v));

// Dịch tham chiếu tương đối khi dán công thức sang ô khác
export function shiftFormula(f, dr, dc) {
  return f.replace(/(^|[^A-Za-z0-9_."'])(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![\dA-Za-z_(])/g, (m, pre, ca, col, ra, row) => {
    const c = ca ? col : colName(Math.max(0, colIndex(col) + dc));
    const r = ra ? row : String(Math.max(1, Number(row) + dr));
    return pre + ca + c + ra + r;
  });
}

/* ---------- hiển thị ---------- */
const isDateFmt = (nf) => /[dmy]/i.test(String(nf).replace(/"[^"]*"|\\./g, '')) && !/^general$/i.test(nf);
const pad = (n) => String(n).padStart(2, '0');

function fmtDate(v, nf) {
  const d = new Date(Math.round((v - 25569) * 86400000));
  if (isNaN(d)) return String(v);
  const M = ['Th1', 'Th2', 'Th3', 'Th4', 'Th5', 'Th6', 'Th7', 'Th8', 'Th9', 'Th10', 'Th11', 'Th12'];
  return nf.replace(/"[^"]*"/g, '').replace(/yyyy|yy|mmm|mm|m|dd|d|hh|h|ss/gi, (t) => {
    switch (t.toLowerCase()) {
      case 'yyyy': return d.getUTCFullYear();
      case 'yy': return String(d.getUTCFullYear()).slice(-2);
      case 'mmm': return M[d.getUTCMonth()];
      case 'mm': return pad(d.getUTCMonth() + 1);
      case 'm': return d.getUTCMonth() + 1;
      case 'dd': return pad(d.getUTCDate());
      case 'd': return d.getUTCDate();
      case 'hh': case 'h': return pad(d.getUTCHours());
      case 'ss': return pad(d.getUTCSeconds());
      default: return t;
    }
  });
}

function fmtNumber(v, nf) {
  const clean = nf.split(';')[0].replace(/\[[^\]]*\]/g, '').replace(/_./g, '').replace(/\*./g, '');
  const m = clean.match(/[#0?,.]+/);
  if (!m) return String(v);
  const body = m[0];
  const prefix = clean.slice(0, m.index).replace(/["\\]/g, '');
  const suffix = clean.slice(m.index + body.length).replace(/["\\]/g, '');
  const frac = body.split('.')[1] || '';
  const x = clean.includes('%') ? v * 100 : v;
  const s = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: (frac.match(/0/g) || []).length,
    maximumFractionDigits: frac.replace(/[^0#]/g, '').length,
    useGrouping: body.includes(','),
  }).format(x);
  return prefix + s + suffix;
}

export function formatValue(v, nf) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return '#NUM!';
  if (nf && !/^general$/i.test(nf)) return isDateFmt(nf) ? fmtDate(v, nf) : fmtNumber(v, nf);
  return String(Math.round(v * 1e10) / 1e10);
}
