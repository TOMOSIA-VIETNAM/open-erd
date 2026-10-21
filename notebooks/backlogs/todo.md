# Todo: open-erd

Chi tiết từng task: `plan.md`. Đánh dấu `[x]` khi task pass verify.

## Phase 1: Foundation + risk prototypes

- [x] 1. Scaffold
  - Acceptance: `node dist/open-erd.mjs --help` in danh sách lệnh; `.claude-plugin/plugin.json` hợp lệ
  - Verify: `cd engine && npm test && npm run build`
- [x] 2. Model schema + validate/normalize
  - Acceptance: model sai (id có dấu chấm, cardinality lạ, thiếu schema_version) báo lỗi có path; normalize sort ổn định
  - Verify: `node --test test/model.test.js`
- [x] 3. Text metrics + font embed
  - Acceptance: width chuỗi Latin lệch < 2% so với Chrome render; CJK full-width; truncate có tooltip
  - Verify: `node --test test/metrics.test.js` (so với `test/fixtures/chrome-text-widths.json`; đo lại bằng `npm run measure-chrome`)
- [x] 4. Vertical slice layout → router → SVG tĩnh
  - Acceptance: fixture 20 bảng: 0 line xuyên box, crow's foot đúng, render < 2 s
  - Verify: `node --test test/layout.test.js` + PNG xem bằng mắt (fixture `test/fixtures/workspace-shop`)
- [x] 5. Layout stability
  - Acceptance: thêm/xoá bảng → 3 luật đúng; `render` không ghi `layout.json`
  - Verify: `node --test test/stability.test.js` (luật "render không ghi layout.json" ở `test/layout.test.js`)
- [ ] Checkpoint A

## Phase 2: Full diagram

- [x] 6. Relation styles + hub + polymorphic
  - Acceptance: nét theo kind/review (inferred đứt tới khi reviewed, cross_db gạch-chấm-chấm + nhãn "cross-DB"); hub thành badge, không route; polymorphic = 1 node ảo + 1 line, target nhúng `data-targets`; self-reference vòng gọn; `collapse_join_tables` (mặc định tắt)
  - Verify: `node --test test/views.test.js test/model.test.js` + PNG (fixture `test/fixtures/workspace-multi`, `node scripts/screenshot-views.js <erd.svg> <dir>`)
- [x] 7. Multi-DB + Overview + Domain view
  - Acceptance: khung DB (engine) chứa domain; view `overview` (số quan hệ giữa domain), `all`, `domain:<db>/<domain>` (stub cạnh domain); `layout.json` theo view, 3 luật ổn định cho từng view; 1 SVG, không JS chỉ hiện overview
  - Verify: `node --test test/views.test.js test/stability.test.js test/layout.test.js` + PNG mọi view
- [x] 8. Viewer script (click, animation, search, modes, no-JS fallback)
  - Acceptance: viewer bundle (`src/render/svg/viewer/`, sinh bằng `npm run bundle-viewer`) + data JSON nhúng trong SVG, deterministic; chuyển view, click bảng/line/stub/polymorphic, tooltip cột, search, Business/Technical, pan/zoom, Esc; tắt JS vẫn thấy Overview
  - Verify: `node --test test/viewer.test.js` + `node scripts/verify-viewer.js <erd.svg> <dir>` (Chrome headless, kiểm từng bước + console không lỗi). Safari chưa kiểm
- [x] 9. Neighborhood radial
  - Acceptance: double-click bảng hoặc nút trong panel → bảng + 1/2 hop, layout radial client-side không chồng box (N ≤ 40), Back về view trước
  - Verify: `node --test test/viewer.test.js` + `scripts/verify-viewer.js`
- [x] 10. Profile public + determinism 100× + geometry tests
  - Acceptance: `profiles` trong `open-erd.yaml` (mặc định an toàn, `public` có sẵn); lọc trước render, vẽ tại toạ độ của layout đầy đủ (không re-layout); `render --profile <name>` ghi `out/erd.<name>.svg`; output public không chứa bảng/cột hidden, cột pii, evidence, internal_note, note_source; 100 lần render sha256 giống nhau; hình học kiểm mọi view của mọi workspace (engine + fixtures)
  - Verify: `node --test test/profile.test.js test/determinism.test.js test/geometry.test.js`
- [x] 11. Pattern đặc biệt (STI, view, partition, tenant, NoSQL embedded, replica)
  - Acceptance: field `sti`, `kind`/`sources`, `partition`, `unique` (nhiều cột), `generated_by`, `embedded`, `tenant_schemas`, `topology` trong schema + validator; renderer: tag «view», line nét đứt mờ tới source, dòng fact cuối box, inset box cho embedded (relation từ `entity.column`), chồng thẻ cho bảng tenant, pill trên khung DB; fixtures cập nhật; `layout` mang toạ độ + màu theo `renamed_from`; `--version`
  - Verify: `node --test test/views.test.js test/model.test.js test/stability.test.js test/cli.test.js` + PNG (`test/fixtures/workspace-patterns`, `fixtures/{mongoose,multi-db,rails}/expected`) + `scripts/verify-viewer.js`
- [ ] Checkpoint B

## Phase 3: Excel + diff + locked facts

- [x] 12. XLSX
  - Acceptance: `render` ghi `out/erd.xlsx` (`out/erd.<profile>.xlsx` từ model đã lọc); sheet Overview, Tables, Columns, Relations, Enums, Polymorphic, To review; hyperlink tên bảng → dòng Tables; header freeze + filter; created/modified = commit time HEAD của workspace (không có git riêng → 1980-01-01), mtime entry zip hằng số → byte-identical; xlsx public không chứa bảng/cột hidden, pii, evidence, internal_note, note_source
  - Verify: `node --test test/xlsx.test.js test/profile.test.js`
- [x] 13. Diff engine
  - Acceptance: `diff --workspace <ws> --from <ref> --to <ref|HEAD|WORKTREE>` đọc 2 phía bằng `git ls-tree` + `git show` (WORKTREE đọc đĩa; `--to HEAD` khi có sửa chưa commit → cảnh báo stderr; `--from WORKTREE` bị từ chối); hàm thuần `diffModels` (`src/diff/changes.js`): bảng thêm/xoá/rename theo `renamed_from`, "possibly renamed" (Jaccard tập cột ≥ 0.6, chỉ là nhãn, vẫn đếm thêm + xoá), cột thêm/xoá/rename/type/nullable/pk/unique/pii/note, enum value thêm/xoá/đổi nghĩa, note, STI/partition/view sources/unique key, database engine/tenant/topology, relation thêm/xoá/đổi cardinality/optional/kind/review, polymorphic thêm/xoá/target; câu tiếng Anh chỉ sinh ở `describeChange`; dòng tóm tắt `+N tables · −N tables · N renamed · N columns changed · N relations changed`
  - Verify: `node --test test/diff.test.js`
- [x] 14. Diff SVG + Changes sheet
  - Acceptance: `out/diff.svg` vẽ model hợp 2 phía (bảng/cột/relation bị xoá được thêm lại), layout = `computeLayout` trên layout.json phía "to" + entry phía "from" còn thiếu (bảng bị xoá giữ toạ độ "from", bảng còn lại giữ toạ độ "to" trừ khi phải nhường chỗ), không ghi `layout.json`; màu: thêm xanh lá, xoá đỏ nét đứt + gạch ngang, đổi cam, rename xanh dương; vạch màu từng cột trong box; banner tóm tắt + chú thích ở mọi view; mở ở view All tables (không JS vẫn thấy banner + màu); click bảng/line → panel liệt kê thay đổi (cùng 1 viewer bundle); `out/diff.xlsx` = workbook phía "to" + sheet Changes (Database | Table | Change | Detail | Before | After, link tới dòng Tables, mở sẵn sheet Changes); `--profile` lọc cả 2 phía theo profile của phía "to" → `out/diff.<profile>.*`; chạy lại cùng 2 ref → byte-identical
  - Verify: `node --test test/diff.test.js test/xlsx.test.js` + `node scripts/screenshot-views.js out/diff.svg <dir>` + `node scripts/verify-viewer.js out/diff.svg <dir>`
- [x] 15. locked.yaml + stale
  - Acceptance: `lock` ghi `tests/locked.yaml` từ relation/polymorphic `reviewed` (giữ entry của fact `stale`, từ chối khi lock đang bị vi phạm); `validate` fail khi fact bị khoá mất hoặc đổi (kể cả hạ về `pending`), pass khi `stale`; theo `renamed_from`; lỗi liệt kê từng fact
  - Verify: `node --test test/lock.test.js test/cli.test.js`
- [x] Checkpoint C

## Phase 4: Plugin skills

- [x] 16. Fixtures nguồn + expected.yaml
- [x] 17. Skill init
- [x] 18. Skill sync + review
- [x] 19. Skill render / diff / snapshot
- [x] 19b. Skill feedback (gh issue, bản nháp + xác nhận, không đính kèm dữ liệu dự án) + dòng gợi ý cuối mỗi skill
- [ ] 20. Eval
- [ ] Checkpoint D

## Phase 5: Scale + docs

- [ ] 21. Fixture 1000 bảng / 500 tenant
- [ ] 22. README + dist cuối
- [ ] Checkpoint E
