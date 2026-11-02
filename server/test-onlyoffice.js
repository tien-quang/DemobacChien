// Kiểm thử tích hợp ONLYOFFICE: npm run test:oo
// Dựng 1 "Document Server giả" (tải file, nhận lệnh forcesave, gọi callback) và chạy máy chủ thật ở cổng 4098.
const { spawn } = require('child_process');
const http = require('http');
const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const HTMLtoDOCX = require('html-to-docx');
const ExcelJS = require('exceljs');

const PORT = 4098, FAKE = 4097, BASE = `http://localhost:${PORT}`, DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'office-oo-'));
const SECRET = 'test-secret-' + crypto.randomBytes(6).toString('hex');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n, x ?? ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64u = (b) => Buffer.from(b).toString('base64url');
const jwt = (payload, secret = SECRET, alg = 'HS256') => {
  const h = b64u(JSON.stringify({ alg, typ: 'JWT' })), p = b64u(JSON.stringify(payload));
  return alg === 'none' ? `${h}.${p}.` : `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
};
const unjwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
const verifies = (t) => { const [h, p, s] = t.split('.'); return crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') === s; };

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc && sc.startsWith('sid=')) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return { get: (u) => call('GET', u), post: (u, b = {}, h) => call('POST', u, b, h), put: (u, b) => call('PUT', u, b), login: (u, p) => call('POST', '/api/login', { username: u, password: p }) };
}

(async () => {
  // ----- Document Server giả -----
  const fake = { docx: null, commands: [], callbacks: new Map() /* key -> callbackUrl */ };
  const fakeSrv = http.createServer((req, res) => {
    if (req.url.startsWith('/download')) { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(fake.docx); }
    if (req.url === '/command' && req.method === 'POST') {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', async () => {
        const body = JSON.parse(b); const tok = req.headers.authorization?.replace('Bearer ', '');
        fake.commands.push({ body, authOk: !!tok && verifies(tok) });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 0, key: body.key }));
        const cb = fake.callbacks.get(body.key);
        if (cb && body.c === 'forcesave') { // giả lập Document Server gọi callback status 6 sau khi nhận lệnh
          fake.docx = fake.xlsxOnForce || await HTMLtoDOCX('<html><body><p>Nội dung gõ dở lúc nộp bài</p></body></html>');
          setTimeout(() => fetch(cb, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt({ payload: { status: 6, url: `http://localhost:${FAKE}/download` } }) }, body: JSON.stringify({ status: 6 }) }), 150);
        }
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => fakeSrv.listen(FAKE, r));

  const srv = spawn('node', ['--disable-warning=ExperimentalWarning', 'index.js'], {
    cwd: __dirname, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT, DATA_DIR: DATA, ONLYOFFICE_URL: `http://localhost:${FAKE}`, ONLYOFFICE_APP_URL: BASE, ONLYOFFICE_JWT_SECRET: SECRET },
  });
  await new Promise((r) => srv.stdout.on('data', (d) => d.toString().includes('API chạy') && r()));

  try {
    const admin = client(), u1 = client(), u2 = client();
    await admin.login('admin', 'admin123'); await u1.login('user1', 'user123'); await u2.login('user2', 'user123');

    console.log('\n[1] Cấu hình');
    ok((await u1.get('/api/onlyoffice/status')).data.enabled === true, 'máy chủ báo ONLYOFFICE đã bật');
    await admin.post('/api/books/sample');
    const books = (await admin.get('/api/books')).data;
    const detail = (await admin.get('/api/books/' + books.find((b) => b.title.includes('lương')).id)).data;
    const word = detail.items.find((i) => i.type === 'word'), excel = detail.items.find((i) => i.type === 'excel');
    const bookId = books.find((b) => b.title.includes('lương')).id;
    await admin.put(`/api/books/${bookId}/assign`, { assignments: { [word.id]: 'u1' } });

    console.log('\n[2] Cấp cấu hình trình soạn thảo');
    ok((await u2.get(`/api/items/${word.id}/onlyoffice`)).status === 404, 'user không được giao bị 404 (không lộ item)');
    ok((await u1.get(`/api/items/${excel.id}/onlyoffice`)).status === 404, 'item Excel của người khác bị 404');
    const r = await u1.get(`/api/items/${word.id}/onlyoffice`);
    ok(r.status === 200 && r.data.config?.token, 'user được giao nhận cấu hình có token');
    const cfg = r.data.config;
    ok(verifies(cfg.token) && unjwt(cfg.token).document.key === cfg.document.key, 'token cấu hình ký đúng bằng khóa JWT, khớp nội dung');
    ok(cfg.editorConfig.mode === 'edit' && cfg.document.permissions.edit === true, 'user đang làm bài: chế độ sửa');
    ok(cfg.document.permissions.download === false && cfg.document.permissions.print === false && cfg.document.permissions.copy === false, 'user không được tải/in/copy (khớp chế độ restricted cũ)');
    const ra = await admin.get(`/api/items/${word.id}/onlyoffice`);
    ok(ra.data.config.document.permissions.download === true && ra.data.config.document.key === cfg.document.key, 'admin được tải xuống; cùng item + version dùng chung key (cộng tác 1 phiên)');
    ok(r.data.scriptUrl === `http://localhost:${FAKE}/web-apps/apps/api/documents/api.js`, 'đường dẫn api.js đúng');

    console.log('\n[3] Document Server tải file (liên kết ký sẵn, không cookie)');
    const fileUrl = new URL(cfg.document.url);
    const f = await fetch(BASE + fileUrl.pathname + fileUrl.search);
    const fb = Buffer.from(await f.arrayBuffer());
    ok(f.status === 200 && fb[0] === 0x50 && fb[1] === 0x4b, 'tải được file .docx hợp lệ bằng liên kết ký sẵn');
    ok((await fetch(BASE + fileUrl.pathname + fileUrl.search.replace(/sig=./, 'sig=0'))).status === 404, 'sửa chữ ký: bị từ chối');
    ok((await fetch(BASE + fileUrl.pathname + '?' + fileUrl.search.slice(1).replace(/exp=\d+/, 'exp=1'))).status === 404, 'liên kết hết hạn: bị từ chối');
    ok((await fetch(`${BASE}/oo/file/${excel.id}` + fileUrl.search)).status === 404, 'đổi sang item khác với cùng chữ ký: bị từ chối');
    const cbUrl = cfg.editorConfig.callbackUrl;
    ok((await fetch(cbUrl.replace('/callback/', '/file/'))).status === 404, 'liên kết callback không dùng để tải file (chữ ký gắn mục đích)');

    console.log('\n[4] Callback lưu văn bản');
    const cbPath = new URL(cbUrl); const cb = BASE + cbPath.pathname + cbPath.search;
    const post = (url, body, auth) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) }, body: JSON.stringify(body) }).then(async (x) => ({ status: x.status, data: await x.json().catch(() => ({})) }));
    fake.docx = await HTMLtoDOCX('<html><body><h1>Tiêu đề từ ONLYOFFICE</h1><p>Xin chào Document Server</p><script>alert(1)</script></body></html>');
    const evt = { status: 2, url: `http://localhost:${FAKE}/download` };
    ok((await post(cb, evt)).status === 403, 'callback không có JWT: bị từ chối');
    ok((await post(cb, evt, jwt(evt, 'khoa-sai'))).status === 403, 'callback JWT sai khóa: bị từ chối');
    ok((await post(cb, evt, jwt(evt, '', 'none'))).status === 403, 'callback JWT alg=none: bị từ chối');
    ok((await post(cb.replace(/sig=./, 'sig=0'), evt, jwt(evt))).status === 403, 'callback sai chữ ký liên kết: bị từ chối');
    let cur = (await admin.get('/api/items/' + word.id)).data;
    const v0 = cur.item.version;
    ok(!cur.data.html.includes('Xin chào Document Server'), 'các lần bị từ chối không làm đổi nội dung');

    const evil = { status: 2, url: 'http://127.0.0.1:1/ssrf.docx' };
    const evilRes = await post(cb, evil, jwt(evil));
    ok(evilRes.data.error === 1, 'callback trỏ url ra ngoài Document Server: bị từ chối (chống SSRF)');

    const good = await post(cb, evt, jwt(evt));
    ok(good.status === 200 && good.data.error === 0, 'callback hợp lệ: trả error 0');
    cur = (await admin.get('/api/items/' + word.id)).data;
    ok(cur.data.html.includes('Xin chào Document Server') && cur.data.html.includes('Tiêu đề từ ONLYOFFICE'), 'nội dung từ file .docx được lưu vào văn bản');
    ok(!/<\s*script/i.test(cur.data.html), 'HTML lưu ra không có thẻ script (chữ "alert(1)" nếu còn chỉ là văn bản thường)');
    ok(cur.item.version > v0, 'version tăng (qua core.applyEdit, có nhật ký thao tác)');
    const evt3 = { payload: { status: 2, url: `http://localhost:${FAKE}/download` } };
    ok((await post(cb, evt3, jwt(evt3))).data.error === 0, 'chấp nhận cả dạng JWT có lớp payload');
    const st = { status: 1 };
    ok((await post(cb, st, jwt(st))).data.error === 0, 'trạng thái 1 (đang sửa) chỉ ghi nhận, không lưu');

    console.log('\n[5] Nộp bài ép lưu phần chưa lưu');
    const c2 = (await u1.get(`/api/items/${word.id}/onlyoffice`)).data.config;
    const cu2 = new URL(c2.editorConfig.callbackUrl);
    fake.callbacks.set(c2.document.key, BASE + cu2.pathname + cu2.search);
    const sub = await u1.post(`/api/items/${word.id}/submit`);
    ok(sub.status === 200, 'nộp bài thành công');
    ok(fake.commands.some((c) => c.body.c === 'forcesave' && c.body.key === c2.document.key && c.authOk), 'máy chủ gửi lệnh forcesave có JWT hợp lệ trước khi nộp');
    cur = (await admin.get('/api/items/' + word.id)).data;
    ok(cur.data.html.includes('Nội dung gõ dở lúc nộp bài'), 'bản nộp chứa phần vừa ép lưu');

    console.log('\n[6] Sau khi nộp, user không ghi đè được');
    fake.docx = await HTMLtoDOCX('<html><body><p>Cố ghi đè sau khi nộp</p></body></html>');
    const late = await post(cb, evt, jwt(evt));
    ok(late.data.error === 0, 'callback muộn được trả error 0 (Document Server không gọi lại mãi)');
    cur = (await admin.get('/api/items/' + word.id)).data;
    ok(!cur.data.html.includes('Cố ghi đè'), 'nhưng nội dung KHÔNG bị ghi đè khi bài đã nộp');
    const ad = await admin.get('/api/audit');
    ok(JSON.stringify(ad.data).includes('oo_save_denied') && JSON.stringify(ad.data).includes('"oo_save"'), 'nhật ký ghi cả lần lưu và lần bị từ chối');
    const cfg2 = (await u1.get(`/api/items/${word.id}/onlyoffice`)).data.config;
    ok(cfg2.editorConfig.mode === 'view' && cfg2.document.permissions.edit === false, 'đã nộp: mở lại chỉ ở chế độ xem');
    ok((await admin.get('/api/audit/verify')).data.ok !== false, 'chuỗi băm nhật ký vẫn toàn vẹn');

    console.log('\n[7] Excel mở bằng ONLYOFFICE');
    const kt = detail.items.find((i) => i.name === 'Phòng Kỹ thuật');
    await admin.put(`/api/books/${bookId}/assign`, { assignments: { [kt.id]: 'u1' } });
    await admin.put(`/api/items/${kt.id}/protect`, { on: true });
    await admin.put(`/api/items/${kt.id}/protect`, { allow: ['20,5'] });
    const xc = (await u1.get(`/api/items/${kt.id}/onlyoffice`)).data.config;
    ok(xc.documentType === 'cell' && xc.document.fileType === 'xlsx' && xc.document.title.endsWith('.xlsx'), 'Excel: documentType=cell, fileType=xlsx');
    ok(xc.editorConfig.mode === 'edit' && verifies(xc.token), 'Excel: chế độ sửa, token ký đúng');
    const xu = new URL(xc.document.url);
    const xf = await fetch(BASE + xu.pathname + xu.search);
    const xbuf = Buffer.from(await xf.arrayBuffer());
    ok(xf.status === 200 && xbuf[0] === 0x50 && xf.headers.get('content-type').includes('spreadsheetml'), 'Excel: Document Server tải được file .xlsx hợp lệ');
    const wbk = new ExcelJS.Workbook(); await wbk.xlsx.load(xbuf);
    const wsx = wbk.worksheets[0];
    const before = (await admin.get('/api/items/' + kt.id)).data;
    const hadA1 = JSON.stringify(before.data.cells['0,0']);
    wsx.getCell(21, 6).value = 777;          // ô 20,5: được phép nhập
    wsx.getCell(1, 1).value = 'HACK-Ô-KHÓA';  // ô 0,0: bị khóa
    fake.docx = Buffer.from(await wbk.xlsx.writeBuffer());
    const xcb = new URL(xc.editorConfig.callbackUrl); const xcbUrl = BASE + xcb.pathname + xcb.search;
    const xr = await post(xcbUrl, evt, jwt(evt));
    ok(xr.data.error === 0, 'Excel: callback hợp lệ');
    const after = (await admin.get('/api/items/' + kt.id)).data;
    ok(after.data.cells['20,5']?.v === 777, 'Excel: ô được phép nhập đã lưu (777)');
    ok(JSON.stringify(after.data.cells['0,0']) === hadA1, 'Excel: ô bị khóa KHÔNG bị đổi bởi user');
    ok(after.item.version > before.item.version, 'Excel: version tăng qua core.applyEdit');
    const adm = await admin.get(`/api/items/${kt.id}/onlyoffice`);
    ok(adm.data.config.document.key !== xc.document.key, 'Excel: key đổi sau khi lưu (không dùng bản cache cũ)');

    console.log('\n[8] Excel: nộp bài ép lưu');
    const xc2 = (await u1.get(`/api/items/${kt.id}/onlyoffice`)).data.config;
    const xcb2 = new URL(xc2.editorConfig.callbackUrl);
    fake.callbacks.set(xc2.document.key, BASE + xcb2.pathname + xcb2.search);
    const w2 = new ExcelJS.Workbook(); await w2.xlsx.load(fake.docx);
    w2.worksheets[0].getCell(21, 6).value = 888;
    const keepDocx = fake.docx;
    const origCmds = fake.commands.length;
    // lệnh forcesave của Document Server giả sẽ tạo file Word; ở đây thay bằng file xlsx để mô phỏng đúng loại
    fake.xlsxOnForce = Buffer.from(await w2.xlsx.writeBuffer());
    const sub2 = await u1.post(`/api/items/${kt.id}/submit`);
    ok(sub2.status === 200 && fake.commands.length > origCmds, 'Excel: nộp bài gửi lệnh forcesave');
    void keepDocx;
    const fin = (await admin.get('/api/items/' + kt.id)).data;
    ok(fin.data.cells['20,5']?.v === 888, 'Excel: bản nộp chứa giá trị vừa ép lưu (888)');
  } catch (e) { fail++; console.log('  ✗ LỖI TEST:', e); }
  srv.kill(); fakeSrv.close();
  console.log(`\nKết quả: ${pass} đạt, ${fail} lỗi`);
  process.exit(fail ? 1 : 0);
})();
