// Plugin "Quản trị ô" (ONLYOFFICE Spreadsheet). Chạy trong khung plugin của editor; trang ứng dụng (cùng origin với trang plugin) nhận lệnh.
(function (window) {
  var P = window.Asc.plugin;
  var ITEM = (String(window.location.pathname).match(/\/oo-plugin\/([^/]+)\//) || [])[1];
  var MAXR = 2000, MAXC = 60, MAXKEYS = 60000;

  function button(id, text, hint) {
    return { id: id, type: 'button', text: text, hint: hint, lockInViewMode: false, enableToggle: false, separator: false };
  }
  function toolbar() {
    return {
      guid: P.info.guid,
      tabs: [{
        id: 'qtri_o', text: 'Quản trị ô',
        items: [
          button('oo_allow', 'Cho phép nhập', 'Cho phép nhân viên nhập các ô đang chọn (tự bật bảo vệ)'),
          button('oo_lock', 'Khóa ô', 'Khóa các ô đang chọn: nhân viên không sửa được (tự bật bảo vệ)'),
          button('oo_hide', 'Ẩn ô', 'Ẩn nội dung các ô đang chọn khỏi nhân viên'),
          button('oo_show', 'Hiện ô', 'Cho nhân viên thấy lại các ô đang chọn'),
          button('oo_on', 'Bật bảo vệ', 'Chỉ các ô được cho phép nhập mới sửa được'),
          button('oo_off', 'Tắt bảo vệ', 'Nhân viên sửa được mọi ô (ô ẩn vẫn ẩn)')
        ]
      }]
    };
  }

  function colNum(s) { var n = 0; for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n; }
  // "A1", "A1:C5", "A:C", "2:5", "Sheet1!$A$1:$B$2", nhiều vùng cách nhau dấu phẩy -> danh sách khóa "dòng,cột" (đếm từ 0)
  function keysOf(addr) {
    var keys = [];
    String(addr || '').split(',').forEach(function (area) {
      var a = area.replace(/\$/g, '').replace(/^.*!/, '').trim();
      if (!a) return;
      var ends = a.split(':').map(function (x) {
        var q = /^([A-Za-z]*)(\d*)$/.exec(x.trim());
        return q ? { c: q[1] ? colNum(q[1].toUpperCase()) : null, r: q[2] ? parseInt(q[2], 10) : null } : null;
      });
      if (!ends[0] || (ends[1] === null)) return;
      var e1 = ends[0], e2 = ends[1] || ends[0];
      var r1 = Math.min(e1.r || 1, e2.r || e1.r || 1), r2 = e1.r || e2.r ? Math.max(e1.r || 1, e2.r || e1.r || 1) : MAXR;
      var c1 = Math.min(e1.c || 1, e2.c || e1.c || 1), c2 = e1.c || e2.c ? Math.max(e1.c || 1, e2.c || e1.c || 1) : MAXC;
      if (e1.r === null && e2.r === null) { r1 = 1; r2 = MAXR; }
      if (e1.c === null && e2.c === null) { c1 = 1; c2 = MAXC; }
      r2 = Math.min(r2, MAXR); c2 = Math.min(c2, MAXC);
      for (var r = r1; r <= r2 && keys.length < MAXKEYS; r++) for (var c = c1; c <= c2 && keys.length < MAXKEYS; c++) keys.push((r - 1) + ',' + (c - 1));
    });
    return keys;
  }

  function send(action, keys, addr) {
    try {
      window.top.postMessage({ src: 'oo-cell-admin', item: ITEM, action: action, keys: keys || [], area: addr || '' }, window.location.origin);
    } catch (e) { /* không gửi được: trang ứng dụng sẽ không nhận lệnh */ }
  }
  function withSelection(action) {
    P.callCommand(function () {
      var sheet = Api.GetActiveSheet();
      var sel = sheet.GetSelection();
      return sel.GetAddress(false, false, 'xlA1', false);
    }, false, false, function (addr) { send(action, keysOf(addr), addr); });
  }

  P.init = function () {
    this.executeMethod('AddToolbarMenuItem', [toolbar()]);
  };
  P.event_onToolbarMenuClick = function (id) {
    if (id === 'oo_allow') withSelection('allow');
    else if (id === 'oo_lock') withSelection('lock');
    else if (id === 'oo_hide') withSelection('hide');
    else if (id === 'oo_show') withSelection('show');
    else if (id === 'oo_on') send('on');
    else if (id === 'oo_off') send('off');
  };
})(window);
