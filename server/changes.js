// "Ô đã thay đổi": so bài của user (bản nộp / bản hiện tại) với mốc lúc giao bài.
const store = require('./store');
const { diffData } = require('./celldiff');

const MAX_LIST = 500;
const none = (why) => ({ base: null, note: why, total: 0, formatOnly: 0, truncated: false, list: [] });

function compare(type, baseSn, curData, label) {
  if (!baseSn || !baseSn.data || !curData) return none('Chưa có mốc để so sánh');
  return { base: label, baseAt: baseSn.at, ...diffData(type, baseSn.data, curData, MAX_LIST) };
}

// Một bản tổng hợp c: với từng workbook nhỏ đã đưa vào file và có người làm, liệt kê ô user đã đổi so với lúc giao.
// Bản tổng hợp cũ (trước khi có mốc lúc giao) thì so với lần tổng hợp liền trước của chính workbook đó.
function consolidationChanges(c) {
  const older = store.listConsolidations(c.bookId).filter((x) => x.n < c.n); // mới nhất trước
  const out = {};
  for (const row of c.manifest.items) {
    if (!row.included || !row.snapshotId) continue;
    if (!row.assignee) { out[row.itemId] = none('Workbook do admin quản lý, không có người làm'); continue; }
    let baseId = row.baseSnapshotId, label = 'lúc giao bài';
    if (!baseId) {
      for (const o of older) {
        const r = o.manifest.items.find((x) => x.itemId === row.itemId && x.included && x.snapshotId);
        if (r) { baseId = r.snapshotId; label = `bản tổng hợp v${o.n}`; break; }
      }
    }
    if (!baseId) { out[row.itemId] = none('Không có mốc so sánh (bài giao trước khi nâng cấp, chưa có bản tổng hợp trước)'); continue; }
    try { out[row.itemId] = compare(row.type, store.getSnapshot(baseId), store.getSnapshot(row.snapshotId)?.data, label); }
    catch { out[row.itemId] = none('Không đọc được bản chụp'); }
  }
  return out;
}

// Một workbook nhỏ đang xem: bản đã nộp (nếu đã nộp) hoặc bản hiện tại, so với lúc giao
function itemChanges(it, final) {
  if (!it.assigneeId) return none('Workbook chưa giao cho ai');
  if (!it.baseSnapshotId) return none('Không có mốc lúc giao (bài giao trước khi nâng cấp)');
  const cur = final && it.submitSnapshotId ? store.getSnapshot(it.submitSnapshotId)?.data : it.data;
  return { ...compare(it.type, store.getSnapshot(it.baseSnapshotId), cur, 'lúc giao bài'), submitted: !!(final && it.submitSnapshotId) };
}

module.exports = { consolidationChanges, itemChanges };
