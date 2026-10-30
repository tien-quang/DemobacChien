// So sánh 2 phiên bản dữ liệu bảng tính, chỉ gửi các ô đã thay đổi (các ô không đổi giữ nguyên tham chiếu đối tượng).
export function diffGrid(prev, next) {
  const patch = {};
  let n = 0;
  for (const k in next.cells) if (prev.cells[k] !== next.cells[k]) { patch[k] = next.cells[k]; n++; }
  for (const k in prev.cells) if (!(k in next.cells)) { patch[k] = null; n++; }
  const out = {};
  if (n) out.patch = patch;
  if (prev.rows !== next.rows || prev.cols !== next.cols) out.dims = { rows: next.rows, cols: next.cols };
  const widths = {};
  for (const k in next.colWidths || {}) if ((prev.colWidths || {})[k] !== next.colWidths[k]) widths[k] = next.colWidths[k];
  if (Object.keys(widths).length) out.widths = widths;
  return n || out.dims || out.widths ? out : null;
}

export function applyPatch(data, msg) {
  const out = { ...data };
  if (msg.patch) {
    const cells = { ...data.cells };
    for (const [k, v] of Object.entries(msg.patch)) { if (v === null) delete cells[k]; else cells[k] = v; }
    out.cells = cells;
  }
  if (msg.dims) { out.rows = msg.dims.rows; out.cols = msg.dims.cols; }
  if (msg.widths) out.colWidths = { ...data.colWidths, ...msg.widths };
  return out;
}
