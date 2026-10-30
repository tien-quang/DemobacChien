// Dữ liệu mẫu: 2 workbook lớn (Tính lương, Tính tiền nợ), mỗi cái chứa nhiều workbook nhỏ + 1 sheet tổng hợp của admin.
const ACCENT = '#1d6f42';
const HEAD = (c, right) => ({ b: 1, c: '#ffffff', bg: ACCENT, al: right ? 'right' : 'left' });
const NAMES = ['Nguyễn Văn An', 'Trần Thị Bình', 'Lê Hoàng Cường', 'Phạm Thu Dung', 'Võ Minh Đức', 'Đặng Ngọc Hà'];

function grid() {
  const cells = {};
  return { cells, put: (r, c, o) => { cells[r + ',' + c] = o; } };
}
const editable = (rows, cols) => Object.fromEntries(rows.flatMap((r) => cols.map((c) => [r + ',' + c, 1])));

// ---------- tính lương: mỗi phòng ban 1 workbook nhỏ ----------
function payrollSheet(dept, seed) {
  const { cells, put } = grid();
  put(0, 0, { v: `Bảng lương - ${dept} - Tháng 10/2026`, s: { b: 1 } });
  put(1, 0, { v: 'Ô màu vàng là ô nhập liệu. Các ô còn lại (lương cơ bản, công thức) đã được khóa.', s: { i: 1, c: '#5f6b7a' } });
  ['Mã NV', 'Họ tên', 'Lương cơ bản', 'Phụ cấp', 'Ngày công', 'Thưởng', 'Khấu trừ', 'Thực lĩnh'].forEach((h, c) =>
    put(3, c, { v: h, s: HEAD(c, c > 1) }));
  let total = 0;
  const rowsIdx = [];
  NAMES.forEach((n, i) => {
    const r = 4 + i; rowsIdx.push(r);
    const base = 9000000 + ((seed * 7 + i * 13) % 9) * 1000000;
    const allow = 500000 + ((seed + i) % 4) * 250000;
    const net = Math.round(base / 26 * 26 + allow);
    total += net;
    put(r, 0, { v: `NV${seed}${i + 1}`.padEnd(6, '0') });
    put(r, 1, { v: n });
    put(r, 2, { v: base, s: { nf: '#,##0' } });
    put(r, 3, { v: allow, s: { nf: '#,##0' } });
    put(r, 4, { v: 26 });
    put(r, 5, { v: 0, s: { nf: '#,##0' } });
    put(r, 6, { v: 0, s: { nf: '#,##0' } });
    put(r, 7, { f: `C${r + 1}/26*E${r + 1}+D${r + 1}+F${r + 1}-G${r + 1}`, v: net, s: { nf: '#,##0', b: 1 } });
  });
  put(10, 1, { v: 'Tổng', s: { b: 1, bg: '#e8f3ed' } });
  put(10, 7, { f: 'SUM(H5:H10)', v: total, s: { b: 1, bg: '#e8f3ed', nf: '#,##0' } });
  return {
    name: dept, total,
    data: { rows: 40, cols: 9, colWidths: { 0: 80, 1: 170, 2: 120, 3: 100, 4: 90, 5: 100, 6: 100, 7: 130 }, cells },
    protect: { on: true, cells: editable(rowsIdx, [4, 5, 6]) },
  };
}

function payrollBook() {
  const depts = ['Phòng Kỹ thuật', 'Phòng Kinh doanh', 'Phòng Nhân sự', 'Phòng Kế toán', 'Phòng Marketing'];
  const sheets = depts.map((d, i) => payrollSheet(d, i + 1));
  const { cells, put } = grid();
  put(0, 0, { v: 'Tổng hợp lương tháng 10/2026', s: { b: 1 } });
  put(1, 0, { v: 'Công thức lấy số liệu trực tiếp từ từng workbook nhỏ', s: { i: 1, c: '#5f6b7a' } });
  ['Phòng ban', 'Nhân sự', 'Tổng thực lĩnh'].forEach((h, c) => put(3, c, { v: h, s: HEAD(c, c > 0) }));
  const grand = sheets.reduce((a, s) => a + s.total, 0);
  sheets.forEach((s, i) => {
    const r = 4 + i;
    put(r, 0, { v: s.name });
    put(r, 1, { f: `COUNTA('${s.name}'!B5:B10)`, v: 6 });
    put(r, 2, { f: `'${s.name}'!H11`, v: s.total, s: { nf: '#,##0' } });
  });
  put(9, 0, { v: 'Toàn công ty', s: { b: 1, bg: '#e8f3ed' } });
  put(9, 1, { f: 'SUM(B5:B9)', v: 30, s: { b: 1, bg: '#e8f3ed' } });
  put(9, 2, { f: 'SUM(C5:C9)', v: grand, s: { b: 1, bg: '#e8f3ed', nf: '#,##0' } });
  return {
    title: 'Tính lương tháng 10/2026',
    items: [
      ...sheets.map(({ name, data, protect }) => ({ name, type: 'excel', data, protect })),
      { name: 'Tổng hợp lương', type: 'excel', data: { rows: 40, cols: 6, colWidths: { 0: 180, 1: 90, 2: 150 }, cells } },
      { name: 'Thông báo kỳ lương', type: 'word', data: { html: '<h1>Thông báo chốt lương tháng 10/2026</h1><p>Các trưởng phòng nhập ngày công, thưởng và khấu trừ vào bảng lương của phòng mình trước <b>17:00 ngày 25/10</b>.</p><ul><li>Chỉ nhập vào các ô màu vàng.</li><li>Bấm "Nộp" khi hoàn tất.</li></ul>' } },
    ],
  };
}

// ---------- tính tiền nợ: mỗi nhóm khách hàng 1 workbook nhỏ ----------
function debtSheet(group, seed) {
  const { cells, put } = grid();
  put(0, 0, { v: `Công nợ - ${group} - đến 31/10/2026`, s: { b: 1 } });
  put(1, 0, { v: 'Nhập số tiền đã thu và số ngày tính lãi vào các ô màu vàng.', s: { i: 1, c: '#5f6b7a' } });
  ['Khách hàng', 'Dư nợ đầu kỳ', 'Phát sinh', 'Đã thu', 'Lãi suất/năm', 'Số ngày', 'Tiền lãi', 'Còn nợ'].forEach((h, c) =>
    put(3, c, { v: h, s: HEAD(c, c > 0) }));
  const customers = ['Công ty An Phát', 'Cửa hàng Bình Minh', 'Siêu thị Cường Thịnh', 'Đại lý Dũng Tiến', 'Nhà phân phối Hà Lan'];
  let total = 0; const rowsIdx = [];
  customers.forEach((n, i) => {
    const r = 4 + i; rowsIdx.push(r);
    const open = (40 + ((seed * 11 + i * 17) % 60)) * 1000000;
    const inc = (10 + ((seed * 5 + i * 3) % 30)) * 1000000;
    const rate = 0.09 + ((seed + i) % 4) * 0.01, days = 30;
    const interest = Math.round((open + inc) * rate / 365 * days);
    total += open + inc + interest;
    put(r, 0, { v: n });
    put(r, 1, { v: open, s: { nf: '#,##0' } });
    put(r, 2, { v: inc, s: { nf: '#,##0' } });
    put(r, 3, { v: 0, s: { nf: '#,##0' } });
    put(r, 4, { v: rate, s: { nf: '0.0%' } });
    put(r, 5, { v: days });
    put(r, 6, { f: `(B${r + 1}+C${r + 1}-D${r + 1})*E${r + 1}/365*F${r + 1}`, v: interest, s: { nf: '#,##0' } });
    put(r, 7, { f: `B${r + 1}+C${r + 1}-D${r + 1}+G${r + 1}`, v: open + inc + interest, s: { nf: '#,##0', b: 1 } });
  });
  put(9, 0, { v: 'Tổng cộng', s: { b: 1, bg: '#e8f3ed' } });
  put(9, 7, { f: 'SUM(H5:H9)', v: total, s: { b: 1, bg: '#e8f3ed', nf: '#,##0' } });
  return {
    name: group, total,
    data: { rows: 40, cols: 9, colWidths: { 0: 190, 1: 120, 2: 110, 3: 110, 4: 100, 5: 80, 6: 110, 7: 130 }, cells },
    protect: { on: true, cells: editable(rowsIdx, [3, 5]) },
  };
}

function debtBook() {
  const groups = ['Nhóm khách hàng A', 'Nhóm khách hàng B', 'Nhóm khách hàng C', 'Nhóm khách hàng D'];
  const sheets = groups.map((g, i) => debtSheet(g, i + 1));
  const { cells, put } = grid();
  put(0, 0, { v: 'Tổng hợp công nợ phải thu', s: { b: 1 } });
  ['Nhóm', 'Tổng còn nợ'].forEach((h, c) => put(3, c, { v: h, s: HEAD(c, c > 0) }));
  const grand = sheets.reduce((a, s) => a + s.total, 0);
  sheets.forEach((s, i) => {
    put(4 + i, 0, { v: s.name });
    put(4 + i, 1, { f: `'${s.name}'!H10`, v: s.total, s: { nf: '#,##0' } });
  });
  put(8, 0, { v: 'Toàn hệ thống', s: { b: 1, bg: '#e8f3ed' } });
  put(8, 1, { f: 'SUM(B5:B8)', v: grand, s: { b: 1, bg: '#e8f3ed', nf: '#,##0' } });
  return {
    title: 'Tính tiền nợ khách hàng',
    items: [
      ...sheets.map(({ name, data, protect }) => ({ name, type: 'excel', data, protect })),
      { name: 'Tổng hợp công nợ', type: 'excel', data: { rows: 40, cols: 4, colWidths: { 0: 190, 1: 150 }, cells } },
    ],
  };
}

module.exports = { payrollBook, debtBook, samples: () => [payrollBook(), debtBook()] };
