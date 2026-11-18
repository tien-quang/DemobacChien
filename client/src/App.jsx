import React, { useState, useEffect, useRef } from 'react';
import { api, setUnauthHandler } from './api.js';
import { live } from './live.js';
import { go, useLive } from './util.jsx';
import { HomeAdmin, HomeUser } from './Home.jsx';
import BookPage from './BookPage.jsx';
import ItemPage from './ItemPage.jsx';
import { SecurityPage, AuditPage } from './Security.jsx';
import { POLICY_SECTIONS, POLICY_STORAGE_KEY, POLICY_VERSION } from './policy.js';

function useHash() {
  const [h, setH] = useState(location.hash || '#/');
  useEffect(() => {
    const f = () => setH(location.hash || '#/');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h;
}

function PolicyGate({ onAccepted }) {
  const box = useRef(null);
  const [atEnd, setAtEnd] = React.useState(false);
  const [checked, setChecked] = React.useState(false);
  const onScroll = () => {
    const el = box.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setAtEnd(true);
  };
  const accept = () => {
    localStorage.setItem(POLICY_STORAGE_KEY, new Date().toISOString());
    onAccepted();
  };
  return (
    <div className="login">
      <section className="card policy-card">
        <h1>Chính sách thông tin nội bộ</h1>
        <p className="muted small">Công ty · Phiên bản {POLICY_VERSION}</p>
        <p>Trước khi sử dụng ứng dụng, vui lòng đọc và đồng ý với các quy định bảo vệ thông tin của Công ty.</p>
        <div ref={box} className="policy-scroll" onScroll={onScroll}>
          {POLICY_SECTIONS.map((section) => (
            <section key={section.title}>
              <h2>{section.title}</h2>
              <ul>{section.items.map((item) => <li key={item}>{item}</li>)}</ul>
            </section>
          ))}
          <p><b>Bạn đã đọc hết nội dung chính sách.</b></p>
        </div>
        <p className="muted small">{atEnd ? 'Bạn có thể tích xác nhận để tiếp tục.' : 'Cuộn xuống cuối để tiếp tục.'}</p>
        <label className="policy-check">
          <input type="checkbox" checked={checked} disabled={!atEnd} onChange={(e) => setChecked(e.target.checked)} />
          Tôi đã đọc, hiểu và cam kết tuân thủ Chính sách thông tin nội bộ của Công ty.
        </label>
        <button className="primary" disabled={!atEnd || !checked} onClick={accept}>Đồng ý và tiếp tục</button>
      </section>
    </div>
  );
}

function Login({ onDone, notice, policyAccepted, onPolicyAccepted }) {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [otp, setOtp] = useState('');
  const [need2fa, setNeed] = useState(false);
  const [err, setErr] = useState(notice || '');
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    try { await api.post('/login', { username, password, otp: need2fa ? otp : undefined, policyVersion: POLICY_VERSION }); onDone(); }
    catch (e2) { if (e2.data?.need2fa) { setNeed(true); setErr(''); } else setErr(e2.message); }
  };
  if (!policyAccepted) return <PolicyGate onAccepted={onPolicyAccepted} />;
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Office nội bộ</h1>
        <p className="muted">Đăng nhập để mở workbook được giao.</p>
        <input placeholder="Tài khoản" value={username} onChange={(e) => setU(e.target.value)} autoFocus autoComplete="username" />
        <input placeholder="Mật khẩu" type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
        {need2fa && <input placeholder="Mã xác thực 6 số" value={otp} onChange={(e) => setOtp(e.target.value)} autoFocus inputMode="numeric" autoComplete="one-time-code" />}
        <button className="primary">Đăng nhập</button>
        {err && <p className="err">{err}</p>}
        <p className="muted small">Tài khoản demo: admin / admin123 · user1 đến user10 / user123</p>
      </form>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [ready, setReady] = useState(false);
  const [loginNotice, setNotice] = useState('');
  const [policyAccepted, setPolicyAccepted] = useState(() => !!localStorage.getItem(POLICY_STORAGE_KEY));
  const hash = useHash();

  const loadMe = () => api.get('/me').then(setMe);
  useEffect(() => {
    setUnauthHandler((msg) => { live.disconnect(); setMe(null); setNotice(msg || 'Phiên đã hết hạn, vui lòng đăng nhập lại'); });
    api.get('/me').then(setMe).catch(() => {}).finally(() => setReady(true));
  }, []);
  useLive((m) => { if (m.t === 'session-expired') { live.disconnect(); setMe(null); setNotice('Phiên đã kết thúc (hết hạn hoặc bị đăng xuất). Vui lòng đăng nhập lại.'); } });

  if (!ready) return null;
  if (!me) return <Login notice={loginNotice} policyAccepted={policyAccepted} onPolicyAccepted={() => setPolicyAccepted(true)} onDone={() => { setNotice(''); loadMe(); }} />;

  const logout = async () => { try { await api.post('/logout'); } catch {} live.disconnect(); setMe(null); setNotice(''); go('#/'); };
  const admin = me.role === 'admin';
  const book = hash.match(/^#\/book\/([a-f0-9]+)/);
  const item = hash.match(/^#\/item\/([a-f0-9]+)/);

  if (book && admin) return <BookPage key={book[1]} me={me} id={book[1]} />;
  if (item) return <ItemPage key={item[1]} me={me} id={item[1]} />;
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">Office nội bộ</a>
        <nav>
          <a href="#/">{admin ? 'Workbook lớn' : 'Workbook của tôi'}</a>
          {admin && <a href="#/audit">Nhật ký</a>}
          <a href="#/security">Bảo mật</a>
        </nav>
        <span className="grow" />
        {me.defaultPw && <a className="warnlink" href="#/security">Đổi mật khẩu mặc định</a>}
        <span className="muted">{me.name}</span>
        <button onClick={logout}>Đăng xuất</button>
      </header>
      {hash === '#/security' ? <SecurityPage me={me} reloadMe={loadMe} />
        : hash === '#/audit' && admin ? <AuditPage />
        : admin ? <HomeAdmin /> : <HomeUser />}
    </>
  );
}
