import React, { useState, useEffect, useMemo, useRef } from 'react';
import { api } from './api.js';
import { live } from './live.js';
import { diffGrid, applyPatch } from './diff.js';
import { go, fmt, useLive, useToast, ConnDot, Modal, STATUS, deadlineText } from './util.jsx';
import Spreadsheet from './Spreadsheet.jsx';
import WordPane, { SheetPane } from './OnlyOfficeEditor.jsx';
import Consolidation from './Consolidation.jsx';

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/* ================= Tổng quan + phân quyền ================= */
function Overview({ book, online, users, onOpen, reload, flash }) {
  const [draft, setDraft] = useState({});
  const [dl, setDl] = useState({});
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    setDraft(Object.fromEntries(book.items.map((i) => [i.id, i.assigneeId || ''])));
    setDl(Object.fromEntries(book.items.map((i) => [i.id, toLocalInput(i.deadline)])));
  }, [book.items.map((i) => i.id + i.assigneeId + i.deadline).join()]); // eslint-disable-line

  const changedA = book.items.filter((i) => draft[i.id] !== undefined && draft[i.id] !== (i.assigneeId || ''));
  const changedD = book.items.filter((i) => dl[i.id] !== undefined && dl[i.id] !== toLocalInput(i.deadline));
  const total = changedA.length + changedD.length;

  const auto = () => {
    const d = {};
    book.items.forEach((it, i) => { d[it.id] = users[i]?.id || ''; });
    setDraft(d);
  };
  const guard = (fn) => async (...a) => { setBusy(true); try { await fn(...a); } catch (e) { flash(e.message); } finally { setBusy(false); } };
  const save = guard(async () => {
    const assignments = Object.fromEntries(changedA.map((i) => [i.id, draft[i.id] || null]));
    const deadlines = Object.fromEntries(changedD.map((i) => [i.id, dl[i.id] ? new Date(dl[i.id]).toISOString() : null]));
    const r = await api.put(`/books/${book.id}/assign`, { assignments, deadlines });
    flash(`Đã lưu phân quyền (${r.changed} thay đổi).`);
    reload();
  });
  const addFile = guard(async (f) => { const r = await api.upload(f, book.id); if (r.warnings?.length) alert(r.warnings.join('\n')); flash(`Đã thêm ${r.added} workbook nhỏ.`); reload(); });
  const addBlank = guard(async (type) => { await api.post(`/books/${book.id}/items`, { type }); reload(); });
  const approve = guard(async (it) => { await api.post(`/items/${it.id}/approve`); flash(`Đã duyệt "${it.name}".`); reload(); });
  const giveBack = guard(async (it) => {
    const reason = prompt(`Trả lại "${it.name}" cho ${it.assigneeName} làm lại. Nhập lý do (người làm sẽ thấy):`, '');
    if (reason === null) return;
    await api.post(`/items/${it.id}/reopen`, { reason }); flash('Đã trả lại bài.'); reload();
  });
  const remove = guard(async (it) => { if (confirm(`Xóa workbook nhỏ "${it.name}"?`)) { await api.del('/items/' + it.id); reload(); } });
  const verify = guard(async (it) => {
    const r = await api.get(`/items/${it.id}/verify`);
    setModal({
      title: `Xác minh toàn vẹn: ${it.name}`,
      body: r.state === 'ok'
        ? <><p className="ok-text"><b>Toàn vẹn.</b> Dữ liệu hiện tại khớp hoàn toàn với bản người dùng đã nộp, chữ ký của máy chủ hợp lệ.</p><p className="small muted">Nộp lúc {fmt(r.submittedAt)}<br />SHA-256: <code>{r.hash}</code></p></>
        : r.state === 'tampered'
          ? <p className="err"><b>CẢNH BÁO:</b> dữ liệu đã bị thay đổi sau khi nộp (hoặc chữ ký không hợp lệ). {!r.dataOk && 'Mã băm không khớp. '}{!r.sigOk && 'Chữ ký không hợp lệ.'}</p>
          : <p>Workbook này chưa được nộp.</p>,
    });
  });
  const history = guard(async (it) => {
    const h = await api.get(`/items/${it.id}/history`);
    setModal({
      title: `Lịch sử: ${it.name}`,
      body: h.length ? (
        <table className="list"><thead><tr><th>Thời gian</th><th>Hành động</th><th>Bởi</th></tr></thead>
          <tbody>{h.map((x, i) => <tr key={i}><td>{fmt(x.at)}</td><td>{x.action}</td><td>{x.byName}</td></tr>)}</tbody></table>
      ) : <p className="muted">Chưa có sự kiện nào.</p>,
    });
  });
  const exportItem = guard((it) => api.download(`/items/${it.id}/export`, `${it.name}.${it.type === 'excel' ? 'xlsx' : 'docx'}`));

  const count = (s) => book.items.filter((i) => i.status === s).length;
  return (
    <div className="overview">
      <div className="stats">
        <div><b>{book.items.length}</b><span>workbook nhỏ</span></div>
        <div><b>{count('unassigned')}</b><span>chưa giao</span></div>
        <div><b>{count('assigned')}</b><span>mới giao</span></div>
        <div><b>{count('in_progress')}</b><span>đang làm</span></div>
        <div><b>{count('submitted')}</b><span>chờ duyệt</span></div>
        <div><b>{count('approved')}</b><span>đã duyệt</span></div>
        <div><b className="live-num"><i className="pulse" /> {online.size}</b><span>đang trực tuyến</span></div>
      </div>

      <div className="row" style={{ margin: '12px 0' }}>
        <button onClick={auto} title="Giao workbook nhỏ thứ 1 cho Nhân viên 1, thứ 2 cho Nhân viên 2…">Giao tuần tự</button>
        <button onClick={() => setDraft(Object.fromEntries(book.items.map((i) => [i.id, ''])))}>Bỏ hết</button>
        <button className="primary" disabled={busy || !total} onClick={save}>Lưu phân quyền{total ? ` (${total})` : ''}</button>
        <span className="grow" />
        <button disabled={busy} onClick={() => fileRef.current.click()}>Thêm từ .xlsx / .docx</button>
        <button disabled={busy} onClick={() => addBlank('excel')}>Thêm sheet trống</button>
        <button disabled={busy} onClick={() => addBlank('word')}>Thêm văn bản trống</button>
        <button disabled={busy} onClick={guard(() => api.download(`/books/${book.id}/export`, `${book.title}.xlsx`))}>Xuất bản hiện tại (.xlsx)</button>
        <input ref={fileRef} type="file" hidden accept=".xlsx,.docx" onChange={(e) => { addFile(e.target.files[0]); e.target.value = ''; }} />
      </div>

      <table className="list">
        <thead>
          <tr><th>Workbook nhỏ</th><th>Người được giao</th><th>Hạn nộp</th><th>Trạng thái</th><th>Cập nhật</th><th>Bảo vệ ô</th><th /></tr>
        </thead>
        <tbody>
          {book.items.map((it) => (
            <tr key={it.id}>
              <td>
                <a href="#/" className="linklike" onClick={(e) => { e.preventDefault(); onOpen(it.id); }}>
                  <span className={'mini ' + it.type}>{it.type === 'excel' ? 'X' : 'W'}</span> {it.name}
                </a>
                {online.has(it.id) && <span className="live-chip"> <i className="pulse" /> đang làm</span>}
              </td>
              <td>
                <select value={draft[it.id] ?? ''} onChange={(e) => setDraft({ ...draft, [it.id]: e.target.value })}>
                  <option value="">Chưa giao (admin sửa)</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </td>
              <td>
                <input type="datetime-local" value={dl[it.id] ?? ''} onChange={(e) => setDl({ ...dl, [it.id]: e.target.value })} disabled={!(draft[it.id] ?? '')} />
                {it.pastDue && !['submitted', 'approved'].includes(it.status) && <span className="late"> Quá hạn</span>}
              </td>
              <td><span className={'tag ' + it.status}>{STATUS[it.status]}</span></td>
              <td className="small">{it.updatedAt ? fmt(it.updatedAt) : '—'}{it.returnNote && <div className="late" title="Lý do đã trả lại">Đã trả lại: {it.returnNote}</div>}</td>
              <td className="small">{it.type === 'excel' ? (it.protectOn ? `${it.protectCount} ô được nhập` : 'Tắt') : '—'}</td>
              <td className="actions">
                <button onClick={() => onOpen(it.id)}>Xem</button>
                <button className="primary" onClick={() => onOpen(it.id)}>Sửa</button>
                {['submitted', 'approved'].includes(it.status) && <button onClick={() => verify(it)}>Xác minh</button>}
                {it.status === 'submitted' && <button className="primary" onClick={() => approve(it)}>Duyệt</button>}
                {['submitted', 'approved'].includes(it.status) && <button onClick={() => giveBack(it)}>Trả lại</button>}
                <button onClick={() => history(it)}>Lịch sử</button>
                <button onClick={() => exportItem(it)}>Tải</button>
                <button className="danger" onClick={() => remove(it)}>Xóa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small" style={{ marginTop: 10 }}>
        Người được giao chỉ nhìn thấy đúng workbook nhỏ của mình, hoàn toàn tách biệt: không có workbook lớn, sheet hay workbook nào khác.
        Nhấn "Xem" để theo dõi trực tiếp từng ô họ đang gõ. Khi họ nộp, bạn duyệt hoặc trả lại kèm lý do; bài đã nộp nằm sẵn trong workbook lớn này và được tổng hợp ở tab "Tổng hợp".
      </p>
      {modal && <Modal title={modal.title} onClose={() => setModal(null)}>{modal.body}</Modal>}
    </div>
  );
}

/* ================= Trang workbook lớn (admin) ================= */
export default function BookPage({ me, id }) {
  const [book, setBook] = useState(null);
  const [datas, setDatas] = useState({});
  const [online, setOnline] = useState(new Set());
  const [cursors, setCursors] = useState({});
  const [flashes, setFlashes] = useState({});
  const [users, setUsers] = useState([]);
  const [active, setActive] = useState('overview');
  const [error, setError] = useState('');
  const [toast, flash] = useToast();
  const datasRef = useRef({});

  const load = async () => {
    const [b, d] = await Promise.all([api.get('/books/' + id), api.get(`/books/${id}/data`)]);
    datasRef.current = d; setDatas(d); setBook(b); setOnline(new Set(b.online));
    setActive((a) => (a === 'overview' || a === 'consol' || b.items.some((i) => i.id === a) ? a : 'overview'));
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.get('/users').then((u) => setUsers(u.filter((x) => x.role === 'user')));
    live.connect();
    return live.sub({ t: 'sub', book: id }, { t: 'unsub', book: id });
  }, [id]); // eslint-disable-line

  const flashKeys = (item, keys) => {
    setFlashes((f) => ({ ...f, [item]: new Set([...(f[item] || []), ...keys]) }));
    setTimeout(() => setFlashes((f) => { const s = new Set(f[item]); keys.forEach((k) => s.delete(k)); return { ...f, [item]: s }; }), 1600);
  };
  const setItemData = (itemId, fn) => {
    const cur = datasRef.current[itemId]; if (!cur) return;
    datasRef.current = { ...datasRef.current, [itemId]: fn(cur) };
    setDatas(datasRef.current);
  };

  useLive((m) => {
    if (m.t === 'presenceAll') setOnline(new Set(m.online));
    else if (m.t === 'presence') {
      setOnline((s) => { const n = new Set(s); if (m.online) n.add(m.item); else n.delete(m.item); return n; });
      if (!m.online) setCursors((c) => { const n = { ...c }; delete n[m.item]; return n; });
    } else if (m.t === 'status') {
      setBook((b) => {
        if (!b) return b;
        if (!b.items.some((i) => i.id === m.item.id)) { load(); return b; }
        return { ...b, items: b.items.map((i) => (i.id === m.item.id ? m.item : i)) };
      });
    } else if (m.t === 'patch') {
      if (m.by === me.id) return;
      setItemData(m.item, (cur) => ({ ...cur, version: m.version, data: m.html !== undefined ? { html: m.html } : applyPatch(cur.data, m) }));
      if (m.patch) flashKeys(m.item, Object.keys(m.patch));
      setBook((b) => b && ({ ...b, items: b.items.map((i) => (i.id === m.item ? { ...i, updatedAt: new Date().toISOString() } : i)) }));
    } else if (m.t === 'sel') setCursors((c) => ({ ...c, [m.item]: { r: m.r, c: m.c, by: m.by, typing: m.typing } }));
    else if (m.t === 'protect') {
      setItemData(m.item, (cur) => ({ ...cur, protect: m.protect }));
      setBook((b) => b && ({ ...b, items: b.items.map((i) => (i.id === m.item ? { ...i, protectOn: m.protect.on, protectCount: Object.keys(m.protect.cells).length } : i)) }));
    } else if (m.t === 'book') load();
  });

  // dữ liệu mọi bảng tính để công thức tổng hợp chéo workbook nhỏ tính được theo thời gian thực
  const others = useMemo(() => (book ? Object.fromEntries(book.items.filter((i) => i.type === 'excel' && datas[i.id]).map((i) => [i.name, datas[i.id].data.cells])) : {}), [book, datas]);

  if (error) return <div className="wrap"><p className="err">{error}</p><button onClick={() => go('#/')}>Về trang chủ</button></div>;
  if (!book) return <div className="wrap muted">Đang tải…</div>;

  const it = book.items.find((i) => i.id === active);
  const d = it && datas[it.id];
  const editable = !!it && it.editable !== false;

  const sendEdit = (msg) => live.edit({ item: it.id, ...msg }).catch((e) => { flash(e.message); load(); });
  const onSheet = (nd) => {
    const df = diffGrid(d.data, nd);
    setItemData(it.id, (cur) => ({ ...cur, data: nd }));
    if (df) sendEdit(df);
  };
  const onWord = (html) => { setItemData(it.id, (cur) => ({ ...cur, data: { html } })); sendEdit({ html }); };
  const protectCall = async (body) => {
    try { const p = await api.put(`/items/${it.id}/protect`, body); setItemData(it.id, (cur) => ({ ...cur, protect: p })); }
    catch (e) { flash(e.message); }
  };

  const notice = !it ? '' : it.status === 'approved' ? `Đã duyệt (bài của ${it.assigneeName}): quản trị viên vẫn có thể chỉnh sửa` : it.status === 'submitted' ? `Đã nộp bởi ${it.assigneeName}, quản trị viên vẫn có thể chỉnh sửa`
    : it.assigneeId ? `Bài của ${it.assigneeName}${online.has(it.id) ? ' (đang trực tuyến)' : ''}: quản trị viên có thể chỉnh sửa`
      : 'Chưa giao: bạn có thể chỉnh sửa';

  return (
    <div className="docpage">
      <div className="titlebar excel">
        <button className="ghost" onClick={() => go('#/')}>Quay lại</button>
        <span className="doctitle-bar">{book.title}</span>
        <span className="savemsg">{book.items.filter((i) => ['submitted', 'approved'].includes(i.status)).length}/{book.items.filter((i) => i.assigneeId).length} đã nộp</span>
        <span className="grow" />
        <ConnDot />
        <button className="ghost" onClick={() => api.download(`/books/${book.id}/export`, `${book.title}.xlsx`).catch((e) => flash(e.message))}>Xuất hiện tại (.xlsx)</button>
      </div>

      <div className="docbody">
        {active === 'overview' ? (
          <Overview book={book} online={online} users={users} onOpen={setActive} reload={load} flash={flash} />
        ) : active === 'consol' ? (
          <Consolidation bookId={book.id} flash={flash} />
        ) : !it || !d ? <p className="wrap muted">Đang tải…</p> : it.type === 'excel' ? (
          <SheetPane key={it.id} id={it.id} editable={editable} notice={notice} admin protect={d.protect} assigned={!!it.assigneeId}>
            <Spreadsheet
              key={it.id} sheetName={it.name} data={d.data} others={others} editable={editable} restricted={false}
              protect={d.protect} remote={online.has(it.id) ? cursors[it.id] : null} flash={flashes[it.id]} notice={notice}
              protectUI={{ on: d.protect.on, onToggle: (on) => protectCall({ on }), onAllow: (keys) => protectCall({ allow: keys }), onDeny: (keys) => protectCall({ deny: keys }) }}
              onChange={onSheet}
            />
          </SheetPane>
        ) : (
          <WordPane key={it.id} id={it.id} html={d.data.html} editable={editable} restricted={false} notice={notice} onChange={onWord} />
        )}
      </div>

      <div className="tabsbar">
        <button className={'stab' + (active === 'overview' ? ' on' : '')} onClick={() => setActive('overview')}><b>Tổng quan</b></button>
        <button className={'stab' + (active === 'consol' ? ' on' : '')} onClick={() => setActive('consol')}><b>Tổng hợp</b></button>
        {book.items.map((i) => (
          <button key={i.id} className={'stab' + (active === i.id ? ' on' : '')} onClick={() => setActive(i.id)} title={deadlineText(i.deadline)}>
            <i className={'dot ' + i.status + (online.has(i.id) ? ' live' : '')} />
            {i.name}
            <small>{i.assigneeName || 'chưa giao'}</small>
          </button>
        ))}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
