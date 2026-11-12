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
    npm test          # 141 kiểm tra tự động

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

## Soạn thảo Word bằng ONLYOFFICE (tùy chọn)

Mặc định văn bản Word dùng trình soạn thảo đơn giản trong trình duyệt. Đặt 3 biến môi trường dưới đây thì mọi workbook nhỏ loại Word
mở bằng ONLYOFFICE Docs (giao diện giống Word: định dạng, bảng, ảnh, mục lục...). Không đặt thì mọi thứ chạy như cũ.

    cp .env.example .env            # sửa ONLYOFFICE_JWT_SECRET thành chuỗi ngẫu nhiên dài
    docker compose --env-file .env up -d      # Document Server tại http://localhost:8080
    # nạp biến môi trường rồi chạy ứng dụng, ví dụ (Linux/Mac):
    set -a; . ./.env; set +a; npm start
    # Windows PowerShell: đặt $env:ONLYOFFICE_URL=...; $env:ONLYOFFICE_APP_URL=...; $env:ONLYOFFICE_JWT_SECRET=...; npm start

Cách hoạt động: dữ liệu vẫn là HTML trong workbook nhỏ. Khi mở, máy chủ đổi HTML thành .docx và đưa cho Document Server qua liên kết ký sẵn (10 phút).
Khi lưu (đóng tài liệu hoặc tự lưu), Document Server gọi `/oo/callback/...` kèm JWT; máy chủ đổi .docx về HTML và ghi qua `core.applyEdit`,
nên quyền sửa, hạn nộp, trạng thái đã nộp, nhật ký thao tác và WebSocket cho admin vẫn như cũ. Bấm "Nộp bài" sẽ ép Document Server lưu phần chưa lưu trước khi chốt bản nộp.

- Bản Community giới hạn 20 kết nối đồng thời theo giấy phép của hãng. Cần nhiều hơn thì mua giấy phép Developer/Enterprise; code không đổi.
- Vì lưu lại dưới dạng HTML nên một số định dạng nâng cao của Word (phông riêng, mục lục, chú thích, đầu trang/chân trang) có thể mất khi lưu. Đây là giới hạn của mô hình dữ liệu HTML hiện tại.
- Production: đặt cả ứng dụng và Document Server sau HTTPS, dùng JWT secret riêng, không mở cổng 8080 ra Internet nếu không cần.
- Kiểm thử: `npm run test:oo` (34 kiểm tra với Document Server giả: JWT, liên kết ký sẵn, chống SSRF, quyền sau khi nộp, ép lưu khi nộp).

## Excel bằng ONLYOFFICE (user)

Khi ONLYOFFICE đã bật (3 biến môi trường như phần Word), user mở workbook nhỏ loại Excel bằng ONLYOFFICE Spreadsheet Editor.
Dữ liệu vẫn là các ô JSON trong workbook nhỏ: khi mở, máy chủ xuất `.xlsx`; khi lưu, máy chủ nhập `.xlsx` về, so với bản đã đưa lúc mở
và chỉ áp phần ô user đã đổi qua `core.applyEdit` (quyền, hạn nộp, trạng thái đã nộp, nhật ký, WebSocket cho admin đều như cũ).

- Ô bị khóa: ONLYOFFICE không biết ô nào bị khóa, nên ô khóa user lỡ sửa sẽ bị máy chủ bỏ (ghi nhật ký `oo_locked_reverted`) và trở lại giá trị cũ khi mở lại.
- Admin vẫn dùng bảng tính tự viết (có giao diện khóa ô, con trỏ trực tiếp, công thức liên sheet). Chữ user đang gõ trong ONLYOFFICE chỉ tới admin khi ONLYOFFICE lưu (nút Lưu, tự lưu khi đóng, hoặc khi bấm Nộp bài), không hiện từng phím.
- Chỉ lấy sheet đầu tiên; sheet user thêm trong ONLYOFFICE bị bỏ. Biểu đồ, ảnh, ô gộp, macro mất khi lưu (giới hạn của mô hình ô hiện tại).
- Giao diện: thanh ribbon đầy đủ kiểu MS Office, chủ đề Classic Light (đổi `uiTheme` trong `server/onlyoffice.js` nếu muốn). Công thức do bộ tính của ONLYOFFICE xử lý (hầu hết hàm Excel; không phải 100% giống Microsoft Excel).
- Giữ định dạng Office: file `.docx`/`.xlsx` gốc do ONLYOFFICE gửi về được lưu nguyên (mã hóa như blob khác) và dùng lại khi mở, miễn dữ liệu chưa bị đổi bằng đường khác (admin sửa bằng bảng tính tự viết, ô khóa bị hoàn lại...). Khi lệch, hệ thống tự dựng lại file từ dữ liệu (mất đầu trang, mục lục, biểu đồ, ô gộp). Bản tổng hợp luôn dựng từ dữ liệu ô/HTML nên không có các thành phần đó.
- Admin: Excel mở mặc định bằng giao diện Office, có nút chuyển sang "Khóa ô và theo dõi trực tiếp" (bảng tính tự viết).
- Kiểm thử: `npm run test:oo` (57 kiểm tra, gồm Excel và giữ file gốc).

## Quản trị ô ngay trong giao diện ONLYOFFICE (admin)

- Khi admin mở Excel bằng ONLYOFFICE, ribbon có thêm tab **Quản trị ô** (plugin ở `server/oo-plugin*`, cần ONLYOFFICE Docs 8.1 trở lên): **Cho phép nhập**, **Khóa ô**, **Ẩn ô**, **Hiện ô**, **Bật/Tắt bảo vệ**, áp lên vùng đang chọn. Plugin chỉ gửi `postMessage` lên trang ứng dụng (cùng origin); trang đó gọi `PUT /api/items/:id/protect` bằng phiên của admin.
- **Khóa ô**: file user nhận có bảo vệ sheet kiểu Excel (mật khẩu ngẫu nhiên của máy chủ), chỉ ô được cho phép mới sửa được, user không có tab Bảo vệ. Máy chủ vẫn kiểm lại khi lưu (ô khóa bị hoàn lại, ghi nhật ký `oo_locked_reverted`).
- **Ẩn ô** = ẩn nội dung: máy chủ gỡ giá trị và công thức của ô ẩn khỏi file và dữ liệu gửi cho user (kể cả bảng tính cũ), và bỏ mọi thay đổi của user vào ô đó khi lưu. Công thức của user trỏ vào ô ẩn sẽ tính ra giá trị sai trên màn hình user; giá trị đúng vẫn nằm ở máy chủ.
- **Realtime**: mỗi lần admin đổi quyền, quyền có số `rev` mới; trang user nhận qua WebSocket, ép ONLYOFFICE lưu phần đang gõ rồi tải lại bảng tính với quyền mới. Admin và user mở 2 phiên ONLYOFFICE riêng (file khác nhau), không còn đồng soạn chung 1 phiên với Excel.
- Khi workbook đang khóa/ẩn ô thì không giữ file `.xlsx` gốc (biểu đồ, ô gộp) vì file của user là bản đã bảo vệ.

## Theo dõi user làm việc trực tiếp (admin)

- Admin mở Excel đã giao: nút **Xem user làm (trực tiếp)** (mặc định khi workbook đã có người được giao) vào ĐÚNG phiên ONLYOFFICE mà user đang sửa, ở chế độ **Live Viewer** (ONLYOFFICE 7.2 trở lên): thấy từng ký tự, con trỏ và tên người đang sửa ngay khi họ gõ. Admin thấy đúng bản user thấy (ô ẩn hiển thị trống). Nút **Giao diện Office (sửa)** để admin tự sửa bản đầy đủ, **Khóa ô và theo dõi** là bảng tính tự viết cũ (khóa ô bằng giao diện cũ, các ô đổi nháy sáng).
- Mọi phiên cùng vai trò dùng chung 1 khóa phiên cho tới khi Document Server báo đóng; co-editing luôn ở chế độ nhanh (`coEditing: { mode: 'fast', change: false }`).
- **Tự lưu định kỳ** mỗi 5 giây (`OO_AUTOSAVE_SECONDS`, đặt 0 để tắt): dữ liệu ở máy chủ, bảng tính theo dõi của admin và bản nộp luôn mới, kể cả khi user tắt trình duyệt đột ngột. Mỗi lần lưu đều đi qua `core.applyEdit` nên nhật ký có nhiều dòng `oo_save` hơn.


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
