// Làm sạch HTML của văn bản Word trước khi chuyển sang .docx.
// Quan trọng: thư viện chuyển đổi sẽ TỰ TẢI ảnh theo đường dẫn http(s) trong HTML (rủi ro SSRF: người dùng có thể ép máy chủ
// gọi vào mạng nội bộ). Ở đây chỉ giữ ảnh nhúng sẵn dạng data:image/..., mọi ảnh/tài nguyên ngoài đều bị bỏ.
const DANGEROUS = /<\s*(script|style|iframe|object|embed|link|meta|base|form|svg|math)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi;

function safeHtmlForDocx(html) {
  let h = String(html || '');
  h = h.replace(DANGEROUS, '');
  h = h.replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form|svg|math)\b[^>]*>/gi, '');
  h = h.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');                 // onclick=, onerror=...
  h = h.replace(/\s(href|src|xlink:href|background|poster|data)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
  h = h.replace(/<\s*img\b[^>]*>/gi, (tag) => (/\bsrc\s*=\s*["']?\s*data:image\/(png|jpe?g|gif|webp);base64,/i.test(tag) ? tag : ''));
  h = h.replace(/url\s*\(\s*["']?\s*(https?:|\/\/|file:)[^)]*\)/gi, 'none');          // ảnh nền CSS từ bên ngoài
  return h;
}
module.exports = { safeHtmlForDocx };
