import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { makeEvaluator, formatValue, parseInput, rawText, shiftFormula, key, colName, refName } from './formula.js';

const ROWH = 24, HEAD_H = 26, RN_W = 48, DEF_W = 96, BUF = 6;
const MARK = '[office-internal-clipboard]';
const INPUT_BG = '#fff6c8';
const FORMATS = [
  ['General', 'Chung'],
  ['#,##0', 'Số nguyên'],
  ['#,##0.00', 'Số 2 chữ số lẻ'],
  ['0.0%', 'Phần trăm'],
  ['#,##0 "₫"', 'Tiền Việt'],
  ['dd/mm/yyyy', 'Ngày'],
];
const FUNCTIONS = [
  ['SUM', 'Cộng'], ['AVERAGE', 'Trung bình'], ['MIN', 'Nhỏ nhất'], ['MAX', 'Lớn nhất'],
  ['COUNT', 'Đếm số'], ['COUNTA', 'Đếm ô có dữ liệu'], ['COUNTIF', 'Đếm theo điều kiện'],
  ['SUMIF', 'Cộng theo điều kiện'], ['AVERAGEIF', 'Trung bình theo điều kiện'],
  ['IF', 'Điều kiện'], ['IFS', 'Nhiều điều kiện'], ['IFERROR', 'Nếu lỗi'],
  ['AND', 'Và'], ['OR', 'Hoặc'], ['NOT', 'Phủ định'],
  ['VLOOKUP', 'Tra cứu dọc'], ['HLOOKUP', 'Tra cứu ngang'], ['INDEX', 'Vị trí'],
  ['MATCH', 'Tìm vị trí'], ['ROUND', 'Làm tròn'], ['ROUNDUP', 'Làm tròn lên'],
  ['ROUNDDOWN', 'Làm tròn xuống'], ['ABS', 'Giá trị tuyệt đối'], ['POWER', 'Lũy thừa'],
  ['SQRT', 'Căn bậc hai'], ['CONCATENATE', 'Nối chuỗi'], ['LEFT', 'Lấy bên trái'],
  ['RIGHT', 'Lấy bên phải'], ['MID', 'Lấy giữa'], ['LEN', 'Độ dài'],
  ['TRIM', 'Bỏ khoảng trắng'], ['UPPER', 'Viết hoa'], ['LOWER', 'Viết thường'],
  ['TODAY', 'Ngày hiện tại'], ['NOW', 'Ngày giờ hiện tại'], ['DATE', 'Tạo ngày'],
  ['YEAR', 'Lấy năm'], ['MONTH', 'Lấy tháng'], ['DAY', 'Lấy ngày'],
];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * Props chính:
 *  editable   : được sửa sheet này (theo quyền server)
 *  restricted : người dùng thường (bị chặn copy ra ngoài, bị giới hạn theo ô được bảo vệ)
 *  protect    : { on, cells } ô nào được phép nhập (khi on = true)
 *  remote     : con trỏ trực tiếp của người đang làm (admin xem)
 *  flash      : Set các ô vừa thay đổi (hiệu ứng nhấp nháy)
 *  protectUI  : công cụ bảo vệ ô dành cho admin
 */
export default function Spreadsheet({
  sheetName, data, others, editable, restricted, watermark, notice, protect, remote, flash, protectUI, onCursor, onBlocked, onChange,
}) {
  const cells = data.cells;
  const ev = useMemo(() => makeEvaluator(sheetName, cells, others), [sheetName, cells, others]);

  // ----- kích thước -----
  const dims = useMemo(() => {
    let R = 0, C = 0;
    for (const k in cells) { const [r, c] = k.split(','); if (+r > R) R = +r; if (+c > C) C = +c; }
    return { R, C };
  }, [cells]);
  const totalRows = Math.max(data.rows, 100, dims.R + 30);
  const totalCols = Math.min(200, Math.max(data.cols + 1, 14, dims.C + 2));
  const { widths, lefts, totalW } = useMemo(() => {
    const widths = Array.from({ length: totalCols }, (_, c) => data.colWidths?.[c] ?? DEF_W);
    const lefts = []; let x = 0;
    widths.forEach((w) => { lefts.push(x); x += w; });
    return { widths, lefts, totalW: x };
  }, [data.colWidths, totalCols]);

  // ----- trạng thái -----
  const [anchor, setAnchor] = useState({ r: 0, c: 0 });
  const [focus, setFocus] = useState({ r: 0, c: 0 });
  const [editing, setEditing] = useState(null); // { r, c, text, bar }
  const [view, setView] = useState({ top: 0, left: 0, w: 900, h: 600 });
  const wrapRef = useRef(null), scrollRef = useRef(null), bodyRef = useRef(null);
  const dragging = useRef(false);
  const undoS = useRef([]), redoS = useRef([]);
  const clip = useRef(null);
  const [, bump] = useState(0);
  const [formulaHelp, setFormulaHelp] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [findText, setFindText] = useState('');
  const [showFind, setShowFind] = useState(false);

  const sel = {
    r1: Math.min(anchor.r, focus.r), r2: Math.max(anchor.r, focus.r),
    c1: Math.min(anchor.c, focus.c), c2: Math.max(anchor.c, focus.c),
  };
  const active = anchor;
  const activeCell = cells[key(active.r, active.c)];

  // Ô này người dùng được phép sửa không? (khóa ô: chỉ ô được đánh dấu mới sửa được)
  const canCell = (r, c) => editable && (!restricted || !protect?.on || !!protect.cells[key(r, c)]);
  const blocked = () => onBlocked && onBlocked('Ô này đã bị quản trị viên khóa, bạn chỉ được nhập vào các ô màu vàng.');

  // ----- thay đổi dữ liệu (có undo/redo) -----
  const commit = useCallback((next) => {
    undoS.current.push(cells);
    if (undoS.current.length > 60) undoS.current.shift();
    redoS.current = [];
    onChange({ ...data, cells: next });
    bump((n) => n + 1);
  }, [cells, data, onChange]);
  const commitGrid = (next, rows = data.rows, cols = data.cols) => {
    undoS.current.push(cells);
    if (undoS.current.length > 60) undoS.current.shift();
    redoS.current = [];
    onChange({ ...data, rows: Math.max(1, rows), cols: Math.max(1, cols), cells: next });
    bump((n) => n + 1);
  };
  const doUndo = () => {
    if (!editable || !undoS.current.length) return;
    redoS.current.push(cells);
    onChange({ ...data, cells: undoS.current.pop() });
    bump((n) => n + 1);
  };
  const doRedo = () => {
    if (!editable || !redoS.current.length) return;
    undoS.current.push(cells);
    onChange({ ...data, cells: redoS.current.pop() });
    bump((n) => n + 1);
  };

  const ensureVisible = (r, c) => {
    const el = scrollRef.current; if (!el) return;
    const top = r * ROWH, bottom = top + ROWH, vh = el.clientHeight - HEAD_H;
    if (top < el.scrollTop) el.scrollTop = top; else if (bottom > el.scrollTop + vh) el.scrollTop = bottom - vh;
    const left = lefts[c], right = left + widths[c], vw = el.clientWidth - RN_W;
    if (left < el.scrollLeft) el.scrollLeft = left; else if (right > el.scrollLeft + vw) el.scrollLeft = right - vw;
  };
  const moveTo = (r, c, extend) => {
    r = clamp(r, 0, totalRows - 1); c = clamp(c, 0, totalCols - 1);
    if (extend) setFocus({ r, c }); else { setAnchor({ r, c }); setFocus({ r, c }); }
    ensureVisible(r, c);
  };

  // gửi vị trí con trỏ + nội dung đang gõ dở (để admin theo dõi trực tiếp)
  useEffect(() => {
    if (onCursor) onCursor({ r: active.r, c: active.c, typing: editing ? editing.text : null });
  }, [active.r, active.c, editing?.text]); // eslint-disable-line

  // ----- sửa ô -----
  const startEdit = (text) => {
    if (!editable) return;
    if (!canCell(active.r, active.c)) { blocked(); return; }
    setEditing({ r: active.r, c: active.c, text });
  };
  const finishEdit = (text, dr = 0, dc = 0) => {
    const { r, c } = editing;
    setEditing(null);
    const old = cells[key(r, c)] || {};
    if (rawText(old) !== text) {
      const p = parseInput(text);
      const cell = {};
      if (old.s) cell.s = old.s;
      if (p.f !== undefined) cell.f = p.f; else if (p.v !== undefined) cell.v = p.v;
      if (p.nf && !cell.s?.nf) cell.s = { ...(cell.s || {}), nf: p.nf };
      const next = { ...cells };
      if (cell.v === undefined && cell.f === undefined && !cell.s) delete next[key(r, c)]; else next[key(r, c)] = cell;
      commit(next);
    }
    if (dr || dc) moveTo(r + dr, c + dc); else wrapRef.current?.focus();
  };
  const cancelEdit = () => { setEditing(null); wrapRef.current?.focus(); };

  // ----- định dạng -----
  const eachSel = (fn) => { for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) fn(r, c); };
  const applyStyle = (patch) => {
    if (!editable) return;
    if (editing) finishEdit(editing.text);
    const next = { ...cells };
    let skipped = 0;
    eachSel((r, c) => {
      if (!canCell(r, c)) { skipped++; return; }
      const k = key(r, c), old = next[k] || {};
      const s = { ...(old.s || {}), ...patch };
      Object.keys(s).forEach((n) => { if (!s[n]) delete s[n]; });
      const cell = { ...old };
      if (Object.keys(s).length) cell.s = s; else delete cell.s;
      if (cell.v === undefined && cell.f === undefined && !cell.s) delete next[k]; else next[k] = cell;
    });
    if (skipped) blocked();
    commit(next);
    wrapRef.current?.focus();
  };
  const toggle = (p) => applyStyle({ [p]: activeCell?.s?.[p] ? 0 : 1 });
  const clearSel = () => {
    if (!editable) return;
    const next = { ...cells };
    let skipped = 0;
    eachSel((r, c) => {
      if (!canCell(r, c)) { skipped++; return; }
      const k = key(r, c), old = next[k];
      if (!old) return;
      const cell = { ...old }; delete cell.v; delete cell.f;
      if (cell.s) next[k] = cell; else delete next[k];
    });
    if (skipped) blocked();
    commit(next);
  };
  const shiftSelection = (dr, dc) => {
    if (!editable) return;
    const next = {};
    for (const [k, cell] of Object.entries(cells)) {
      const [oldR, oldC] = k.split(',').map(Number);
      let r = oldR, c = oldC;
      if (dr > 0 && r >= sel.r1) r += 1;
      else if (dr < 0 && r > sel.r1) r -= 1;
      else if (dr < 0 && r === sel.r1) continue;
      if (dc > 0 && c >= sel.c1) c += 1;
      else if (dc < 0 && c > sel.c1) c -= 1;
      else if (dc < 0 && c === sel.c1) continue;
      if (r >= 0 && c >= 0 && r < totalRows && c < totalCols) {
        const moved = r !== oldR || c !== oldC;
        next[key(r, c)] = moved && cell.f ? { ...cell, f: shiftFormula(cell.f, r - oldR, c - oldC) } : cell;
      }
    }
    commitGrid(next, data.rows + (dr > 0 ? 1 : dr < 0 ? -1 : 0), data.cols + (dc > 0 ? 1 : dc < 0 ? -1 : 0));
  };
  const resizeSelectedColumns = () => {
    if (!editable) return;
    const width = Number(window.prompt('Độ rộng cột (px)', String(widths[sel.c1]))) || widths[sel.c1];
    const colWidths = { ...(data.colWidths || {}) };
    for (let c = sel.c1; c <= sel.c2; c++) colWidths[c] = clamp(width, 40, 500);
    onChange({ ...data, colWidths });
  };
  const printSheet = () => window.print();
  const cellMatches = (text) => findText && String(text).toLocaleLowerCase().includes(findText.toLocaleLowerCase());
  const insertFunction = (name) => {
    if (!activeOK) return;
    setEditing({ r: active.r, c: active.c, text: `=${name}()` });
    wrapRef.current?.focus();
  };

  // ----- clipboard: user không thể copy dữ liệu ra ngoài ứng dụng -----
  const onCopy = (e, cut) => {
    if (editing) return;
    e.preventDefault();
    if (cut && !editable) return;
    const rows = [];
    for (let r = sel.r1; r <= sel.r2; r++) {
      const row = [];
      for (let c = sel.c1; c <= sel.c2; c++) row.push(cells[key(r, c)] ? JSON.parse(JSON.stringify(cells[key(r, c)])) : null);
      rows.push(row);
    }
    let text = MARK;
    if (!restricted) {
      const lines = [];
      for (let r = sel.r1; r <= sel.r2; r++) {
        const row = [];
        for (let c = sel.c1; c <= sel.c2; c++) row.push(formatValue(ev.valueAt(r, c), cells[key(r, c)]?.s?.nf));
        lines.push(row.join('\t'));
      }
      text = lines.join('\n');
    }
    clip.current = { rows, r1: sel.r1, c1: sel.c1, text };
    e.clipboardData.setData('text/plain', text);
    if (cut) clearSel();
  };
  const onPaste = (e) => {
    if (editing || !editable) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    const next = { ...cells };
    let h = 0, w = 0, skipped = 0;
    if (clip.current && clip.current.text === text) {
      const { rows, r1, c1 } = clip.current;
      rows.forEach((row, i) => row.forEach((cell, j) => {
        const tr = active.r + i, tc = active.c + j, k = key(tr, tc);
        if (!canCell(tr, tc)) { skipped++; return; }
        if (!cell) { delete next[k]; return; }
        const n = { ...cell };
        if (n.f) n.f = shiftFormula(n.f, active.r - r1, active.c - c1);
        next[k] = n;
      }));
      h = rows.length; w = rows[0]?.length || 0;
    } else if (text) {
      const rows = text.replace(/\r/g, '').split('\n');
      if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
      rows.forEach((line, i) => line.split('\t').forEach((t, j) => {
        const tr = active.r + i, tc = active.c + j, k = key(tr, tc);
        w = Math.max(w, j + 1);
        if (!canCell(tr, tc)) { skipped++; return; }
        const old = next[k] || {}, p = parseInput(t), cell = {};
        if (old.s) cell.s = old.s;
        if (p.f !== undefined) cell.f = p.f; else if (p.v !== undefined) cell.v = p.v;
        if (cell.v === undefined && cell.f === undefined && !cell.s) delete next[k]; else next[k] = cell;
      }));
      h = rows.length;
    }
    if (!h) return;
    if (skipped) blocked();
    commit(next);
    setFocus({ r: clamp(active.r + h - 1, 0, totalRows - 1), c: clamp(active.c + w - 1, 0, totalCols - 1) });
  };

  // ----- bàn phím -----
  const onKeyDown = (e) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
      else if (k === 'y') { e.preventDefault(); doRedo(); }
      else if (k === 'a') { e.preventDefault(); setAnchor({ r: 0, c: 0 }); setFocus({ r: totalRows - 1, c: totalCols - 1 }); }
      else if (editable && ['b', 'i', 'u'].includes(k)) { e.preventDefault(); toggle(k); }
      return; // Ctrl+C/X/V được xử lý bằng sự kiện copy/cut/paste
    }
    const f = e.shiftKey ? focus : active;
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); moveTo(f.r - 1, f.c, e.shiftKey); break;
      case 'ArrowDown': e.preventDefault(); moveTo(f.r + 1, f.c, e.shiftKey); break;
      case 'ArrowLeft': e.preventDefault(); moveTo(f.r, f.c - 1, e.shiftKey); break;
      case 'ArrowRight': e.preventDefault(); moveTo(f.r, f.c + 1, e.shiftKey); break;
      case 'PageDown': e.preventDefault(); moveTo(f.r + 15, f.c, e.shiftKey); break;
      case 'PageUp': e.preventDefault(); moveTo(f.r - 15, f.c, e.shiftKey); break;
      case 'Home': e.preventDefault(); moveTo(f.r, 0, e.shiftKey); break;
      case 'Tab': e.preventDefault(); moveTo(active.r, active.c + (e.shiftKey ? -1 : 1)); break;
      case 'Enter': case 'F2': e.preventDefault(); startEdit(rawText(activeCell)); break;
      case 'Delete': case 'Backspace': e.preventDefault(); clearSel(); break;
      default:
        if (e.key.length === 1 && !e.altKey && editable) { e.preventDefault(); startEdit(e.key); }
    }
  };
  const onEditKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finishEdit(editing.text, e.shiftKey ? -1 : 1, 0); }
    else if (e.key === 'Tab') { e.preventDefault(); finishEdit(editing.text, 0, e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  };

  // ----- chuột -----
  const hit = (cx, cy) => {
    const rect = bodyRef.current.getBoundingClientRect();
    const x = cx - rect.left - RN_W, y = cy - rect.top - HEAD_H;
    let c = totalCols - 1;
    for (let i = 0; i < totalCols; i++) if (x < lefts[i] + widths[i]) { c = i; break; }
    return { r: clamp(Math.floor(y / ROWH), 0, totalRows - 1), c: x < 0 ? 0 : c, header: y < 0, rowHeader: x < 0 };
  };
  const hitRef = useRef(hit); hitRef.current = hit;
  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (editing) finishEdit(editing.text);
    wrapRef.current?.focus();
    const h = hit(e.clientX, e.clientY);
    if (h.header) { setAnchor({ r: 0, c: h.c }); setFocus({ r: totalRows - 1, c: h.c }); return; }
    if (h.rowHeader) { setAnchor({ r: h.r, c: 0 }); setFocus({ r: h.r, c: totalCols - 1 }); return; }
    if (e.shiftKey) setFocus({ r: h.r, c: h.c }); else { setAnchor({ r: h.r, c: h.c }); setFocus({ r: h.r, c: h.c }); }
    dragging.current = true;
  };
  useEffect(() => {
    const move = (e) => { if (dragging.current) { const h = hitRef.current(e.clientX, e.clientY); setFocus({ r: h.r, c: h.c }); } };
    const up = () => { dragging.current = false; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  // ----- cuộn / kích thước vùng nhìn -----
  const syncView = useCallback(() => {
    const el = scrollRef.current; if (!el) return;
    setView({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight });
  }, []);
  useEffect(() => {
    syncView();
    const ro = new ResizeObserver(syncView);
    ro.observe(scrollRef.current);
    return () => ro.disconnect();
  }, [syncView]);

  // ----- vẽ -----
  const firstRow = Math.max(0, Math.floor(view.top / ROWH) - BUF);
  const lastRowV = Math.min(totalRows - 1, Math.ceil((view.top + view.h) / ROWH) + BUF);
  const visCols = [];
  for (let c = 0; c < totalCols; c++) {
    if (lefts[c] + widths[c] < view.left - 150 || lefts[c] > view.left + view.w + 150) continue;
    visCols.push(c);
  }
  const showInput = !!(protect?.on);
  const rowsOut = [];
  for (let r = firstRow; r <= lastRowV; r++) {
    rowsOut.push(
      <div className="srow" key={r} style={{ top: HEAD_H + r * ROWH, height: ROWH, width: RN_W + totalW }}>
        <div className={'rn' + (r >= sel.r1 && r <= sel.r2 ? ' on' : '')}>{r + 1}</div>
        {visCols.map((c) => {
          const k = key(r, c);
          const cell = cells[k];
          const isInput = showInput && !!protect.cells[k];
          const fl = flash && flash.has(k) ? ' flash' : '';
          if (!cell) return <div className={'cell' + fl} key={c} style={{ left: RN_W + lefts[c], width: widths[c], background: isInput ? INPUT_BG : undefined }} />;
          const s = cell.s || {};
          const v = ev.valueAt(r, c);
          const text = formatValue(v, s.nf);
          const isErr = typeof v === 'string' && /^#[A-Z0\/]+[!?]?$/.test(v);
          return (
            <div
              className={'cell' + (isErr ? ' err' : '') + (cellMatches(text) ? ' findmatch' : '') + fl}
              key={c}
              style={{
                left: RN_W + lefts[c], width: widths[c],
                fontWeight: s.b ? 700 : undefined, fontStyle: s.i ? 'italic' : undefined,
                textDecoration: s.u ? 'underline' : undefined, color: s.c, background: s.bg || (isInput ? INPUT_BG : undefined),
                textAlign: s.al || (isErr ? 'center' : typeof v === 'number' ? 'right' : 'left'),
              }}
            >{text}</div>
          );
        })}
      </div>
    );
  }
  const rect = (r1, r2, c1, c2) => ({
    left: RN_W + lefts[c1], top: HEAD_H + r1 * ROWH,
    width: lefts[c2] + widths[c2] - lefts[c1], height: (r2 - r1 + 1) * ROWH,
  });
  const multi = sel.r1 !== sel.r2 || sel.c1 !== sel.c2;

  let stats = null;
  if (multi && (sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1) <= 20000) {
    let n = 0, sum = 0, cnt = 0;
    eachSel((r, c) => {
      const v = ev.valueAt(r, c);
      if (v !== '' && v != null) cnt++;
      if (typeof v === 'number') { n++; sum += v; }
    });
    if (n) stats = `Tổng: ${formatValue(sum, '#,##0.##')}   Trung bình: ${formatValue(sum / n, '#,##0.##')}   Đếm: ${cnt}`;
  }

  const selKeys = () => {
    const ks = [];
    eachSel((r, c) => ks.push(key(r, c)));
    return ks;
  };
  const nameBox = multi ? `${refName(sel.r1, sel.c1)}:${refName(sel.r2, sel.c2)}` : refName(active.r, active.c);
  const barText = editing ? editing.text : rawText(activeCell);
  const activeOK = canCell(active.r, active.c);
  const dis = !activeOK;
  const s = activeCell?.s || {};
  const rm = remote && remote.r < totalRows && remote.c < totalCols ? remote : null;

  return (
    <div className="sheet">
      <div className="office-window excel-window">
        <div className="office-brand"><b>Excel</b><span>·</span><strong>{sheetName}</strong></div>
        <div className="office-quick"><button title="Lưu">💾</button><button title="Hoàn tác" onClick={doUndo}>↶</button><button title="Làm lại" onClick={doRedo}>↷</button></div>
        <div className="office-window-actions"><button>−</button><button>□</button><button>×</button></div>
      </div>
      <div className="office-tabs">
        <button className="active">Home</button><button>Insert</button><button>Page Layout</button><button>Formulas</button><button>Data</button><button>Review</button><button>View</button><span className="office-search">⌕ <span>Tell me what you want to do</span></span>
      </div>
      <div className="ribbon" onMouseDown={(e) => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') e.preventDefault(); }}>
        <button disabled={!editable || !undoS.current.length} onClick={doUndo} title="Hoàn tác (Ctrl+Z)">Hoàn tác</button>
        <button disabled={!editable || !redoS.current.length} onClick={doRedo} title="Làm lại (Ctrl+Y)">Làm lại</button>
        <span className="ribbon-group-label">Clipboard</span><span className="sep" />
        <button disabled={dis} className={s.b ? 'on' : ''} onClick={() => toggle('b')} title="Đậm (Ctrl+B)"><b>B</b></button>
        <button disabled={dis} className={s.i ? 'on' : ''} onClick={() => toggle('i')} title="Nghiêng (Ctrl+I)"><i>I</i></button>
        <button disabled={dis} className={s.u ? 'on' : ''} onClick={() => toggle('u')} title="Gạch chân (Ctrl+U)"><u>U</u></button>
        <label className="color" title="Màu chữ">A
          <input type="color" disabled={dis} value={s.c || '#000000'} onChange={(e) => applyStyle({ c: e.target.value })} />
        </label>
        <label className="color" title="Màu nền ô">Nền
          <input type="color" disabled={dis} value={s.bg || '#ffffff'} onChange={(e) => applyStyle({ bg: e.target.value })} />
        </label>
        <span className="sep" />
        {['left', 'center', 'right'].map((a) => (
          <button key={a} disabled={dis} className={s.al === a ? 'on' : ''} onClick={() => applyStyle({ al: s.al === a ? 0 : a })}
            title={'Căn ' + { left: 'trái', center: 'giữa', right: 'phải' }[a]}>{{ left: 'Trái', center: 'Giữa', right: 'Phải' }[a]}</button>
        ))}
        <select disabled={dis} value={s.nf && FORMATS.some((f) => f[0] === s.nf) ? s.nf : 'General'}
          onChange={(e) => applyStyle({ nf: e.target.value === 'General' ? 0 : e.target.value })} title="Định dạng số">
          {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select disabled={dis} value="" onChange={(e) => e.target.value && insertFunction(e.target.value)} title="Chèn hàm Excel">
          <option value="">Hàm Excel…</option>
          {FUNCTIONS.map(([name, label]) => <option key={name} value={name}>{name} — {label}</option>)}
        </select>
        <button disabled={!editable} onClick={() => setFormulaHelp((v) => !v)} title="Danh sách hàm được hỗ trợ">fx {formulaHelp ? 'Ẩn' : 'Hàm'}</button>
        <button disabled={!editable} onClick={() => shiftSelection(1, 0)} title="Chèn dòng phía trên">+ Dòng</button>
        <button disabled={!editable} onClick={() => shiftSelection(-1, 0)} title="Xóa dòng đang chọn">− Dòng</button>
        <button disabled={!editable} onClick={() => shiftSelection(0, 1)} title="Chèn cột bên trái">+ Cột</button>
        <button disabled={!editable} onClick={() => shiftSelection(0, -1)} title="Xóa cột đang chọn">− Cột</button>
        <button disabled={!editable} onClick={resizeSelectedColumns} title="Đổi độ rộng cột">Độ rộng</button>
        <button onClick={printSheet} title="In bảng tính">In</button>
        <button onClick={() => setShowFind((v) => !v)} title="Tìm trong bảng tính">Tìm</button>
        <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))} title="Thu phóng">
          {[75, 90, 100, 110, 125, 150].map((n) => <option key={n} value={n}>{n}%</option>)}
        </select>
        {protectUI && (
          <>
            <span className="sep" />
            <label className="protect-toggle" title="Khi bật, người được giao chỉ nhập được vào các ô màu vàng">
              <input type="checkbox" checked={!!protectUI.on} onChange={(e) => protectUI.onToggle(e.target.checked)} /> Bảo vệ ô
            </label>
            <button onClick={() => protectUI.onAllow(selKeys())} title="Cho phép người được giao nhập vào các ô đang chọn">Cho phép nhập</button>
            <button onClick={() => protectUI.onDeny(selKeys())} title="Khóa lại các ô đang chọn">Khóa ô</button>
          </>
        )}
        {notice && <span className="notice">{notice}</span>}
      </div>
      {formulaHelp && <div className="formula-help">
        <b>Hàm Excel được hỗ trợ</b>
        <span>{FUNCTIONS.map(([name]) => name).join(' · ')}</span>
        <small>Thư viện tính toán cũng hỗ trợ thêm các nhóm toán học, thống kê, ngày giờ, logic, chuỗi, kỹ thuật và tra cứu. Nhập công thức bắt đầu bằng dấu =.</small>
      </div>}
      {showFind && <div className="sheet-find">
        <input autoFocus value={findText} onChange={(e) => setFindText(e.target.value)} placeholder="Tìm nội dung trong bảng…" />
        <button onClick={() => { setFindText(''); setShowFind(false); }}>Đóng</button>
      </div>}

      <div className="fbar">
        <div className="namebox">{nameBox}</div>
        <span className="fx">fx</span>
        <input
          value={barText}
          readOnly={!activeOK}
          onFocus={() => { if (activeOK && !editing) setEditing({ r: active.r, c: active.c, text: rawText(activeCell), bar: true }); }}
          onChange={(e) => setEditing((x) => (x ? { ...x, text: e.target.value } : x))}
          onKeyDown={(e) => { if (editing?.bar) onEditKey(e); }}
        />
      </div>

      <div className="gridwrap" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown}
        onCopy={(e) => onCopy(e, false)} onCut={(e) => onCopy(e, true)} onPaste={onPaste}
        onContextMenu={(e) => { if (restricted) e.preventDefault(); }} onDragStart={(e) => e.preventDefault()}>
        <div className="gscroll" ref={scrollRef} onScroll={syncView} style={{ zoom: zoom / 100 }}>
          <div className="gbody" ref={bodyRef} style={{ width: RN_W + totalW, height: HEAD_H + totalRows * ROWH }}
            onMouseDown={onMouseDown} onDoubleClick={() => startEdit(rawText(activeCell))}>
            <div className="shead" style={{ width: RN_W + totalW, height: HEAD_H }}>
              <div className="corner" />
              {visCols.map((c) => (
                <div key={c} className={'ch' + (c >= sel.c1 && c <= sel.c2 ? ' on' : '')} style={{ left: RN_W + lefts[c], width: widths[c] }}>{colName(c)}</div>
              ))}
            </div>
            {rowsOut}
            {multi && <div className="selrange" style={rect(sel.r1, sel.r2, sel.c1, sel.c2)} />}
            <div className="activecell" style={rect(active.r, active.r, active.c, active.c)} />
            {rm && (
              <div className="remote" style={rect(rm.r, rm.r, rm.c, rm.c)}>
                <span className="rlabel">{rm.by}{rm.typing != null && rm.typing !== '' ? ': ' + rm.typing : ''}</span>
              </div>
            )}
            {editing && (
              <input
                className="celledit"
                style={rect(editing.r, editing.r, editing.c, editing.c)}
                value={editing.text}
                autoFocus={!editing.bar}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                onKeyDown={onEditKey}
                onMouseDown={(e) => e.stopPropagation()}
              />
            )}
          </div>
        </div>
        {watermark && <Watermark text={watermark} />}
      </div>
      <div className="statusbar"><span>{stats || (editable ? (showInput && restricted ? 'Chỉ nhập vào các ô màu vàng' : 'Sẵn sàng') : 'Chỉ xem')}</span><span>{totalRows} dòng</span></div>
    </div>
  );
}

export function Watermark({ text }) {
  const t = String(text).replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="200"><text x="20" y="120" transform="rotate(-24 190 100)" font-size="14" font-family="sans-serif" fill="rgba(20,30,45,0.12)">${t}</text></svg>`;
  return <div className="watermark" style={{ backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")` }} />;
}
