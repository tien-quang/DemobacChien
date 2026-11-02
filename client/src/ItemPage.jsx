import React, { useState, useEffect, useRef } from 'react';
import { api } from './api.js';
import { live } from './live.js';
import { diffGrid } from './diff.js';
import { go, useLive, useToast, deadlineText, ConnDot, STATUS } from './util.jsx';
import Spreadsheet from './Spreadsheet.jsx';
import WordPane, { OfficePane } from './OnlyOfficeEditor.jsx';

// Workbook nhỏ của user: cửa sổ độc lập, chỉ chứa đúng 1 bảng, không có tab/sheet/workbook nào khác.
export default function ItemPage({ me, id }) {
  const [item, setItem] = useState(null);
  const [data, setData] = useState(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [toast, flash] = useToast();
  const sent = useRef(null);
  const cur = useRef(null), curTimer = useRef(null);

  const load = async () => {
    const r = await api.get('/items/' + id);
    setItem(r.item); setData(r.data); sent.current = r.data;
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
    live.connect();
    const off = live.sub({ t: 'open', item: id }, { t: 'leave', item: id });
    return () => { off(); clearTimeout(curTimer.current); };
  }, [id]); // eslint-disable-line

  useEffect(() => {
    const warn = (e) => { if (live.pendingCount()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  useLive((m) => {
    if (m.t === 'pending') setPending(m.n);
    else if (m.t === 'status' && m.revoked && m.item === id) { flash('Bạn không còn quyền với workbook này.'); go('#/'); }
    else if (m.t === 'status' && m.item?.id === id) { setItem((i) => ({ ...i, ...m.item })); if (m.item.editable) flash('Quản trị viên đã mở lại bài, bạn có thể chỉnh sửa.'); }
    else if (m.t === 'protect' && m.item === id) setItem((i) => ({ ...i, protect: m.protect }));
  });

  const sendEdit = (msg) => live.edit({ item: id, ...msg }).catch((e) => { flash(e.message); load(); });
  const onSheet = (nd) => {
    const d = diffGrid(sent.current, nd);
    sent.current = nd; setData(nd);
    if (d) sendEdit(d);
  };
  const onWord = (html) => { const nd = { html }; sent.current = nd; setData(nd); sendEdit({ html }); };
  const onCursor = (c) => {
    cur.current = c;
    if (curTimer.current) return;
    curTimer.current = setTimeout(() => { curTimer.current = null; live.send({ t: 'sel', item: id, ...cur.current }); }, 120);
  };

  const submit = async () => {
    if (!confirm('Nộp bài? Sau khi nộp bạn sẽ không thể chỉnh sửa nữa (trừ khi quản trị viên mở lại).')) return;
    try {
      if (!(await live.drain())) { flash('Chưa gửi hết dữ liệu lên máy chủ, hãy kiểm tra kết nối rồi thử lại.'); return; }
      await api.post(`/items/${id}/submit`);
      await load();
      flash('Đã nộp bài. Quản trị viên sẽ thấy ngay bài của bạn.');
    } catch (e) { flash(e.message); }
  };

  if (error) return <div className="wrap"><p className="err">{error}</p><button onClick={() => go('#/')}>Về danh sách</button></div>;
  if (!item || !data) return <div className="wrap muted">Đang tải…</div>;

  const wm = `${me.name} · ${me.username} · #${me.tag} · ${new Date().toLocaleDateString('vi-VN')}`;
  const admin = me.role === 'admin';
  const notice = admin
    ? (item.status === 'approved' ? 'Đã duyệt: quản trị viên vẫn có thể chỉnh sửa' : item.status === 'submitted' ? 'Đã nộp: quản trị viên vẫn có thể chỉnh sửa' : 'Quản trị viên có thể chỉnh sửa')
    : item.status === 'approved' ? 'Đã được duyệt: chỉ xem' : item.status === 'submitted' ? 'Đã nộp, chờ duyệt: chỉ xem' : item.pastDue ? 'Quá hạn nộp: chỉ xem' : !item.editable ? 'Chỉ xem' : '';
  return (
    <div className="docpage">
      <div className={'titlebar ' + item.type}>
        <button className="ghost" onClick={() => go('#/')}>Quay lại</button>
        <span className="doctitle-bar">{item.name}</span>
        <span className={'tag light ' + item.status}>{STATUS[item.status]}</span>
        {item.deadline && <span className={'savemsg' + (item.pastDue ? ' late-w' : '')}>{deadlineText(item.deadline)}</span>}
        <span className="grow" />
        {item.editable && <span className="savemsg">{pending ? 'Đang gửi…' : 'Đã lưu trên máy chủ'}</span>}
        <ConnDot />
        {item.editable && !admin && <button className="submit" onClick={submit}>Nộp bài</button>}
      </div>
      {item.returnNote && item.editable && <div className="return-note"><b>Quản trị viên trả lại bài:</b> {item.returnNote}</div>}
      <div className="docbody">
        {item.type === 'excel' ? (
          <OfficePane
            key={item.id} id={item.id} editable={item.editable} notice={notice}
            classic={<Spreadsheet
              key={item.id} sheetName={item.name} data={data} others={{}} editable={item.editable} restricted
              protect={item.protect} watermark={wm} notice={notice} onBlocked={flash} onCursor={onCursor} onChange={onSheet}
            />}
          />
        ) : (
          <WordPane key={item.id} id={item.id} html={data.html} editable={item.editable} restricted watermark={wm} notice={notice} onChange={onWord} />
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
