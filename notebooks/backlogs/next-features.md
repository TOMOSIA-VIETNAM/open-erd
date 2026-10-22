# Spec: 6 tính năng tiếp theo (đã duyệt)

Trạng thái lúc viết: `main` @ `7270c83`. Workspace thử nghiệm thật: `/Users/minhtang/Documents/Projects/TMS/QLEAR/erd-qlear-v2-api` (repo riêng, có git; không commit ảnh/dữ liệu của nó vào repo open-erd vì repo public).

Nguyên tắc chung (giữ như mọi vòng trước):
- Tính năng chung cho mọi stack/dự án, không xử lý riêng cho dự án nào.
- Ưu tiên dữ liệu tính thẳng từ model (bền, không outdate); không sinh thêm nội dung do AI viết nếu không cần.
- Mỗi tính năng: test node + bước `engine/scripts/verify-viewer.js`, xem ảnh chụp trên fixture `engine/test/fixtures/workspace-multi` và bản copy workspace qlear, `npm test` (chạy 2 lần) + `npm run build` xanh.
- Khi chạy không có người: không dùng shell `rm`, không hỏi; ghi danh sách "Cần xoá".
- README chỉ cho người dùng, ngắn; chi tiết vào `docs/USAGE.md`, dev vào `docs/DEVELOPMENT.md`.

Thứ tự làm: 1 → 2 → 3 → 4 → 5 → 6.

## 1. ERD tự cập nhật trong CI (không cần AI)

Vấn đề: ERD outdated. Script extract do `init` sinh (`<ws>/extract/*.mjs`) là Node thuần, chạy được không cần LLM.

- Lệnh mới `/open-erd:ci-setup`: sinh workflow GitHub Actions (file trong repo nguồn **chỉ khi user đồng ý**, vì đây là ghi vào repo nguồn) hoặc in nội dung để user tự thêm.
- Workflow, chạy khi PR đụng các đường dẫn model/migration (lấy từ `open-erd.yaml` sources):
  1. checkout repo nguồn + workspace ERD (workspace là repo riêng: cần quyền đọc; ghi rõ cách cấp token).
  2. chạy extract scripts → facts; engine áp thay đổi **cơ học** (bảng/cột/quan hệ `db_fk` mới hoặc mất) vào bản model tạm. Quyết định khó (rename, note nghiệp vụ, quan hệ suy đoán) **không** làm trong CI: đánh dấu "cần `/open-erd:sync`".
  3. `diff` so với model hiện tại → comment vào PR: câu tóm tắt + bảng thay đổi + link artifact `diff.svg`.
- Cần một lệnh engine mới cho bước 2 (ví dụ `apply-facts --workspace <ws> --facts <dir> --out <tmp>`): chỉ áp thay đổi cấu trúc, deterministic, có test.
- Không push vào workspace từ CI ở bản đầu (chỉ comment).

## 2. Tour (chế độ trình chiếu)

- Nút ▶ Tour trên toolbar (và phím `T`): lần lượt từng domain theo thứ tự trung tâm trước (thứ tự thẻ overview), mỗi bước: zoom vào domain view, focus bảng trung tâm, phụ đề = `domains.<name>.note` (thiếu note thì tên domain + số bảng), tự sang bước sau sau ~6s; có Pause/Next/Prev/Esc.
- Không có note domain thì vẫn chạy (chỉ hiện tên).
- Download không chứa trạng thái tour.

## 3. Bản đồ dữ liệu cá nhân (PII)

- Toggle "PII" (menu ⋯ và phím `P`): tô sáng mọi cột `pii: true` trên mọi view, làm mờ phần còn lại; panel tổng kết: số cột PII theo domain/bảng, click để nhảy tới.
- Excel: sheet "PII" (database, domain, table, column, type, note).
- Profile `public` vốn bỏ cột PII: toggle ẩn khi profile đã lọc hết.
- Skills: nhắc AI đánh `pii` đầy đủ (email, phone, name, address, birthday, IP, tokens…).

## 4. Sức khoẻ schema (Health) — đã chốt tradeoff

Danh sách phát hiện, **không chấm điểm**, không sinh migration theo framework.
- Luật (chỉ trên dữ liệu chắc chắn):
  - quan hệ `declared` (khai báo trong code) mà không có `db_fk` trên DB SQL (bỏ qua: polymorphic, cross-DB, MongoDB, bảng partition) — medium.
  - cột là đầu `from` của quan hệ nhưng không thuộc index nào (tính cả index ghép bắt đầu bằng cột đó) — medium.
  - polymorphic thiếu index ghép (`type_column`, `id_column`) — medium.
  - bảng mồ côi (không quan hệ, không hub, không nằm trong `ignore_missing.tables`) — low.
  - unique index trùng lặp/thừa (index là tiền tố của index khác) — low.
- Mỗi mục: mức độ, bảng/cột, giải thích 1 câu, gợi ý bằng lời + SQL tham khảo (`ALTER TABLE … ADD CONSTRAINT …`, `CREATE INDEX …`) theo engine của DB.
- Bỏ qua từng mục: `health.ignore: [<rule>:<table>[.<column>]]` trong `open-erd.yaml` (schema.js, validator, docs).
- Hiển thị: view "Health" (danh sách lọc theo mức độ, click → bảng), dấu nhỏ trên bảng có vấn đề khi bật; Excel sheet "Health"; `validate` không fail vì health.

## 5. Phạm vi ảnh hưởng (impact radius)

- Trong panel bảng/cột: nút "Impact": tô các bảng phụ thuộc theo vòng 1/2/3 bước (chiều tham chiếu ngược: ai trỏ tới bảng/cột này; polymorphic tính cả), legend vòng, tổng số bảng; danh sách trong panel nhóm theo vòng.
- Cột: chỉ các quan hệ dùng đúng cột đó; bảng: mọi quan hệ trỏ tới bảng.
- Dùng lại thuật toán và view neighborhood; hàm thuần, có test.

## 6. `/open-erd:ask "<câu hỏi>"`

- Skill mới: Claude đọc **model** (không đọc code) trả lời câu hỏi nghiệp vụ/cấu trúc; kèm link mở viewer với bảng liên quan được tô sáng.
- Viewer: deep link `#tables=<id>,<id>…` (tô sáng tập bảng, fit view) và `#path=<id>,<id>…` (hiện như join path). Đã có `#table=`, `#column=`, `#view=`.
- Không sinh file; trả lời trong hội thoại kèm câu gợi ý `/open-erd:feedback`.

## Việc tồn đọng nhỏ (làm kèm khi tiện)

- Overview: legend mở có thể che thẻ ở góc dưới trái → tự né thẻ hoặc thu gọn mặc định ở Overview.
- Tooltip dòng "Related domains" trên thẻ: hiện click mở domain (đã chốt), kiểm lại có cần mở panel danh sách không.
- draw.io: icon note nằm góc dưới-trái bảng, có thể gần line chạy sát mép trái (draw.io không cho chỉnh vị trí).
