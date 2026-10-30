// Bộ tính công thức phía server (dùng khi tổng hợp workbook lớn để giá trị trong file luôn đúng, không phụ thuộc Excel tính lại).
const FormulaParser = require('fast-formula-parser');

const { FormulaError } = FormulaParser;
const ERRORS = {
  '#DIV/0!': FormulaError.DIV0, '#N/A': FormulaError.NA, '#NAME?': FormulaError.NAME,
  '#NULL!': FormulaError.NULL, '#NUM!': FormulaError.NUM, '#REF!': FormulaError.REF, '#VALUE!': FormulaError.VALUE,
};
const isErrString = (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERRORS, v);
const key = (r, c) => r + ',' + c;

/* ---------- bộ tính công thức ---------- */
function makeEvaluator(sheetName, cells, others = {}) {
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
function materialize(data, sheetName, others) {
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


module.exports = { makeEvaluator, materialize };
