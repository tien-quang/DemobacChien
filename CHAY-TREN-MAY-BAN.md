# Chạy 100% trên máy bạn

Yêu cầu: Node.js 22.13+, Docker Desktop.

- Windows: chuột phải `start-local.ps1` > Run with PowerShell (hoặc `powershell -ExecutionPolicy Bypass -File start-local.ps1`)
- Linux/Mac: `./start-local.sh`

Sau đó mở http://localhost:4000 (admin / admin123).

Dữ liệu: thư mục `server/data/` (office.db, blobs, .key). Sao lưu cả thư mục này, mất `.key` là không giải mã được.
ONLYOFFICE chỉ là engine soạn thảo (Docker, cổng 8080); file lưu về máy bạn qua callback http://host.docker.internal:4000.
Không dùng render.yaml nếu không muốn đưa lên server bên ngoài.

Dùng trong mạng LAN: đổi ONLYOFFICE_URL trong .env thành http://IP-LAN-may-ban:8080 và truy cập web qua http://IP-LAN-may-ban:4000.
