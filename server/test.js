// Kiểm thử tích hợp: npm test  (tự khởi động server ở cổng 4099 với thư mục dữ liệu tạm)
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const WebSocket = require('ws');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');

const PORT = 4099, BASE = `http://localhost:${PORT}`, DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-'));
let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name, extra ?? ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(BASE + url, {
      method, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc && sc.startsWith('sid=')) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (u) => call('GET', u), post: (u, b = {}, h) => call('POST', u, b, h), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u),
    cookie: () => cookie,
    login: async (username, password, otp) => (await call('POST', '/api/login', { username, password, otp })),
    ws: (origin = BASE) => new Promise((resolve, reject) => {
      const w = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: cookie, Origin: origin } });
      w.msgs = [];
      w.on('message', (m) => { const j = JSON.parse(m.toString()); w.msgs.push(j); w.emit('j', j); });
      w.on('open', () => resolve(w)); w.on('error', reject); w.on('unexpected-response', (q, r) => reject(new Error('HTTP ' + r.statusCode)));
    }),
  };
}
const waitFor = (w, pred, ms = 2000) => new Promise((resolve) => {
  const f = w.msgs.find(pred); if (f) return resolve(f);
  const t = setTimeout(() => resolve(null), ms);
  const h = (j) => { if (pred(j)) { clearTimeout(t); w.off('j', h); resolve(j); } };
  w.on('j', h);
});
const rpc = (w, msg) => new Promise((resolve) => {
  msg.seq = (w.seq = (w.seq || 0) + 1);
  const t = setTimeout(() => resolve({ t: 'timeout' }), 2000);
  const h = (j) => { if (j.seq === msg.seq && (j.t === 'ack' || j.t === 'err')) { clearTimeout(t); w.off('j', h); resolve(j); } };
  w.on('j', h); w.send(JSON.stringify(msg));
});
const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret, off = 0) {
  let bits = 0, val = 0; const out = [];
  for (const ch of secret) { val = (val << 5) | b32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + off));
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(buf).digest(); const o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}

(async () => {
  const srv = spawn('node', ['--disable-warning=ExperimentalWarning', 'index.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => d.toString().includes('API chạy') && r()));
  try {
    const admin = client(), u1 = client(), u2 = client(), u3 = client();

    console.log('\n[1] Đăng nhập và bảo mật phiên');
    ok((await admin.login('admin', 'sai')).status === 401, 'sai mật khẩu bị từ chối');
    const lr = await admin.login('admin', 'admin123');
    ok(lr.status === 200 && admin.cookie().startsWith('sid='), 'admin đăng nhập, nhận cookie phiên');
    ok(lr.headers.get('set-cookie').includes('HttpOnly') && lr.headers.get('set-cookie').includes('SameSite=Strict'), 'cookie HttpOnly + SameSite=Strict');
    ok(!JSON.stringify(lr.data).includes('token'), 'không trả token trong body (không đọc được bằng JS)');
    await u1.login('user1', 'user123'); await u2.login('user2', 'user123'); await u3.login('user3', 'user123');
    ok((await client().get('/api/books')).status === 401, 'không có phiên thì bị 401');
    const csrf = await admin.post('/api/books', { title: 'x' }, { Origin: 'http://evil.example' });
    ok(csrf.status === 403, 'CSRF: request ghi từ origin lạ bị chặn');

    console.log('\n[2] Tạo workbook lớn, giao việc');
    ok((await admin.post('/api/books/sample')).status === 200, 'tạo 2 workbook lớn mẫu (Tính lương, Tính tiền nợ)');
    const books = (await admin.get('/api/books')).data;
    ok(books.length === 2, 'có 2 workbook lớn', books.length);
    const payroll = books.find((b) => b.title.includes('lương'));
    const detail = (await admin.get('/api/books/' + payroll.id)).data;
    ok(detail.items.length === 7, 'workbook Tính lương chứa 7 workbook nhỏ (5 phòng ban, 1 tổng hợp, 1 Word)', detail.items.length);
    const kt = detail.items.find((i) => i.name === 'Phòng Kỹ thuật'), kd = detail.items.find((i) => i.name === 'Phòng Kinh doanh');
    ok((await u1.get('/api/books/' + payroll.id)).status === 403, 'user không xem được workbook lớn');
    const asg = await admin.put(`/api/books/${payroll.id}/assign`, { assignments: { [kt.id]: 'u1', [kd.id]: 'u2' } });
    ok(asg.status === 200 && asg.data.changed === 2, 'giao Phòng Kỹ thuật cho user1, Phòng Kinh doanh cho user2');

    console.log('\n[3] Cách ly: user chỉ thấy workbook nhỏ của mình');
    const mine = (await u1.get('/api/my-items')).data;
    ok(mine.length === 1 && mine[0].name === 'Phòng Kỹ thuật', 'user1 chỉ thấy 1 workbook được giao', JSON.stringify(mine));
    const g1 = await u1.get('/api/items/' + kt.id);
    ok(g1.status === 200, 'user1 mở được workbook của mình');
    ok(!('bookId' in g1.data.item) && !JSON.stringify(g1.data).includes('Tính lương'), 'phản hồi KHÔNG chứa workbook lớn / tên workbook lớn');
    ok(!JSON.stringify(g1.data).includes('Phòng Kinh doanh'), 'không chứa tên workbook nào khác');
    ok((await u1.get('/api/items/' + kd.id)).status === 404, 'user1 mở workbook của user2 bị 404');
    ok((await u3.get('/api/items/' + kt.id)).status === 404, 'user3 (không được giao) bị 404');
    ok((await u3.get('/api/my-items')).data.length === 0, 'user3 không thấy gì');
    ok((await u1.get('/api/items/' + kt.id + '/export')).status === 403, 'user không tải được file (export 403)');
    ok((await u1.get('/api/books/' + payroll.id + '/export')).status === 403, 'user không export được workbook lớn');
    ok((await u1.put('/api/items/' + kt.id + '/protect', { on: false })).status === 403, 'user không tự mở khóa ô');
    ok((await u1.post('/api/items/' + kd.id + '/submit')).status === 404, 'user1 không nộp thay user2');

    console.log('\n[4] Thời gian thực (WebSocket)');
    try { await u1.ws('http://evil.example'); ok(false, 'WS từ origin lạ phải bị từ chối'); } catch { ok(true, 'WS từ origin lạ bị từ chối (chống CSWSH)'); }
    try { await client().ws(); ok(false, 'WS không phiên phải bị từ chối'); } catch { ok(true, 'WS không có phiên bị từ chối'); }
    const wa = await admin.ws(); wa.send(JSON.stringify({ t: 'sub', book: payroll.id }));
    const w1 = await u1.ws();
    const w2 = await u2.ws();
    w1.send(JSON.stringify({ t: 'open', item: kt.id }));
    const pres = await waitFor(wa, (j) => j.t === 'presence' && j.item === kt.id && j.online);
    ok(!!pres, 'admin thấy user1 trực tuyến');
    const view0 = (await u1.get('/api/items/' + kt.id)).data;
    const free = Object.keys(view0.item.protect.cells)[0];
    ok(Object.keys(view0.item.protect.cells).length === 18, 'chỉ 18 ô (ngày công/thưởng/khấu trừ) được phép nhập', Object.keys(view0.item.protect.cells).length);
    const [fr, fc] = free.split(',').map(Number);
    const r1 = await rpc(w1, { t: 'edit', item: kt.id, patch: { [free]: { v: 20 } } });
    ok(r1.t === 'ack', 'user1 sửa ô được phép: nhận ack', JSON.stringify(r1));
    const pa = await waitFor(wa, (j) => j.t === 'patch' && j.item === kt.id);
    ok(pa && pa.patch[free].v === 20 && pa.by === 'u1', 'admin nhận NGAY thay đổi ô của user1 (real-time)');
    const r2 = await rpc(w1, { t: 'edit', item: kt.id, patch: { '4,2': { v: 999999999 } } });
    ok(r2.t === 'err' && r2.status === 403, 'sửa ô đã khóa (lương cơ bản) bị từ chối ở server', JSON.stringify(r2));
    const r3 = await rpc(w1, { t: 'edit', item: kt.id, patch: { '4,7': { f: '1+1' } } });
    ok(r3.t === 'err', 'chèn công thức đè vào ô công thức bị từ chối');
    const r4 = await rpc(w2, { t: 'edit', item: kt.id, patch: { [free]: { v: 1 } } });
    ok(r4.t === 'err' && r4.status === 404, 'user2 sửa workbook của user1 bị từ chối (404)');
    const r5 = await rpc(w1, { t: 'edit', item: kt.id, patch: { 'abc': { v: 1 } } });
    ok(r5.t === 'err' && r5.status === 400, 'dữ liệu sai định dạng bị từ chối');
    const r6 = await rpc(w1, { t: 'edit', item: kt.id, patch: { [free]: { v: { __proto__: 1 } } } });
    ok(r6.t === 'err', 'giá trị ô không phải số/chuỗi bị từ chối');
    w1.send(JSON.stringify({ t: 'sel', item: kt.id, r: fr, c: fc, typing: '25' }));
    const sel = await waitFor(wa, (j) => j.t === 'sel' && j.typing === '25');
    ok(!!sel && sel.by === 'Nhân viên 1', 'admin thấy con trỏ + nội dung user1 đang gõ dở');
    ok(!w2.msgs.some((j) => j.t === 'patch' || j.t === 'sel'), 'user2 KHÔNG nhận bất kỳ thay đổi nào của user1');
    const rAdminEdit = await rpc(wa, { t: 'edit', item: kt.id, patch: { [free]: { v: 5 } } });
    ok(rAdminEdit.t === 'ack', 'admin sửa được bài đã giao');

    console.log('\n[5] Nộp bài và tổng hợp về workbook lớn');
    const sub = await u1.post('/api/items/' + kt.id + '/submit');
    ok(sub.status === 200, 'user1 nộp bài');
    const st = await waitFor(wa, (j) => j.t === 'status' && j.item.id === kt.id && j.item.status === 'submitted');
    ok(!!st, 'admin nhận trạng thái "Đã nộp" ngay lập tức');
    const r7 = await rpc(w1, { t: 'edit', item: kt.id, patch: { [free]: { v: 30 } } });
    ok(r7.t === 'err' && r7.status === 409, 'sau khi nộp không sửa được nữa (409)');
    const rAdminSubmitted = await rpc(wa, { t: 'edit', item: kt.id, patch: { [free]: { v: 6 } } });
    ok(rAdminSubmitted.t === 'ack', 'admin sửa được bài đã nộp');
    const ver = (await admin.get(`/api/items/${kt.id}/verify`)).data;
    ok(ver.state === 'tampered', 'xác minh phát hiện admin đã chỉnh sửa sau khi nộp');
    const bd = (await admin.get(`/api/books/${payroll.id}/data`)).data;
    ok(bd[kt.id].data.cells[free].v === 6, 'dữ liệu sau khi admin chỉnh sửa đã nằm trong workbook lớn');
    const exp = await admin.get(`/api/books/${payroll.id}/export`);
    ok(exp.status === 200 && Buffer.isBuffer(exp.data) && exp.data.length > 5000, 'admin xuất cả workbook lớn thành 1 file .xlsx');
    ok((await admin.post(`/api/items/${kt.id}/reopen`)).status === 200, 'admin mở lại bài');
    const st2 = await waitFor(w1, (j) => j.t === 'status' && j.item.status === 'in_progress' && j.item.editable);
    ok(!!st2, 'user1 nhận thông báo được sửa lại ngay');

    console.log('\n[6] Phân quyền lại và hạn nộp');
    await admin.put(`/api/books/${payroll.id}/assign`, { assignments: { [kt.id]: 'u3' } });
    const rev = await waitFor(w1, (j) => j.t === 'status' && j.revoked && j.item === kt.id);
    ok(!!rev, 'user1 bị thu hồi quyền ngay lập tức');
    ok((await u1.get('/api/items/' + kt.id)).status === 404, 'user1 không còn truy cập được');
    ok((await u3.get('/api/items/' + kt.id)).status === 200, 'user3 truy cập được');
    await admin.put(`/api/books/${payroll.id}/assign`, { deadlines: { [kt.id]: new Date(Date.now() - 1000).toISOString() } });
    const w3 = await u3.ws();
    const r8 = await rpc(w3, { t: 'edit', item: kt.id, patch: { [free]: { v: 1 } } });
    ok(r8.t === 'err' && /hạn/.test(r8.error), 'quá hạn nộp thì không sửa được');

    console.log('\n[7] Quản lý phiên, 2FA, mật khẩu');
    const sess = (await admin.get('/api/admin/sessions')).data;
    const s2 = sess.find((s) => s.userName === 'Nhân viên 2');
    ok(!!s2, 'admin thấy danh sách phiên đang hoạt động');
    const closed = new Promise((r) => w2.on('close', r));
    await admin.del('/api/admin/sessions/' + s2.id);
    ok((await Promise.race([closed, sleep(1500).then(() => null)])) !== null, 'admin buộc đăng xuất user2: WebSocket bị đóng ngay');
    ok((await u2.get('/api/my-items')).status === 401, 'phiên user2 bị thu hồi (401)');
    const bad = await u3.post('/api/me/password', { old: 'user123', next: '123' });
    ok(bad.status === 400, 'mật khẩu yếu bị từ chối');
    const setup = await u3.post('/api/me/2fa/setup');
    ok(setup.status === 200 && /^[A-Z2-7]{32}$/.test(setup.data.secret), 'tạo khóa 2FA (TOTP)');
    ok((await u3.post('/api/me/2fa/enable', { otp: '000000' })).status === 400, 'mã 2FA sai không bật được');
    ok((await u3.post('/api/me/2fa/enable', { otp: totp(setup.data.secret) })).status === 200, 'bật 2FA bằng mã đúng');
    const l3 = client();
    const noOtp = await l3.login('user3', 'user123');
    ok(noOtp.status === 401 && noOtp.data.need2fa, 'đăng nhập thiếu mã 2FA bị yêu cầu mã');
    ok((await l3.login('user3', 'user123', totp(setup.data.secret, -1))).status === 401, 'mã 2FA đã dùng không được dùng lại (chống replay)');
    ok((await l3.login('user3', 'user123', totp(setup.data.secret, 1))).status === 200, 'đăng nhập với mã 2FA mới thành công');

    console.log('\n[8] Khóa tài khoản, nhật ký, mã hóa dữ liệu');
    const bf = client(); let last;
    for (let i = 0; i < 6; i++) last = await bf.login('user5', 'sai' + i);
    ok(last.status === 429, 'đăng nhập sai 5 lần bị khóa tạm thời');
    const au = (await admin.get('/api/audit')).data;
    ok(au.some((e) => e.action === 'denied'), 'nhật ký ghi lại các lần cố truy cập trái phép');
    ok(au.some((e) => e.action === 'submit') && au.some((e) => e.action === 'force_logout'), 'nhật ký ghi nộp bài, buộc đăng xuất');
    const av = (await admin.get('/api/audit/verify')).data;
    ok(av.ok === true && av.count > 20, 'chuỗi băm nhật ký toàn vẹn', JSON.stringify(av));
    await sleep(1200);
    const raw = Buffer.concat(['office.db', 'office.db-wal'].filter((f) => fs.existsSync(path.join(DATA, f))).map((f) => fs.readFileSync(path.join(DATA, f))));
    const text = raw.toString('latin1') + raw.toString('utf8');
    ok(raw.length > 50000 && !/Phòng Kỹ thuật|Nguyễn|Nhóm khách hàng|Tính lương|Báo cáo/.test(text), 'cơ sở dữ liệu: nội dung workbook, tên workbook, tên sheet đều được mã hóa (không đọc được chữ rõ)');
    ok(!/scrypt|"secret"/.test(text), 'khóa TOTP và dữ liệu nhạy cảm được mã hóa');

    console.log('\n[9] Tổng hợp workbook lớn (worker, phiên bản, liên kết ký sẵn)');
    const u6 = client(), u7 = client(), u8 = client();
    await u6.login('user6', 'user123'); await u7.login('user7', 'user123'); await u8.login('user8', 'user123');
    const debt = (await admin.get('/api/books')).data.find((b) => b.title.includes('nợ'));
    const dd = (await admin.get('/api/books/' + debt.id)).data;
    const gA = dd.items.find((i) => i.name === 'Nhóm khách hàng A'), gB = dd.items.find((i) => i.name === 'Nhóm khách hàng B'), gC = dd.items.find((i) => i.name === 'Nhóm khách hàng C');
    await admin.put(`/api/books/${debt.id}/assign`, { assignments: { [gA.id]: 'u6', [gB.id]: 'u7', [gC.id]: 'u8' } });
    const w6 = await u6.ws(), w7 = await u7.ws(), w8 = await u8.ws();
    const wa2 = await admin.ws(); wa2.send(JSON.stringify({ t: 'sub', book: debt.id }));
    ok((await rpc(w6, { t: 'edit', item: gA.id, patch: { '4,3': { v: 10000000 } } })).t === 'ack', 'user6 nhập số tiền đã thu cho nhóm A');
    await u6.post(`/api/items/${gA.id}/submit`);
    const listC = async () => (await admin.get(`/api/books/${debt.id}/consolidations`)).data;
    const waitCons = async (n, ms = 12000) => { const t = Date.now(); while (Date.now() - t < ms) { const l = await listC(); if (l.items.length >= n) return l; await sleep(300); } return await listC(); };
    const c1 = await waitCons(1);
    ok(c1.items.length === 1 && c1.items[0].n === 1, 'tự động tổng hợp sau khi có người nộp bài: ra bản v1', JSON.stringify(c1.items.map((i) => i.n)));
    const ev = await waitFor(wa2, (j) => j.t === 'consolidation' && j.n === 1);
    ok(!!ev, 'admin nhận thông báo thời gian thực: đã có bản tổng hợp mới');
    const m1 = c1.items[0].items;
    ok(m1.find((r) => r.name === 'Nhóm khách hàng A').included && m1.find((r) => r.name === 'Nhóm khách hàng A').source === 'submitted', 'v1: nhóm A (đã nộp) được đưa vào từ bản chụp bất biến');
    ok(!m1.find((r) => r.name === 'Nhóm khách hàng B').included, 'v1: nhóm B (đã giao, chưa nộp) KHÔNG đưa vào');
    const skip = await admin.post(`/api/books/${debt.id}/consolidate`, {});
    await sleep(1500);
    ok((await listC()).items.length === 1, 'bấm tổng hợp khi không có thay đổi: không tạo phiên bản thừa', JSON.stringify(skip.data));

    ok((await rpc(w7, { t: 'edit', item: gB.id, patch: { '4,3': { v: 5000000 } } })).t === 'ack', 'user7 nhập số tiền đã thu cho nhóm B');
    await u7.post(`/api/items/${gB.id}/submit`);
    const q1 = await admin.post(`/api/books/${debt.id}/consolidate`, {}), q2 = await admin.post(`/api/books/${debt.id}/consolidate`, {});
    ok(q1.data.coalesced || q2.data.coalesced, "nhiều yêu cầu tổng hợp liên tiếp được gộp thành 1 việc", JSON.stringify([q1.data, q2.data]));
    const c2 = await waitCons(2);
    await sleep(4500); // chờ yêu cầu tự động (trễ 3s) đã bị gộp, không sinh thêm bản
    const c2b = await listC();
    ok(c2b.items.length === 2, 'sau khi gộp chỉ có đúng 2 phiên bản (v1, v2)', c2b.items.length);
    ok(c2b.items[0].items.find((r) => r.name === 'Nhóm khách hàng B').included, 'v2: nhóm B đã được đưa vào');

    console.log('\n  -- tải file tổng hợp --');
    const verA = c2b.items[0];
    const lk = (await admin.post(`/api/consolidations/${verA.id}/link`)).data; const LP = '/api' + lk.path;
    ok(/exp=\d+&kind=xlsx&sig=[0-9a-f]{64}/.test(lk.path), 'admin xin được liên kết tải ký sẵn (hết hạn sau 5 phút)');
    ok((await u6.post(`/api/consolidations/${verA.id}/link`)).status === 403, 'user thường không xin được liên kết tải');
    ok((await u6.get(LP)).status === 403, 'user thường dùng liên kết của admin cũng bị từ chối');
    ok((await client().get(LP)).status === 401, 'không có phiên đăng nhập thì không tải được dù có liên kết');
    ok((await admin.get(LP.replace(/sig=[0-9a-f]/, (m) => 'sig=' + (m.endsWith('0') ? '1' : '0')))).status === 403, 'liên kết bị sửa chữ ký bị từ chối');
    ok((await admin.get(LP.replace(/exp=\d+/, 'exp=1'))).status === 403, 'liên kết bị sửa thời hạn bị từ chối');
    const dl = await admin.get(LP);
    ok(dl.status === 200 && Buffer.isBuffer(dl.data), 'tải file tổng hợp bằng liên kết hợp lệ');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(dl.data);
    const names = wb.worksheets.map((w) => w.name);
    ok(names[0] === 'Trạng thái nộp' && names.includes('Nhóm khách hàng A') && names.includes('Nhóm khách hàng B') && names.includes('Tổng hợp công nợ') && !names.includes('Nhóm khách hàng C'),
      'file tổng hợp: có sheet trạng thái + nhóm đã nộp + sheet tổng hợp của admin, loại nhóm C chưa nộp', names.join(' | '));
    const resOf = (ws, a) => { const v = ws.getCell(a).value; return typeof v === 'object' && v !== null ? v.result : v; };
    const totA = resOf(wb.getWorksheet('Nhóm khách hàng A'), 'H10'), totB = resOf(wb.getWorksheet('Nhóm khách hàng B'), 'H10');
    const sumTotal = resOf(wb.getWorksheet('Tổng hợp công nợ'), 'B5'), sumB = resOf(wb.getWorksheet('Tổng hợp công nợ'), 'B6');
    ok(sumTotal === totA && sumB === totB, 'sheet Tổng hợp công nợ: công thức đã được tính lại theo số liệu user vừa nộp', `${sumTotal} vs ${totA}`);
    const wsA = wb.getWorksheet('Nhóm khách hàng A');
    const expH5 = (resOf(wsA, 'B5') + resOf(wsA, 'C5') - resOf(wsA, 'D5')) * (1 + resOf(wsA, 'E5') / 365 * resOf(wsA, 'F5'));
    ok(Math.abs(resOf(wsA, 'H5') - expH5) < 0.01, 'công thức "Còn nợ" trong file đã tính lại theo số tiền user nhập (tự tính độc lập khớp)', `${resOf(wsA, 'H5')} vs ${expH5}`);
    let sumRows = 0; for (let r = 5; r <= 9; r++) sumRows += resOf(wsA, 'H' + r);
    ok(Math.abs(sumRows - totA) < 0.01, 'tổng nhóm A khớp tổng các dòng', `${sumRows} vs ${totA}`);
    const live = await admin.get(`/api/books/${debt.id}/export`);
    const wbl = new ExcelJS.Workbook(); await wbl.xlsx.load(live.data);
    const lt = wbl.getWorksheet('Nhóm khách hàng A'); const lv = (a) => { const v = lt.getCell(a).value; return typeof v === 'object' && v ? v.result : v; };
    ok(Math.abs(lv('H5') - (lv('B5') + lv('C5') - lv('D5')) * (1 + lv('E5') / 365 * lv('F5'))) < 0.01, 'xuất trực tiếp workbook lớn cũng tính lại công thức theo số liệu hiện tại (không còn số cũ)');
    ok(resOf(wb.getWorksheet('Nhóm khách hàng A'), 'D5') === 10000000, 'số liệu user nhập (10.000.000) có trong file tổng hợp');

    console.log('\n  -- so sánh phiên bản, bản nháp, phát hiện giả mạo --');
    await admin.post(`/api/items/${gA.id}/reopen`);
    ok((await rpc(w6, { t: 'edit', item: gA.id, patch: { '4,3': { v: 12000000 } } })).t === 'ack', 'admin mở lại nhóm A, user6 sửa số tiền đã thu thành 12.000.000');
    await u6.post(`/api/items/${gA.id}/submit`);
    await admin.post(`/api/books/${debt.id}/consolidate`, {});
    const c3 = await waitCons(3);
    const diff = (await admin.get(`/api/books/${debt.id}/consolidations/diff?a=${c3.items[1].id}&b=${c3.items[0].id}`)).data;
    const dA = diff.changes.find((x) => x.name === 'Nhóm khách hàng A');
    ok(dA && dA.cellsChanged >= 1 && dA.examples.some((e) => e.cell === 'D5' && e.from === 10000000 && e.to === 12000000), 'so sánh v2 và v3: nhóm A đổi ô D5 từ 10.000.000 thành 12.000.000', JSON.stringify(diff.changes));
    ok(!diff.changes.some((x) => x.name === 'Nhóm khách hàng B'), 'nhóm B không đổi nên không nằm trong danh sách khác biệt');
    ok((await rpc(w8, { t: 'edit', item: gC.id, patch: { '4,3': { v: 777 } } })).t === 'ack', 'user8 sửa nháp nhóm C nhưng chưa nộp');
    await admin.post(`/api/books/${debt.id}/consolidate`, { mode: 'latest' });
    const c4 = await waitCons(4);
    const rC = c4.items[0].items.find((r) => r.name === 'Nhóm khách hàng C');
    ok(c4.items.length === 4 && rC.included && rC.source === 'draft', 'chế độ "gồm bản nháp": nhóm C chưa nộp được đưa vào và gắn nhãn bản nháp');
    // giả mạo: xóa bản chụp bằng chứng của nhóm A trực tiếp trong cơ sở dữ liệu
    const dbm = new DatabaseSync(path.join(DATA, 'office.db'));
    dbm.prepare("DELETE FROM snapshots WHERE item_id=? AND kind='submit'").run(gA.id);
    const vf = (await admin.get(`/api/items/${gA.id}/verify`)).data;
    ok(vf.state === 'tampered' && vf.snapOk === false, 'xóa bản chụp bằng chứng: phần xác minh phát hiện ngay (tampered)');
    await admin.post(`/api/books/${debt.id}/consolidate`, {});
    const c5 = await waitCons(5);
    const rA4 = c5.items[0].items.find((r) => r.name === 'Nhóm khách hàng A');
    ok(c5.items.length === 5 && !rA4.included && /toàn vẹn/.test(rA4.note), 'tổng hợp tự loại bài nộp không còn toàn vẹn và ghi chú rõ lý do');
    let blocked = false; try { dbm.prepare('UPDATE audit SET a=? WHERE n=1').run('x'); } catch { blocked = true; }
    let blocked2 = false; try { dbm.prepare('DELETE FROM audit WHERE n=1').run(); } catch { blocked2 = true; }
    ok(blocked && blocked2, 'nhật ký là bảng chỉ ghi thêm: cơ sở dữ liệu từ chối sửa/xóa (trigger)');
    let blocked3 = false; try { dbm.prepare("UPDATE snapshots SET hash='x'").run(); } catch { blocked3 = true; }
    ok(blocked3, 'bản chụp bài nộp bất biến: cơ sở dữ liệu từ chối sửa');
    dbm.close();

    console.log('\n[10] Lưu trữ theo khối, nhật ký thao tác');
    const big = (await admin.post(`/api/books/${debt.id}/items`, { type: 'excel', name: 'Sheet lớn' })).data.id;
    for (let part = 0; part < 20; part++) {
      const patch = {};
      for (let i = 0; i < 5000; i++) { const n = part * 5000 + i; patch[`${Math.floor(n / 50)},${n % 50}`] = { v: n }; }
      const rr = await rpc(wa2, { t: 'edit', item: big, patch });
      if (rr.t !== 'ack') { ok(false, 'ghi 100.000 ô', JSON.stringify(rr)); break; }
    }
    await sleep(1500);
    const dbr = new DatabaseSync(path.join(DATA, 'office.db'));
    const snap = () => Object.fromEntries(dbr.prepare('SELECT chunk, hex(data) h FROM chunks WHERE item_id=?').all(big).map((r) => [r.chunk, r.h]));
    const before = snap();
    ok(Object.keys(before).length === 11, 'sheet 100.000 ô (2.000 dòng) được chia thành 10 khối + 1 khối bố cục', Object.keys(before).length);
    ok((await rpc(wa2, { t: 'edit', item: big, patch: { '1234,7': { v: 'đã sửa' } } })).t === 'ack', 'sửa 1 ô trong sheet 100.000 ô');
    await sleep(1200);
    const after = snap();
    const diffChunks = Object.keys(after).filter((k) => after[k] !== before[k]);
    ok(diffChunks.length === 1 && diffChunks[0] === '6', 'chỉ đúng 1 khối (khối 6, dòng 1200-1399) được ghi lại, không ghi cả sheet', diffChunks.join(','));
    const full = (await admin.get('/api/items/' + big)).data.data;
    ok(Object.keys(full.cells).length === 100000 && full.cells['1234,7'].v === 'đã sửa' && full.cells['0,0'].v === 0, 'đọc lại đủ 100.000 ô, giá trị đúng');
    dbr.close();
    [w6, w7, w8, wa2].forEach((w) => w.close());

    console.log('\n[11] Phục hồi sau sập máy và đổi khóa chủ (máy chủ riêng)');
    const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'office-crash-')), P2 = 4098, B2 = `http://localhost:${P2}`;
    const start2 = (env = {}) => new Promise((resolve) => {
      const p = spawn('node', ['--disable-warning=ExperimentalWarning', 'index.js'], { cwd: __dirname, env: { ...process.env, PORT: P2, DATA_DIR: DATA2, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; const on = (d) => { out += d; if (out.includes('API chạy')) resolve({ p, out: () => out }); };
      p.stdout.on('data', on);
    });
    const login2 = async (u, pw) => { const r = await fetch(B2 + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B2 }, body: JSON.stringify({ username: u, password: pw }) }); return r.headers.get('set-cookie').split(';')[0]; };
    const call2 = async (ck, m, u, b) => { const r = await fetch(B2 + u, { method: m, headers: { 'Content-Type': 'application/json', Origin: B2, Cookie: ck }, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
    let sv2 = await start2();
    let ck = await login2('admin', 'admin123');
    const bk = (await call2(ck, 'POST', '/api/books', { title: 'Sổ thử sập' })).id;
    const itm = (await call2(ck, 'POST', `/api/books/${bk}/items`, { type: 'excel', name: 'Bảng thử' })).id;
    await call2(ck, 'PUT', `/api/books/${bk}/assign`, { assignments: { [itm]: 'u1' } });
    const ck1 = await login2('user1', 'user123');
    const wsx = await new Promise((res) => { const w = new WebSocket(`ws://localhost:${P2}/ws`, { headers: { Cookie: ck1, Origin: B2 } }); w.msgs = []; w.on('message', (m) => { const j = JSON.parse(m.toString()); w.msgs.push(j); w.emit('j', j); }); w.on('open', () => res(w)); });
    const ack = await rpc(wsx, { t: 'edit', item: itm, patch: { '3,3': { v: 'chưa kịp ghi vào khối' } } });
    ok(ack.t === 'ack', 'user gửi chỉnh sửa và được máy chủ xác nhận');
    sv2.p.kill('SIGKILL'); await new Promise((r) => sv2.p.on('close', r)); // sập máy ngay, trước khi khối kịp được ghi
    sv2 = await start2();
    ok(/Phục hồi\] đã phát lại 1 thao tác/.test(sv2.out()), 'khởi động lại: tự phát lại thao tác chưa ghi ("Phục hồi")', sv2.out().slice(-200));
    ck = await login2('admin', 'admin123');
    ok((await call2(ck, 'GET', '/api/items/' + itm)).data.cells['3,3'].v === 'chưa kịp ghi vào khối', 'sau khi sập máy dữ liệu user vừa nhập vẫn còn nguyên');
    const ck1b = await login2('user1', 'user123');
    await call2(ck1b, 'POST', `/api/items/${itm}/submit`);
    ok((await call2(ck, 'GET', `/api/items/${itm}/verify`)).state === 'ok', 'bài nộp được ký và xác minh toàn vẹn');
    sv2.p.kill('SIGTERM'); await new Promise((r) => sv2.p.on('close', r));
    const newKey = crypto.randomBytes(32).toString('hex');
    const rot = spawn('node', ['--disable-warning=ExperimentalWarning', 'rotate-key.js'], { cwd: __dirname, env: { ...process.env, DATA_DIR: DATA2, NEW_KEY: newKey }, stdio: 'pipe' });
    let rotOut = ''; rot.stdout.on('data', (d) => (rotOut += d)); await new Promise((r) => rot.on('close', r));
    ok(/Đã đổi khóa/.test(rotOut) && fs.readFileSync(path.join(DATA2, '.key'), 'utf8').trim() === newKey, 'đổi khóa chủ: chỉ bọc lại khóa dữ liệu, file khóa đã cập nhật', rotOut);
    sv2 = await start2();
    ck = await login2('admin', 'admin123');
    ok((await call2(ck, 'GET', '/api/items/' + itm)).data.cells['3,3'].v === 'chưa kịp ghi vào khối', 'sau khi đổi khóa vẫn đọc được dữ liệu cũ');
    ok((await call2(ck, 'GET', `/api/items/${itm}/verify`)).state === 'ok', 'sau khi đổi khóa chữ ký bài nộp cũ vẫn hợp lệ (khóa ký độc lập)');
    sv2.p.kill('SIGTERM'); await new Promise((r) => sv2.p.on('close', r));
    const wrong = spawn('node', ['--disable-warning=ExperimentalWarning', 'index.js'], { cwd: __dirname, env: { ...process.env, PORT: P2, DATA_DIR: DATA2, DATA_KEY: crypto.randomBytes(32).toString('hex') }, stdio: 'pipe' });
    let wOut = ''; wrong.stderr.on('data', (d) => (wOut += d)); wrong.stdout.on('data', (d) => (wOut += d));
    const code = await new Promise((r) => wrong.on('close', r));
    ok(code !== 0 && !wOut.includes('API chạy'), 'khởi động với khóa sai: máy chủ từ chối chạy, không đọc được dữ liệu');
    fs.rmSync(DATA2, { recursive: true, force: true });

    console.log('\n[12] Workflow chuẩn: nhiều workbook lớn > nhiều workbook nhỏ > giao > làm > nộp > duyệt/trả lại > về workbook lớn');
    const JSZip = require('jszip'), http = require('http');
    const { exportXlsx } = require('./excel');
    const mk = async (title, names) => {
      const parts = names.map((n) => ({ name: n, data: { rows: 50, cols: 6, colWidths: {}, cells: { '0,0': { v: n }, '1,1': { v: 1 } } } }));
      const buf = Buffer.from(await exportXlsx({ parts }));
      return (await admin.post('/api/books/upload', buf, { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(title + '.xlsx') })).data;
    };
    const bkA = await mk('Hồ sơ Alpha', ['A1', 'A2', 'A3']), bkB = await mk('Hồ sơ Beta', ['B1', 'B2']);
    ok(bkA.added === 3 && bkB.added === 2 && bkA.bookId !== bkB.bookId, 'admin tải lên nhiều workbook lớn: mỗi file thành 1 workbook lớn, mỗi sheet thành 1 workbook nhỏ');
    const itemsOf = async (id) => (await admin.get('/api/books/' + id)).data.items;
    const byName = (list, n) => list.find((i) => i.name === n);
    let la = await itemsOf(bkA.bookId), lb = await itemsOf(bkB.bookId);
    const A1 = byName(la, 'A1'), A2 = byName(la, 'A2'), A3 = byName(la, 'A3'), IB1 = byName(lb, 'B1'), IB2 = byName(lb, 'B2');
    const extra = (await admin.post(`/api/books/${bkA.bookId}/items`, { type: 'excel', name: 'Tạm' })).data.id;
    await admin.patch ? null : null;
    const rn = await fetch(BASE + '/api/items/' + extra, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: admin.cookie() }, body: JSON.stringify({ name: 'Đổi tên rồi xóa' }) });
    ok((await rn.json()).name === 'Đổi tên rồi xóa', 'admin quản lý workbook nhỏ: thêm, đổi tên');
    ok((await admin.del('/api/items/' + extra)).status === 200 && (await itemsOf(bkA.bookId)).length === 3, 'admin quản lý workbook nhỏ: xóa');

    const u9 = client(), u10 = client(); await u9.login('user9', 'user123'); await u10.login('user10', 'user123');
    await admin.put(`/api/books/${bkA.bookId}/assign`, { assignments: { [A1.id]: 'u9', [A2.id]: 'u9', [A3.id]: 'u10' } });
    await admin.put(`/api/books/${bkB.bookId}/assign`, { assignments: { [IB1.id]: 'u9', [IB2.id]: 'u10' } });
    const my9 = (await u9.get('/api/my-items')).data, my10 = (await u10.get('/api/my-items')).data;
    ok(my9.length === 3 && my10.length === 2, 'user nhận nhiều workbook nhỏ nếu admin giao (user9: 3, user10: 2), kể cả từ 2 workbook lớn khác nhau', `${my9.length}/${my10.length}`);
    ok(!JSON.stringify(my9).includes('Alpha') && !JSON.stringify(my9).includes('Beta'), 'danh sách của user không lộ tên workbook lớn nào');
    const all5 = [A1, A2, A3, IB1, IB2];
    const mine9 = new Set([A1.id, A2.id, IB1.id]);
    let leak = 0, okOwn = 0;
    for (const it of all5) { const st = (await u9.get('/api/items/' + it.id)).status; if (mine9.has(it.id)) { if (st === 200) okOwn++; } else if (st !== 404) leak++; }
    ok(okOwn === 3 && leak === 0, 'user9 mở được đúng 3 workbook được giao; mọi workbook khác bị 404');
    const w9 = await u9.ws(); const w10 = await u10.ws();
    ok((await rpc(w9, { t: 'edit', item: A3.id, patch: { '5,5': { v: 1 } } })).status === 404, 'user9 không thể trỏ/ghi vào workbook của người khác qua thời gian thực (404)');

    ok((await rpc(w9, { t: 'edit', item: A1.id, patch: { '3,3': { v: 42 } } })).t === 'ack', 'user9 làm workbook A1');
    ok((await u9.post(`/api/items/${A1.id}/submit`)).status === 200, 'user9 nộp A1');
    ok((await admin.get(`/api/books/${bkA.bookId}/data`)).data[A1.id].data.cells['3,3'].v === 42, 'bài đã nộp nằm trong workbook lớn mà admin quản lý (đúng workbook Alpha)');
    ok(!(await admin.get(`/api/books/${bkB.bookId}/data`)).data[A1.id], 'và không lẫn sang workbook lớn khác');
    ok((await u9.post(`/api/items/${A1.id}/approve`)).status === 403 && (await u9.post(`/api/items/${A1.id}/reopen`, { reason: 'x' })).status === 403, 'user không tự duyệt / không tự mở lại bài của mình');
    ok((await admin.post(`/api/items/${A2.id}/approve`)).status === 409, 'không duyệt được bài chưa nộp');
    ok((await admin.post(`/api/items/${A1.id}/approve`)).status === 200, 'admin duyệt A1');
    ok((await rpc(w9, { t: 'edit', item: A1.id, patch: { '3,3': { v: 1 } } })).status === 409 && (await u9.post(`/api/items/${A1.id}/submit`)).status === 409, 'sau khi duyệt user không sửa / nộp lại được');
    ok((await admin.get(`/api/items/${A1.id}/verify`)).data.state === 'ok', 'bài đã duyệt vẫn xác minh toàn vẹn (ok)');
    ok((await admin.post(`/api/items/${A1.id}/reopen`, { reason: 'Sai số liệu dòng 4, làm lại giúp' })).status === 200, 'admin trả lại kèm lý do');
    const back = (await u9.get('/api/my-items')).data.find((i) => i.id === A1.id);
    ok(back.status === 'in_progress' && back.editable && back.returnNote === 'Sai số liệu dòng 4, làm lại giúp', 'user thấy lý do trả lại và được sửa lại');
    ok((await rpc(w9, { t: 'edit', item: A1.id, patch: { '3,3': { v: 43 } } })).t === 'ack', 'user sửa lại theo yêu cầu');
    await u9.post(`/api/items/${A1.id}/submit`);
    ok((await u9.get('/api/my-items')).data.find((i) => i.id === A1.id).returnNote === null, 'nộp lại thì lý do cũ được xóa');
    await admin.post(`/api/items/${A1.id}/approve`);

    // Word: cùng workflow, kèm kiểm tra ảnh ngoài không bị máy chủ tự tải (SSRF)
    let hits = 0; const lis = http.createServer((q, r) => { hits++; r.end('x'); }); await new Promise((r) => lis.listen(0, '127.0.0.1', r));
    const lport = lis.address().port;
    const W = (await admin.post(`/api/books/${bkA.bookId}/items`, { type: 'word', name: 'Biên bản họp' })).data.id;
    await admin.put(`/api/books/${bkA.bookId}/assign`, { assignments: { [W]: 'u10' } });
    ok((await u9.get('/api/items/' + W)).status === 404, 'văn bản Word của user10 không mở được bởi user9');
    const html = `<h1>Kết luận</h1><p>Đã thống nhất phương án 2</p><img src="http://127.0.0.1:${lport}/ssrf.png"><script>alert(1)</script>`;
    ok((await rpc(w10, { t: 'edit', item: W, html })).t === 'ack', 'user10 soạn văn bản Word (thời gian thực)');
    await u10.post(`/api/items/${W}/submit`); await admin.post(`/api/items/${W}/approve`);
    const ex = await admin.get(`/api/items/${W}/export`);
    ok(ex.status === 200 && hits === 0, 'xuất Word: ảnh trỏ ra ngoài KHÔNG bị máy chủ tự tải (chống SSRF)', 'hits=' + hits);
    await admin.post(`/api/books/${bkA.bookId}/consolidate`, { mode: 'approved' });
    const listBook = async () => (await admin.get(`/api/books/${bkA.bookId}/consolidations`)).data;
    let cb = null; for (let i = 0; i < 50 && !cb; i++) { const l = await listBook(); cb = l.items.find((x) => x.mode === 'approved' && x.docx); if (!cb) await sleep(300); }
    ok(!!cb, 'tổng hợp chế độ "chỉ bài đã duyệt" xong, có kèm file văn bản');
    const rowsOf = Object.fromEntries(cb.items.map((r) => [r.name, r]));
    ok(rowsOf.A1.included && rowsOf.A1.source === 'approved', 'workbook A1 đã duyệt được đưa vào workbook lớn');
    ok(!rowsOf.A2.included && !rowsOf.A3.included, 'A2, A3 chưa nộp nên chưa vào workbook lớn');
    ok(rowsOf['Biên bản họp'].included, 'văn bản Word đã duyệt được đưa vào');
    const dlw = (await admin.post(`/api/consolidations/${cb.id}/link`, { kind: 'docx' })).data;
    ok(/kind=docx/.test(dlw.path), 'liên kết tải file văn bản có chữ ký riêng theo loại file');
    const swap = await admin.get('/api' + dlw.path.replace('kind=docx', 'kind=xlsx'));
    ok(swap.status === 403, 'đổi loại file trong liên kết bị từ chối (chữ ký gắn với loại file)');
    const dd2 = await admin.get('/api' + dlw.path);
    const zip = await JSZip.loadAsync(dd2.data); const xml = await zip.file('word/document.xml').async('string');
    ok(dd2.status === 200 && /Đã thống nhất phương án 2/.test(xml) && /Biên bản họp/.test(xml) && !/alert\(1\)/.test(xml), 'file .docx tổng hợp có nội dung văn bản đã nộp, không có mã script');
    ok(hits === 0, 'tổng hợp Word cũng không tải ảnh ngoài (SSRF = 0 lần gọi)', 'hits=' + hits);
    const xlsxLink = (await admin.post(`/api/consolidations/${cb.id}/link`, {})).data;
    const wbx = new ExcelJS.Workbook(); await wbx.xlsx.load((await admin.get('/api' + xlsxLink.path)).data);
    const sheetNames = wbx.worksheets.map((w) => w.name);
    ok(sheetNames.includes('A1') && !sheetNames.includes('A2') && !sheetNames.includes('A3') && sheetNames[0] === 'Trạng thái nộp', 'file Excel tổng hợp chỉ chứa A1 (đã duyệt) và sheet trạng thái', sheetNames.join(','));
    lis.close();
    [w9, w10].forEach((w) => w.close());
    [wa, w1, w2, w3].forEach((w) => w.close());
  } catch (e) { fail++; console.log('  ✗ LỖI KHÔNG MONG ĐỢI:', e); }
  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\nKết quả: ${pass} đạt, ${fail} lỗi`);
  process.exit(fail ? 1 : 0);
})();
