export const POLICY_VERSION = '1.0';
export const POLICY_STORAGE_KEY = `office-internal-policy-${POLICY_VERSION}`;

export const POLICY_SECTIONS = [
  {
    title: '1. Thông tin được bảo mật',
    items: [
      'Thông tin khách hàng, người mua nước ngoài và nhà cung cấp.',
      'Hợp đồng, báo giá, bảng giá, chứng từ xuất khẩu.',
      'Số liệu tài chính, giá vốn, công nợ, kế hoạch kinh doanh.',
      'Quy trình sản xuất, công nghệ chưa công bố.',
      'Thông tin nhân sự và dữ liệu cá nhân.',
    ],
  },
  {
    title: '2. Nguyên tắc sử dụng',
    items: [
      'Chỉ truy cập thông tin phục vụ công việc được giao.',
      'Không chia sẻ thông tin mật ra ngoài khi chưa được phép, kể cả email cá nhân, mạng xã hội, ứng dụng nhắn tin, dịch vụ lưu trữ hoặc công cụ AI công cộng.',
      'Không dùng chung tài khoản và mật khẩu.',
      'Đặt mật khẩu cho file nhạy cảm và cất giữ tài liệu mật an toàn.',
    ],
  },
  {
    title: '3. Chữ ký nháy và phân quyền',
    items: [
      'Không làm lộ nội dung văn bản, hợp đồng, báo giá đang ký nháy hoặc chưa được ban hành.',
      'Không cho mượn hay sử dụng chữ ký nháy, chữ ký, chữ ký số, con dấu của mình hoặc của người khác.',
      'Không tự ý cấp, mở rộng, chia sẻ quyền truy cập hoặc truy cập vượt quyền được phân.',
    ],
  },
  {
    title: '4. File và cuộc trò chuyện',
    items: [
      'Không gửi, sao chép, chụp màn hình file Excel, Word chứa thông tin mật ra ngoài hệ thống của Công ty.',
      'Không chuyển tiếp nội dung trao đổi công việc cho người không có thẩm quyền.',
      'Không tự ý xóa hoặc làm mất cuộc trò chuyện, tin nhắn, file liên quan đến công việc; mất thiết bị phải báo ngay.',
    ],
  },
  {
    title: '5. Thẩm quyền cung cấp thông tin',
    items: [
      'Chỉ Ban Giám đốc và cán bộ được ủy quyền bằng văn bản mới được cung cấp thông tin của Công ty cho bên ngoài.',
      'Nhân viên khác nhận được yêu cầu phải chuyển cho người có thẩm quyền.',
    ],
  },
  {
    title: '6. Xử lý vi phạm',
    items: [
      'Báo ngay cho quản lý và bộ phận IT khi phát hiện hoặc nghi ngờ lộ lọt thông tin.',
      'Vi phạm bị xử lý kỷ luật theo nội quy lao động và Bộ luật Lao động 2019, có thể đến sa thải.',
      'Gây thiệt hại phải bồi thường; có dấu hiệu tội phạm sẽ chuyển cơ quan có thẩm quyền xử lý theo pháp luật.',
    ],
  },
  {
    title: '7. Hiệu lực',
    items: [
      'Có hiệu lực kể từ khi bạn nhấn Đồng ý.',
      'Nghĩa vụ bảo mật vẫn tiếp tục sau khi chấm dứt hợp đồng lao động, trong thời hạn nêu tại cam kết bảo mật đã ký.',
    ],
  },
];
