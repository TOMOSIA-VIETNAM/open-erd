# Implementation Plan: open-erd

## Overview

Xây engine Node (model → layout → SVG/XLSX/diff) trước, kiểm bằng model viết tay; sau đó mới xây các skill phía AI (extract, sync, review) và eval. Rủi ro lớn nhất nằm ở layout (ổn định cụm + router + đo chữ), nên làm đầu tiên.

## Architecture Decisions

- **Engine thuần, I/O ở `cli.js`**: model/layout/render/diff là hàm thuần → test determinism dễ.
- **Validator viết tay** thay vì thêm `ajv`: model nhỏ, giữ deps đúng 3 thư viện spec cho phép. Schema mô tả 1 nơi duy nhất (`src/model/schema.js`), dùng cho cả validate và doc.
- **Font Inter (OFL)**: subset nhúng base64 vào SVG; bảng advance-width sinh 1 lần lúc dev (`opentype.js` là devDependency), commit dạng JSON.
- **ELK chỉ xếp cụm + thứ tự**; toạ độ cuối và route line do code riêng (stability rules + A* orthogonal router).
- **Viewer script** viết thành module riêng (`src/render/svg/viewer.js`), bundle thành chuỗi nhúng vào `<script>` của SVG.
- **Diff đọc snapshot bằng `git show <tag>:<path>`** — không cần checkout.
- **Eval chạy Claude headless tốn tiền** → script chấm điểm deterministic có sẵn; việc chạy LLM do user kích hoạt.

## Dependency Graph

```
scaffold
  └─ model (schema, validate, normalize, profile)
       ├─ text metrics ─┐
       └─ layout (cluster + stability + router) ─ svg static ─ viewer script ─ neighborhood
                                                       │
                                                       ├─ xlsx
                                                       └─ diff engine ─ diff svg + Changes sheet
  locked facts / stale ← model
  fixtures + skills (init/sync/review/render/diff/snapshot) ← toàn bộ engine
  eval ← fixtures + skills
```

## Task List

### Phase 1: Foundation + risk prototypes

- Task 1: Scaffold repo (plugin manifest, engine package, CLI `--help`, test runner, esbuild → `dist/`)
- Task 2: Model schema + load/validate/normalize (namespaced id, composite key, cardinality enum, review states, `schema_version`)
- Task 3: Text metrics (Inter advance widths, CJK full-width, truncate) + font subset embed
- Task 4: Vertical slice: 1 DB, 2 domain, 20 bảng → cluster layout → orthogonal router → SVG tĩnh có crow's foot
- Task 5: Layout stability: `layout.json`, lệnh `layout`, 3 luật ổn định, báo node bị dịch

**Checkpoint A** — test pass; render fixture ra PNG, người xem ảnh; luật ổn định chứng minh bằng test thêm/xoá bảng.

### Phase 2: Full diagram

- Task 6: Relation styles (db_fk/declared/inferred/cross_db/polymorphic), hub badge, polymorphic node, self-reference, n-n join table
- Task 7: Multi-DB frames + Overview (DB → domain, số quan hệ) + Domain view có stub bảng ngoài domain
- Task 8: Viewer script: chuyển view, click bảng highlight, click line animation, search, hover cột, Business/Technical, fallback không JS
- Task 9: Neighborhood view radial client-side (1–2 hop)
- Task 10: Profile `public` lọc dữ liệu + test determinism 100 lần + test hình học (không xuyên box, không tràn chữ)
- Task 11: Pattern đặc biệt: STI, view, partition gộp, schema-per-tenant gộp, NoSQL embedded entity, replica/shard

**Checkpoint B** — mở `erd.svg` trong Chrome + Safari, thao tác đủ tính năng; fixture 150 bảng đạt Success Criteria 3.

### Phase 3: Excel + diff + locked facts

- Task 12: XLSX (Overview, Tables, Relations, Enums, Polymorphic, To review; hyperlink; byte-identical)
- Task 13: Diff engine (git tag/WORKTREE, `renamed_from`, "Possibly renamed")
- Task 14: Diff SVG (layout hợp 2 phía, màu, panel câu tiếng Anh) + sheet Changes
- Task 15: `tests/locked.yaml` + `validate` kiểm fact reviewed, trạng thái stale

**Checkpoint C** — diff 2 tag của workspace mẫu khớp Success Criteria 6; validate chặn được fact bị mất.

### Phase 4: Plugin skills (phía AI)

- Task 16: Fixtures nguồn nhỏ: Rails, Laravel, Django, Prisma, Mongoose, multi-DB/microservice + `expected.yaml`
- Task 17: Skill `init` (hỏi vị trí, git init, viết extract script Node chỉ đọc file, xin phép chạy, chia domain, layout + render)
- Task 18: Skill `sync` (chạy extract, cập nhật, rename, stale, commit) + `review`
- Task 19: Skill `render`, `diff`, `snapshot`
- Task 19b: Skill `feedback` (tạo GitHub issue trên repo open-erd sau khi xác nhận; không đính kèm dữ liệu dự án) + dòng gợi ý feedback cuối các skill
- Task 20: Eval: chấm precision/recall (deterministic), runner gọi Claude headless chỉ khi user chạy

**Checkpoint D** — chạy `init` → `sync` → `review` → `render` → `snapshot` → `diff` trên 1 fixture end-to-end.

### Phase 5: Scale + docs

- Task 21: Fixture 1000 bảng + 500 tenant: đạt ngưỡng hiệu năng
- Task 22: README (cài đặt, lệnh, workspace, quyền đọc DB) + build `dist/` cuối

**Checkpoint E** — toàn bộ Success Criteria trong spec; chạy thử trên 1 dự án thật do user chọn.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Router orthogonal cho 150+ bảng chậm hoặc vẫn chồng line | High | Task 4 làm sớm; grid thô + cost phạt giao cắt; đo thời gian ngay từ fixture 20 bảng |
| Luật ổn định xung đột với cụm "đẹp" | High | Task 5 tách rõ: toạ độ cũ là ràng buộc, chỉ nới cụm + tịnh tiến |
| Font không có trên máy người xem → chữ tràn | Medium | Nhúng subset Inter vào SVG |
| SVG 1000 bảng quá nặng | Medium | Data JSON nhúng một lần, view Domain dựng DOM khi mở; đo ở Task 21 |
| Extract script AI viết sai giữa các stack | Medium | Fixtures + eval; script chỉ đọc file |
| XLSX không byte-identical do zip | Low | Cố định thời gian, post-process mtime |

## Open Questions

- GitHub account/org khi tạo repo (sau khi user duyệt bản local).
- Ngưỡng eval.
