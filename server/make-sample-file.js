// Tạo file Excel mẫu (nhiều sheet) để thử chức năng tải lên: npm run sample
const fs = require('fs');
const path = require('path');
const { payrollBook } = require('./sample');
const { exportXlsx } = require('./excel');

(async () => {
  const b = payrollBook();
  const parts = b.items.filter((i) => i.type === 'excel').map((i) => ({ name: i.name, data: i.data }));
  const out = path.join(__dirname, '..', 'tinh-luong-mau.xlsx');
  fs.writeFileSync(out, Buffer.from(await exportXlsx({ parts })));
  console.log('Đã tạo', out);
})();
