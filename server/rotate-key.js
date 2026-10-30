// Đổi khóa chủ: chỉ bọc lại khóa dữ liệu của từng workbook lớn, KHÔNG phải mã hóa lại dữ liệu.
//   DATA_KEY=<khóa cũ> NEW_KEY=<64 ký tự hex mới> npm run rotate-key
// (Dùng khóa từ data/.key thì bỏ DATA_KEY; file .key sẽ được cập nhật.) Dừng server trước khi chạy.
const store = require('./store');

const k = process.env.NEW_KEY;
if (!/^[0-9a-f]{64}$/i.test(k || '')) {
  console.error('Thiếu NEW_KEY (64 ký tự hex). Tạo khóa: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
const src = store.rotateMasterKey(k);
console.log(src === 'file' ? 'Đã đổi khóa và cập nhật data/.key.' : 'Đã đổi khóa. Hãy đặt DATA_KEY=<khóa mới> trong cấu hình rồi khởi động lại server.');
process.exit(0);
