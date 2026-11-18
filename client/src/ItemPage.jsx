import React, { useState, useEffect, useRef, useMemo } from 'react';
import { api } from './api.js';
import { live } from './live.js';
import { diffGrid } from './diff.js';
import { go, useLive, useToast, deadlineText, ConnDot, STATUS } from './util.jsx';
import Spreadsheet from './Spreadsheet.jsx';
import WordPane, { SheetPane } from './OnlyOfficeEditor.jsx';

// Workbook nhỏ của user: cửa sổ độc lập, chỉ chứa đúng 1 bảng, không có tab/sheet/workbook nào khác.
export default function ItemPage({ me, id }) {
  const [item, setItem] = useState(null);
  const [data, setData] = useState(null);
  const [sheetRevision, setSheetRevision] = useState(0);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [toast, flash] = useToast();
  const sent = useRef(null);
  const cur = useRef(null), curTimer = useRef(null);
  const dataRef = useRef(null), fxTimer = useRef(null);
  const summaryRevs = useRef({}), reloadTimer = useRef(null);
  const [summaries, setSummaries] = useState([]); // bảng tổng hợp user được xem (kèm sheet của mình)
  const [ooOn, setOoOn] = useState(null);         // ONLYOFFICE bật? (tắt: hiện thêm tab tổng hợp tính ngay trên trình duyệt)
  const [tab, setTab] = useState('own');
  const [sumFx, setSumFx] = useState({});
  const [cellFx, setCellFx] = useState(null); // ô vừa đổi trên bảng tổng hợp (nháy sáng)

  const load = async () => {
    const r = await api.get('/items/' + id);
    setItem(r.item); setData(r.data); sent.current = r.data; dataRef.current = r.data;
    setSummaries(r.summaries || []);
    summaryRevs.current = Object.fromEntries((r.summaries || []).map((s) => [s.id, s.rev])); // rev gốc: chỉ khi rev đổi (người khác đổi số) mới cần nạp lại
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.get('/onlyoffice/status').then((r) => setOoOn(!!r.enabled)).catch(() => setOoOn(false));
    live.connect();
    const off = live.sub({ t: 'open', item: id }, { t: 'leave', item: id });
    return () => { off(); clearTimeout(curTimer.current); clearTimeout(fxTimer.current); clearTimeout(reloadTimer.current); };
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
    else if (m.t === 'summary' && m.item === id) { // bảng tổng hợp (chỉ xem): máy chủ đẩy giá trị mới khi các bài được giao thay đổi
      const old = dataRef.current?.cells || {}, nu = m.data.cells || {};
      const changed = new Set();
      for (const k of new Set([...Object.keys(old), ...Object.keys(nu)])) if (JSON.stringify(old[k]?.v ?? null) !== JSON.stringify(nu[k]?.v ?? null)) changed.add(k);
      dataRef.current = m.data; sent.current = m.data; setData(m.data);
      if (changed.size && Object.keys(old).length) {
        setCellFx(changed); clearTimeout(fxTimer.current);
        fxTimer.current = setTimeout(() => setCellFx(null), 2500);
        flash(`Bảng tổng hợp vừa thay đổi (${changed.size} ô).`);
      }
    } else if (m.t === 'summary') {
      // Người KHÁC vừa đổi số liệu nên bảng tổng hợp kèm theo sheet của mình đổi. (User tự sửa sheet mình thì bảng tổng hợp tự tính lại ngay, không có tin này.)
      if (!m.rev || summaryRevs.current[m.item] === m.rev) return;
      summaryRevs.current[m.item] = m.rev;
      if (ooOn === false) { // trình duyệt tự tính: chỉ cần thay dữ liệu, không tải lại gì cả
        setSummaries((list) => list.map((s) => {
          if (s.id !== m.item) return s;
          const changed = new Set();
          for (const k of new Set([...Object.keys(s.data.cells), ...Object.keys(m.data.cells)])) if (JSON.stringify(s.data.cells[k]?.v ?? null) !== JSON.stringify(m.data.cells[k]?.v ?? null)) changed.add(k);
          if (changed.size) {
            setSumFx((f) => ({ ...f, [s.id]: changed }));
            setTimeout(() => setSumFx((f) => ({ ...f, [s.id]: null })), 2500);
            flash(`Bảng tổng hợp "${s.name}" vừa đổi do số liệu của người khác (${changed.size} ô).`);
          }
          return { ...s, data: m.data, rev: m.rev };
        }));
      } else { // ONLYOFFICE: lưu phần đang gõ rồi nạp lại file (gộp các tin dồn dập trong 1,5 giây để không làm gián đoạn)
        clearTimeout(reloadTimer.current);
        reloadTimer.current = setTimeout(() => {
          api.post(`/items/${id}/onlyoffice/flush`).catch(() => {}).finally(async () => {
            await load().catch(() => {});
            setSheetRevision((n) => n + 1);
            flash('Số liệu tổng hợp vừa được cập nhật do người khác thay đổi.');
          });
        }, 1500);
      }
    }
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

  const ownOthers = useMemo(() => (item && data?.cells ? { [item.name]: data.cells } : {}), [item?.name, data?.cells]); // sheet của mình, dữ liệu sống: tổng hợp tính lại ngay khi gõ
  const sumTab = summaries.find((s) => s.id === tab);
  if (error) return <div className="wrap"><p className="err">{error}</p><button onClick={() => go('#/')}>Về danh sách</button></div>;
  if (!item || !data) return <div className="wrap muted">Đang tải…</div>;

  const wm = `${me.name} · ${me.username} · #${me.tag} · ${new Date().toLocaleDateString('vi-VN')}`;
  const admin = me.role === 'admin';
  const viewOnly = !!item.viewOnly;
  const notice = viewOnly ? 'Bảng tổng hợp (chỉ xem): số liệu tự cập nhật khi các bài được giao thay đổi. Ô vừa đổi sẽ nháy sáng.'
    : admin
    ? (item.status === 'approved' ? 'Đã duyệt: quản trị viên vẫn có thể chỉnh sửa' : item.status === 'submitted' ? 'Đã nộp: quản trị viên vẫn có thể chỉnh sửa' : 'Quản trị viên có thể chỉnh sửa')
    : item.status === 'approved' ? 'Đã được duyệt: chỉ xem' : item.status === 'submitted' ? 'Đã nộp, chờ duyệt: chỉ xem' : item.pastDue ? 'Quá hạn nộp: chỉ xem' : !item.editable ? 'Chỉ xem' : '';
  return (
    <div className="docpage">
      <div className={'titlebar ' + item.type}>
        <button className="ghost" onClick={() => go('#/')}>Quay lại</button>
        <span className="doctitle-bar">{item.name}</span>
        {viewOnly ? <span className="tag light approved">Chỉ xem · bảng tổng hợp</span> : <span className={'tag light ' + item.status}>{STATUS[item.status]}</span>}
        {!viewOnly && item.deadline && <span className={'savemsg' + (item.pastDue ? ' late-w' : '')}>{deadlineText(item.deadline)}</span>}
        <span className="grow" />
        {!viewOnly && item.editable && <span className="savemsg">{pending ? 'Đang gửi…' : 'Đã lưu trên máy chủ'}</span>}
        <ConnDot />
        {!viewOnly && item.editable && !admin && <button className="submit" onClick={submit}>Nộp bài</button>}
      </div>
      {item.returnNote && item.editable && <div className="return-note"><b>Quản trị viên trả lại bài:</b> {item.returnNote}</div>}
      <div className="docbody">
        {viewOnly ? (
          <SheetPane key={item.id} id={item.id} editable={false} notice={notice} rev={item.protect && item.protect.rev}>
            <Spreadsheet
              key={item.id} sheetName={item.name} data={data} others={{}} editable={false} restricted
              protect={item.protect} watermark={wm} notice={notice} flash={cellFx} onBlocked={flash} onChange={() => {}}
            />
          </SheetPane>
        ) : sumTab && ooOn === false ? (
          <Spreadsheet
            key={'sum-' + sumTab.id} sheetName={sumTab.name} data={sumTab.data} others={ownOthers} editable={false} restricted
            protect={{ on: false, cells: {} }} watermark={wm} flash={sumFx[sumTab.id]} onBlocked={flash}
            notice={`Bảng tổng hợp (chỉ xem): đổi ngay khi bạn sửa sheet "${item.name}" và khi người khác đổi số liệu của họ.`} onChange={() => {}}
          />
        ) : item.type === 'excel' ? (
          <SheetPane key={`${item.id}-${sheetRevision}`} id={item.id} editable={item.editable} notice={notice} rev={item.protect && item.protect.rev}>
            <Spreadsheet
              key={item.id} sheetName={item.name} data={data} others={{}} editable={item.editable} restricted
              protect={item.protect} watermark={wm} notice={notice} onBlocked={flash} onCursor={onCursor} onChange={onSheet}
            />
          </SheetPane>
        ) : (
          <WordPane key={item.id} id={item.id} html={data.html} editable={item.editable} restricted watermark={wm} notice={notice} onChange={onWord} />
        )}
      </div>
      {!viewOnly && ooOn === false && summaries.length > 0 && (
        <div className="tabsbar">
          <button className={'stab' + (tab === 'own' ? ' on' : '')} onClick={() => setTab('own')}><b>{item.name}</b><small>bài của bạn</small></button>
          {summaries.map((s) => <button key={s.id} className={'stab' + (tab === s.id ? ' on' : '')} onClick={() => setTab(s.id)}><b>{s.name}</b><small>tổng hợp · chỉ xem</small></button>)}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
