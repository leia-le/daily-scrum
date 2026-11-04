# Daily Scrum — bản chạy trên trình duyệt

App phân tích buổi Daily Scrum từ file ghi âm. Chạy hoàn toàn trên trình duyệt của người dùng:

- Không có máy chủ, người triển khai không nhận dữ liệu của ai.
- Key và dữ liệu được mã hóa AES-256-GCM bằng mật khẩu người dùng tự đặt.
- Đồng bộ giữa các thiết bị qua thư mục ẩn của app trong Google Drive của chính người dùng (tùy chọn).
- Trình duyệt bị khóa cứng, chỉ được gửi dữ liệu tới API của OpenAI, Google Gemini, Anthropic và Google Drive.

## Bộ file

| File | Vai trò |
| --- | --- |
| `index.html` | Giao diện và chính sách bảo mật nội dung (CSP) |
| `app.js` | Toàn bộ logic: mã hóa, lưu trữ, kết nối AI, phân tích, đồng bộ, sao lưu |
| `styles.css` | Giao diện, tự đổi theo chế độ sáng/tối |
| `config.js` | Cấu hình của người triển khai: Google Client ID, thời gian tự khóa |
| `blog-snippet.html` | Đoạn giới thiệu kèm link để dán vào WordPress |

## Phần 1. Đưa app lên GitHub Pages (miễn phí)

Làm được hoàn toàn trên trình duyệt, kể cả iPad.

1. Tạo tài khoản tại https://github.com và **bật xác thực 2 bước** (Settings → Password and authentication). Đây là bước bảo mật quan trọng nhất: ai chiếm được tài khoản này là sửa được code mà mọi người đang dùng.
2. Bấm **New repository**, đặt tên `daily-scrum`, chọn **Public**, bấm **Create repository**.
3. Bấm **uploading an existing file**, kéo thả 4 file `index.html`, `app.js`, `styles.css`, `config.js`, rồi bấm **Commit changes**.
4. Vào **Settings → Pages**. Ở mục Source chọn **Deploy from a branch**, branch **main**, thư mục **/ (root)**, bấm **Save**.
5. Sau 1–2 phút, app chạy tại `https://<tên-tài-khoản>.github.io/daily-scrum/`.

Đến đây app đã dùng được, có sao lưu bằng file. Phần 2 bật thêm đồng bộ qua Google Drive.

Muốn dùng tên miền riêng như `scrum.<blog-cua-chi>.com`: vào Settings → Pages → Custom domain, rồi thêm bản ghi CNAME trỏ về `<tên-tài-khoản>.github.io` ở nơi quản lý tên miền. Nên dùng tên miền phụ riêng cho app, tách khỏi blog WordPress.

## Phần 2. Tạo Google Client ID để bật đồng bộ

1. Vào https://console.cloud.google.com, tạo project mới, ví dụ `Daily Scrum`.
2. **APIs & Services → Library**, tìm **Google Drive API**, bấm **Enable**.
3. **Google Auth Platform** (hoặc OAuth consent screen):
   - Loại người dùng: **External**.
   - Tên app: `Daily Scrum`. Email hỗ trợ: email của chị. Có thể thêm link trang chủ là link app.
   - Mục **Data access / Scopes**: thêm đúng một quyền `https://www.googleapis.com/auth/drive.appdata`. Quyền này chỉ cho app đọc ghi thư mục ẩn của chính nó, không thấy file nào khác của người dùng.
   - Mục **Audience**: bấm **Publish app** để chuyển sang In production. Nếu để chế độ Testing, chỉ người có tên trong danh sách test dùng được và phải đăng nhập lại mỗi 7 ngày.
4. **Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: thêm `https://<tên-tài-khoản>.github.io` (và tên miền riêng nếu có). Không cần Redirect URI.
5. Sao chép **Client ID** (dạng `xxxx.apps.googleusercontent.com`).
6. Trên GitHub, mở `config.js` → biểu tượng bút chì → dán vào `GOOGLE_CLIENT_ID: '...'` → **Commit changes**.

Client ID không phải bí mật, để công khai trong code là bình thường.

Lưu ý: quyền `drive.appdata` là quyền hẹp, nhưng Google vẫn có thể yêu cầu xác minh thông tin app (tên, logo, trang chính sách quyền riêng tư) trước khi bỏ hẳn cảnh báo. Có thể dùng phần "Dữ liệu được xử lý thế nào" trong app làm nội dung trang chính sách quyền riêng tư.

## Phần 3. Giới thiệu trên blog WordPress

Dán `blog-snippet.html` vào khối **HTML tùy chỉnh** của một bài viết hoặc trang, thay `APP_URL` bằng link app.

Nên đặt **link mở app**, không nên nhúng iframe. Trên Safari (iPad, iPhone), bộ nhớ của trang nhúng trong trang khác bị tách riêng hoặc tự xóa, nên dữ liệu không ổn định. Mở app trực tiếp thì không gặp vấn đề này.

## Người dùng sử dụng thế nào

1. Mở link app, đặt mật khẩu bảo vệ dữ liệu.
2. Màn hình **Kết nối AI** chỉ hiện lần đầu: chọn ChatGPT hoặc Gemini cho bước chuyển giọng nói, và ChatGPT, Gemini hoặc Claude cho bước phân tích; làm theo hướng dẫn hiện ra để lấy key; bấm **Lưu và kiểm tra kết nối**; bấm **Hoàn tất**.
3. Thêm team ở thẻ **Team**.
4. Thẻ **Phân tích**: chọn team, chọn file ghi âm, bấm **Phân tích**.
5. Thẻ **Hôm nay**: tổng hợp các team, impediment đang mở, thành viên thiếu nội dung 3 daily liên tiếp.
6. **Cài đặt → Kết nối Google Drive và bật đồng bộ**. Trên thiết bị khác chọn **Khôi phục từ Google Drive** bằng cùng mật khẩu.

## Bảo mật: ai thấy được gì

| Bên | Thấy được |
| --- | --- |
| Người triển khai app | Không thấy gì. App không gửi dữ liệu về đâu ngoài AI và Drive của người dùng |
| GitHub | Chỉ phục vụ file code, không nhận dữ liệu |
| Google Drive | Một file đã mã hóa, không đọc được nội dung |
| Nhà cung cấp AI người dùng chọn | Âm thanh (bước chuyển giọng nói) và transcript (bước phân tích), theo điều khoản của họ |
| Người khác dùng chung máy | Không đọc được khi chưa có mật khẩu; app tự khóa sau 30 phút |

Giới hạn cần biết:

- **Quên mật khẩu là mất dữ liệu.** Không ai khôi phục được.
- Không có email digest tự động (không có máy chủ chạy theo lịch). Report sao chép hoặc tải về được.
- Mã độc trên chính máy người dùng (tiện ích trình duyệt độc hại, phần mềm gián điệp) có thể đọc dữ liệu khi app đang mở. Đây là giới hạn chung của mọi ứng dụng web.
- Người triển khai chịu trách nhiệm giữ an toàn tài khoản GitHub (xác thực 2 bước), vì mọi người dùng chạy code từ đó.

## Cập nhật app

Sửa file trên GitHub và commit. Người dùng nhận bản mới ở lần mở tiếp theo. Dữ liệu cũ vẫn giữ nguyên vì nằm trên máy và Drive của họ.
