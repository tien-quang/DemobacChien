# DemobacChien

# Office nội bộ v5: workflow chuẩn workbook lớn > workbook nhỏ > giao > làm > nộp > duyệt > tổng hợp

## Workflow (đã kiểm thử tự động từng bước)

    ADMIN                                         USER
    1. Tải lên nhiều file (mỗi .xlsx = 1 workbook lớn,
       mỗi sheet = 1 workbook nhỏ; .docx = văn bản)
    2. Quản lý workbook nhỏ trong từng workbook lớn
       (thêm, đổi tên, xóa, đặt khóa ô, hạn nộp)
    3. Giao 1 hoặc NHIỀU workbook nhỏ cho 1 user  ──►  4. Thấy đúng danh sách workbook được giao,
                                                          mở từng cái trong cửa sổ độc lập, chỉ có bảng đó
                                                       5. Chỉnh sửa (Excel hoặc Word); chỉ được trỏ vào
                                                          workbook được giao, mọi workbook khác = 404
    7. Theo dõi trực tiếp (con trỏ, chữ đang gõ)   ◄──  6. Bấm "Nộp bài": khóa lại, ký số, bản chụp bất biến
    8. DUYỆT, hoặc TRẢ LẠI kèm lý do  ───────────►  quay lại bước 5 (user thấy lý do)
    9. Bài đã nộp/duyệt nằm trong đúng workbook lớn của admin; "Tổng hợp" gom thành file có phiên bản
       (.xlsx cho bảng tính, .docx cho văn bản)

Trạng thái: Chưa giao > Đã giao > Đang làm > Đã nộp (chờ duyệt) > Đã duyệt. Trả lại đưa về "Đang làm".
Tổng hợp có 3 chế độ: bài đã nộp và đã duyệt (mặc định, tự chạy khi có người nộp), chỉ bài đã duyệt, gồm cả bản nháp.

## Chạy

Yêu cầu Node.js 22.13 trở lên (dùng SQLite có sẵn của Node).

    npm run setup     # cài thư viện (1 lần)
    npm run build     # build giao diện
    npm start         # mở http://localhost:4000
    npm test          # 140 kiểm tra tự động

Mỗi tab trình duyệt có một session slot riêng (lưu trong `sessionStorage`), vì vậy có thể mở
admin và user đồng thời trên cùng trình duyệt. Không dùng bản sao tab đang giữ nguyên session slot;
hãy mở tab mới hoặc cửa sổ ẩn danh khác.

Tài khoản demo: admin / admin123, user1 đến user10 / user123.

## Kịch bản demo workflow (6 phút)

1. Admin: chọn cùng lúc 2 file .xlsx (có file mẫu tinh-luong-mau.xlsx) hoặc bấm "Tạo 2 workbook mẫu": ra 2 workbook lớn.
2. Mở 1 workbook lớn, tab Tổng quan: "Giao tuần tự" hoặc tự chọn (cho 1 người nhiều workbook nhỏ), đặt hạn nộp, Lưu.
3. Cửa sổ ẩn danh, đăng nhập user: thấy danh sách các workbook được giao, mở từng cái; thử đổi số trong URL sang workbook khác: bị chặn.
4. Hai cửa sổ cạnh nhau: admin bấm vào workbook nhỏ đó, thấy con trỏ và chữ user đang gõ theo thời gian thực.
5. User "Nộp bài". Admin thấy chuyển "Chờ duyệt": bấm "Trả lại" kèm lý do. User thấy khung đỏ ghi lý do, sửa và nộp lại. Admin "Duyệt".
6. Tab "Tổng hợp": bản mới có sẵn, tải .xlsx / .docx, "So với bản trước" xem ô nào đã đổi.

## Mô hình lưu trữ và bảo mật

Giữ nguyên v4: SQLite, sheet chia khối 200 dòng mã hóa riêng, nhật ký thao tác có phục hồi sau sập máy, mã hóa theo lớp khóa + đổi khóa,
bản chụp bài nộp bất biến, hàng đợi việc + worker dựng file, liên kết tải ký sẵn 5 phút, cách ly từng workbook nhỏ, khóa ô, phiên HttpOnly,
2FA, nhật ký chuỗi băm. Mới ở v5: khâu duyệt/trả lại (có lưu lịch sử và lý do), Word tổng hợp thành .docx, liên kết tải ký sẵn gắn với loại file,
và vá lỗ hổng SSRF khi xuất Word (ảnh trỏ ra ngoài không bị máy chủ tự tải; script, iframe, sự kiện onXXX bị loại).

## Giới hạn cần nói thật

- Bản 1 máy chủ (SQLite). Chưa có Redis (nhiều máy chủ WebSocket), KMS thật, SSO, PostgreSQL với bảo vệ theo dòng: giai đoạn 3 và 4.
- Chưa có chức năng chuyển workbook nhỏ sang workbook lớn khác (cần mã hóa lại dữ liệu theo khóa của workbook lớn đích).
- "Đẩy về workbook lớn": workbook nhỏ vốn nằm trong workbook lớn từ lúc tạo; khi nộp, bản chụp bất biến được chốt và đưa vào bản tổng hợp.
- Word dùng trình soạn thảo trình duyệt (văn bản thường). Excel nhập vào mất biểu đồ, ảnh, ô gộp, macro.
- Không ngăn được chụp màn hình (có watermark + nhật ký). Chưa thử tải nhiều người dùng đồng thời.
- Đã kiểm thử bằng trình duyệt giả lập (jsdom) và máy chủ thật; chưa kiểm tra hiển thị trên trình duyệt thật.

## Cấu trúc

    server/core.js        quyền, sửa, nộp, duyệt, trả lại, khóa ô, xác minh      server/store.js     SQLite, khối, bản chụp, hàng đợi, mã hóa
    server/consolidate.js tổng hợp .xlsx + .docx                                 server/docsafe.js   làm sạch HTML trước khi xuất Word
    server/index.js       API                                                    server/live.js      WebSocket thời gian thực
    client/src/BookPage.jsx admin: tổng quan, duyệt/trả lại, theo dõi trực tiếp  client/src/ItemPage.jsx user: workbook độc lập
