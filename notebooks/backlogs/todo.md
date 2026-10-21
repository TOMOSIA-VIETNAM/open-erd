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
- [ ] 8. Viewer script (click, animation, search, modes, no-JS fallback)
- [ ] 9. Neighborhood radial
- [ ] 10. Profile public + determinism 100× + geometry tests
- [ ] 11. Pattern đặc biệt (STI, view, partition, tenant, NoSQL embedded, replica)
- [ ] Checkpoint B

## Phase 3: Excel + diff + locked facts

- [ ] 12. XLSX
- [ ] 13. Diff engine
- [ ] 14. Diff SVG + Changes sheet
- [ ] 15. locked.yaml + stale
- [ ] Checkpoint C

## Phase 4: Plugin skills

- [ ] 16. Fixtures nguồn + expected.yaml
- [ ] 17. Skill init
- [ ] 18. Skill sync + review
- [ ] 19. Skill render / diff / snapshot
- [ ] 20. Eval
- [ ] Checkpoint D

## Phase 5: Scale + docs

- [ ] 21. Fixture 1000 bảng / 500 tenant
- [ ] 22. README + dist cuối
- [ ] Checkpoint E
