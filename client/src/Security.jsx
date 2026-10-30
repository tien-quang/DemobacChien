import React, { useState, useEffect } from 'react';
import { api } from './api.js';
import { fmt, useToast } from './util.jsx';

/* ================= Bảo mật tài khoản ================= */
function Password({ reloadMe, flash }) {
  const [old, setOld] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    try { await api.post('/me/password', { old, next }); setOld(''); setNext(''); flash('Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.'); reloadMe(); }
    catch (e2) { setErr(e2.message); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <h2>Đổi mật khẩu</h2>
      <div className="row">
        <input type="password" placeholder="Mật khẩu hiện tại" value={old} onChange={(e) => setOld(e.target.value)} />
        <input type="password" placeholder="Mật khẩu mới (từ 8 ký tự, có chữ và số)" value={next} onChange={(e) => setNext(e.target.value)} style={{ width: 300 }} />
        <button className="primary" disabled={!old || !next}>Đổi mật khẩu</button>
      </div>
      {err && <p className="err">{err}</p>}
    </form>
  );
}

function TwoFA({ me, reloadMe, flash }) {
  const [setup, setSetup] = useState(null);
  const [otp, setOtp] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const run = async (fn) => { setErr(''); try { await fn(); reloadMe(); } catch (e) { setErr(e.message); } };
  return (
    <div className="card">
      <h2>Xác thực 2 bước (TOTP)</h2>
      {me.totp ? (
        <>
          <p className="ok-text">Đang bật. Mỗi lần đăng nhập cần thêm mã 6 số từ ứng dụng Google Authenticator / Microsoft Authenticator.</p>
          <div className="row">
            <input type="password" placeholder="Mật khẩu" value={pw} onChange={(e) => setPw(e.target.value)} />
            <input placeholder="Mã 6 số" value={otp} onChange={(e) => setOtp(e.target.value)} style={{ width: 110 }} />
            <button className="danger" onClick={() => run(async () => { await api.post('/me/2fa/disable', { password: pw, otp }); setPw(''); setOtp(''); flash('Đã tắt 2FA.'); })}>Tắt 2FA</button>
          </div>
        </>
      ) : setup ? (
        <>
          <p>Mở ứng dụng Authenticator, chọn thêm tài khoản bằng <b>nhập khóa thủ công</b> và nhập khóa dưới đây, sau đó nhập mã 6 số hiện ra.</p>
          <p><code className="secret">{setup.secret}</code></p>
          <p className="muted small">Hoặc dùng đường dẫn: <code>{setup.uri}</code></p>
          <div className="row">
            <input placeholder="Mã 6 số" value={otp} onChange={(e) => setOtp(e.target.value)} style={{ width: 120 }} />
            <button className="primary" onClick={() => run(async () => { await api.post('/me/2fa/enable', { otp }); setSetup(null); setOtp(''); flash('Đã bật xác thực 2 bước.'); })}>Xác nhận và bật</button>
            <button onClick={() => setSetup(null)}>Hủy</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Chưa bật. Khuyến nghị bật cho mọi tài khoản, bắt buộc với quản trị viên.</p>
          <button className="primary" onClick={() => run(async () => setSetup(await api.post('/me/2fa/setup')))}>Bật 2FA</button>
        </>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}

function Sessions({ admin, flash }) {
  const [mine, setMine] = useState([]);
  const [all, setAll] = useState([]);
  const load = () => { api.get('/me/sessions').then(setMine); if (admin) api.get('/admin/sessions').then(setAll); };
  useEffect(load, []); // eslint-disable-line
  const table = (list, path) => (
    <table className="list">
      <thead><tr>{path === '/admin' && <th>Tài khoản</th>}<th>Thiết bị</th><th>IP</th><th>Đăng nhập</th><th>Hoạt động cuối</th><th /></tr></thead>
      <tbody>
        {list.map((s) => (
          <tr key={s.id}>
            {path === '/admin' && <td>{s.userName}</td>}
            <td className="small">{s.ua || '—'}{s.current && <b> (phiên này)</b>}</td>
            <td>{s.ip}</td><td className="small">{fmt(s.created)}</td><td className="small">{fmt(s.last)}</td>
            <td>{!s.current && <button className="danger" onClick={async () => { await api.del(path === '/admin' ? '/admin/sessions/' + s.id : '/me/sessions/' + s.id); flash('Đã đăng xuất phiên.'); load(); }}>Đăng xuất</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <>
      <div className="card"><h2>Phiên đăng nhập của bạn</h2>{table(mine, '/me')}</div>
      {admin && <div className="card"><h2>Tất cả phiên đang hoạt động (quản trị)</h2>{table(all, '/admin')}</div>}
    </>
  );
}

function Users({ flash }) {
  const [users, setUsers] = useState([]);
  const load = () => api.get('/users').then(setUsers);
  useEffect(() => { load(); }, []);
  const reset = async (u) => {
    const p = prompt(`Đặt mật khẩu tạm cho ${u.name} (từ 8 ký tự, có chữ và số). Người dùng sẽ bị đăng xuất và phải đổi lại:`);
    if (!p) return;
    try { await api.post(`/admin/users/${u.id}/reset`, { password: p }); flash('Đã đặt lại mật khẩu và đăng xuất người dùng.'); load(); } catch (e) { flash(e.message); }
  };
  return (
    <div className="card">
      <h2>Tài khoản</h2>
      <table className="list">
        <thead><tr><th>Tên</th><th>Tài khoản</th><th>Quyền</th><th>2FA</th><th>Mật khẩu</th><th>Trực tuyến</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td><td>{u.username}</td><td>{u.role === 'admin' ? 'Quản trị' : 'Người dùng'}</td>
              <td>{u.totp ? 'Bật' : 'Tắt'}</td><td>{u.defaultPw ? <span className="late">Mặc định</span> : 'Đã đổi'}</td>
              <td>{u.online ? 'Có' : '—'}</td>
              <td>{u.role !== 'admin' && <button onClick={() => reset(u)}>Đặt lại mật khẩu</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SecurityPage({ me, reloadMe }) {
  const [toast, flash] = useToast();
  const admin = me.role === 'admin';
  return (
    <div className="wrap">
      <h1>Bảo mật tài khoản</h1>
      {me.defaultPw && <p className="banner">Bạn đang dùng mật khẩu mặc định. Hãy đổi mật khẩu ngay bên dưới.</p>}
      <Password reloadMe={reloadMe} flash={flash} />
      <TwoFA me={me} reloadMe={reloadMe} flash={flash} />
      <Sessions admin={admin} flash={flash} />
      {admin && <Users flash={flash} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ================= Nhật ký ================= */
const LABEL = {
  denied: 'Cố truy cập trái phép', login: 'Đăng nhập', login_fail: 'Đăng nhập sai', login_2fa_fail: 'Sai mã 2FA', logout: 'Đăng xuất',
  submit: 'Nộp bài', reopen: 'Mở lại bài', unassign: 'Thu hồi quyền', deadline: 'Đặt hạn nộp', protect: 'Cấu hình khóa ô',
  upload: 'Tải lên', export_book: 'Tải workbook lớn', export_item: 'Tải workbook nhỏ', open: 'Mở workbook', open_book: 'Mở workbook lớn',
  force_logout: 'Buộc đăng xuất', password_change: 'Đổi mật khẩu', verify: 'Xác minh toàn vẹn', admin_reset_user: 'Đặt lại mật khẩu',
  '2fa_enable': 'Bật 2FA', '2fa_disable': 'Tắt 2FA',
};
export function AuditPage() {
  const [list, setList] = useState([]);
  const [chain, setChain] = useState(null);
  useEffect(() => { api.get('/audit').then(setList); }, []);
  return (
    <div className="wrap">
      <h1>Nhật ký thao tác</h1>
      <div className="card row">
        <button className="primary" onClick={async () => setChain(await api.get('/audit/verify'))}>Kiểm tra toàn vẹn nhật ký</button>
        {chain && (chain.ok
          ? <span className="ok-text">Toàn vẹn: {chain.count} bản ghi, chuỗi băm khớp (đầu chuỗi {chain.head}).</span>
          : <span className="err">PHÁT HIỆN CHỈNH SỬA: chuỗi băm bị đứt tại bản ghi #{chain.brokenAt}.</span>)}
        <span className="grow" />
        <button onClick={() => api.get('/audit').then(setList)}>Làm mới</button>
      </div>
      <div className="card">
        <table className="list">
          <thead><tr><th>#</th><th>Thời gian</th><th>Người dùng</th><th>Hành động</th><th>IP</th></tr></thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.n} className={e.action === 'denied' || e.action.endsWith('_fail') ? 'bad' : ''}>
                <td className="small">{e.n}</td><td>{fmt(e.at)}</td><td>{e.user || '—'}</td>
                <td>{LABEL[e.action] || (e.action.startsWith('assign:') ? 'Giao cho ' + e.action.slice(7) : e.action)}</td><td className="small">{e.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
