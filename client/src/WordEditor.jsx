import React, { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Watermark } from './Spreadsheet.jsx';

const clean = (html) => DOMPurify.sanitize(html || '', { USE_PROFILES: { html: true } });

export default function WordEditor({ html, editable, restricted, watermark, notice, onChange }) {
  const ref = useRef(null);
  const timer = useRef(null);
  const [words, setWords] = useState(0);

  const countWords = () => {
    const t = (ref.current?.innerText || '').trim();
    setWords(t ? t.split(/\s+/).length : 0);
  };

  // Nội dung luôn qua DOMPurify trước khi hiển thị (chống XSS giữa các tài khoản)
  useEffect(() => {
    ref.current.innerHTML = clean(html);
    countWords();
  }, [editable, html && !editable ? html : null]); // eslint-disable-line

  const emit = () => {
    countWords();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(clean(ref.current.innerHTML)), 400);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const cmd = (name, arg) => {
    if (!editable) return;
    ref.current.focus();
    document.execCommand(name, false, arg);
    emit();
  };
  const block = (e) => { if (restricted) e.preventDefault(); };
  const onPaste = (e) => {
    e.preventDefault();
    if (!editable) return;
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    emit();
  };
  const insertTable = () => {
    const cell = '<td style="border:1px solid #999;padding:6px;min-width:60px">&nbsp;</td>';
    const row = `<tr>${cell.repeat(3)}</tr>`;
    cmd('insertHTML', `<table style="border-collapse:collapse;width:100%"><tbody>${row.repeat(3)}</tbody></table><p><br></p>`);
  };
  const dis = !editable;
  const keep = (e) => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') e.preventDefault(); };

  return (
    <div className="word">
      <div className="ribbon" onMouseDown={keep}>
        <button disabled={dis} onClick={() => cmd('undo')}>Hoàn tác</button>
        <button disabled={dis} onClick={() => cmd('redo')}>Làm lại</button>
        <span className="sep" />
        <select disabled={dis} defaultValue="P" onChange={(e) => cmd('formatBlock', e.target.value)} title="Kiểu đoạn">
          <option value="P">Văn bản thường</option>
          <option value="H1">Tiêu đề 1</option>
          <option value="H2">Tiêu đề 2</option>
          <option value="H3">Tiêu đề 3</option>
        </select>
        <button disabled={dis} onClick={() => cmd('bold')}><b>B</b></button>
        <button disabled={dis} onClick={() => cmd('italic')}><i>I</i></button>
        <button disabled={dis} onClick={() => cmd('underline')}><u>U</u></button>
        <button disabled={dis} onClick={() => cmd('strikeThrough')}><s>S</s></button>
        <label className="color" title="Màu chữ">A
          <input type="color" disabled={dis} defaultValue="#000000" onChange={(e) => cmd('foreColor', e.target.value)} />
        </label>
        <label className="color" title="Tô nền chữ">Nền
          <input type="color" disabled={dis} defaultValue="#ffff00" onChange={(e) => cmd('hiliteColor', e.target.value)} />
        </label>
        <span className="sep" />
        <button disabled={dis} onClick={() => cmd('justifyLeft')}>Trái</button>
        <button disabled={dis} onClick={() => cmd('justifyCenter')}>Giữa</button>
        <button disabled={dis} onClick={() => cmd('justifyRight')}>Phải</button>
        <button disabled={dis} onClick={() => cmd('insertUnorderedList')}>Gạch đầu dòng</button>
        <button disabled={dis} onClick={() => cmd('insertOrderedList')}>Đánh số</button>
        <button disabled={dis} onClick={insertTable}>Chèn bảng</button>
        <button disabled={dis} onClick={() => cmd('removeFormat')}>Xóa định dạng</button>
        {notice && <span className="notice">{notice}</span>}
      </div>
      <div className="pagearea">
        <div className="pagewrap">
          <div
            ref={ref}
            className="page"
            contentEditable={editable}
            suppressContentEditableWarning
            spellCheck={false}
            onInput={emit}
            onPaste={onPaste}
            onCopy={block}
            onCut={block}
            onContextMenu={block}
            onDragStart={block}
            onDrop={(e) => e.preventDefault()}
          />
          {watermark && <Watermark text={watermark} />}
        </div>
      </div>
      <div className="statusbar"><span>{words} từ</span><span>{editable ? 'Đang chỉnh sửa' : 'Chỉ xem'}</span></div>
    </div>
  );
}
