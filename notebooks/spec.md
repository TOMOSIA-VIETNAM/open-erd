# Spec: open-erd

Plugin mã nguồn mở cho Claude Code: đọc source code (và metadata DB nếu user cho phép) của bất kỳ dự án nào, sinh ERD tương tác 1 file SVG, Excel, và diff dễ đọc giữa các phiên bản. AI chỉ sinh **model** (`*.yaml`); mọi thứ từ model trở đi là code thuần: cùng `engine_version` + cùng input → cùng output.

## Assumptions

1. Engine viết bằng **Node.js ≥ 20, JavaScript ESM**. Phát hành dạng **1 file bundle (esbuild) commit sẵn trong repo**, vì Claude Code plugin cài từ git, không có `node_modules`; cài xong chạy được offline.
2. Dependency (bundle vào): `elkjs` (pin exact version), `exceljs`, `yaml`. Test dùng `node:test`.
3. License **MIT**. Account/org GitHub: chưa chốt (Open Questions).
4. Mọi nhãn, note trong ERD bằng **English**. Identifier giữ nguyên gốc; note gốc không phải English (comment DB tiếng Nhật…) được AI dịch, bản gốc giữ ở `note_source`.

## Objective

### Vấn đề

1. ERD là tài liệu quan trọng nhưng hầu hết dự án không có, hoặc có nhưng outdated.
2. Schema không khai báo FK → tool vẽ ERD từ DB không thấy quan hệ.
3. Polymorphic, quan hệ xuyên DB/service chỉ thể hiện trong code → không tool nào vẽ được.
4. Hệ thống 100+ bảng vẽ phẳng → dây chằng chịt, không đọc được.

### Người dùng

Mọi người trong dự án: dev, tester, PM, BrSE, khách hàng, đối tác. Dev/BrSE thao tác qua terminal với AI; người còn lại chỉ mở file output, không cần cài gì.

### User stories

- Dev mới vào dự án mở 1 file SVG, thấy tổng quan DB → domain → bảng, click bảng để thấy bảng nối với nó.
- BrSE gửi khách 1 file SVG/Excel có note công năng từng bảng và nghĩa từng giá trị enum.
- PM xem "giữa bản bàn giao v1.0 và bây giờ, DB thay đổi gì" mà không đọc diff code.
- Người review đi qua checklist các quan hệ AI suy đoán, xác nhận hoặc sửa bằng lời trong terminal.

### Yêu cầu chức năng

**Đầu vào**
- Mọi stack (Rails, Laravel, Django, Node/Prisma/TypeORM/Mongoose, …), nhiều repo nguồn gom vào 1 ERD.
- Lần `init`, AI viết **script extract riêng cho dự án** vào `extract/`. Ràng buộc script: **viết bằng Node, chỉ đọc file tĩnh** (không boot app như `rails runner`/`artisan`, không gọi mạng, không ghi vào repo nguồn). AI hiện nội dung script và xin phép user trước lần chạy đầu và mỗi khi script bị sửa. Các lần sau chạy lại script → kết quả lặp lại được; AI chỉ sửa script khi phát hiện bỏ sót.
- Nhiều DB, nhiều loại DB (SQL + NoSQL) trong cùng hệ thống.
- **DB thật**: engine không bao giờ tự kết nối DB. Khi user đồng ý (hỏi từng lần), AI lấy metadata qua công cụ của user (CLI/MCP), read-only, mặc định chỉ FK/index/constraint; row count hoặc `DISTINCT` giá trị enum là lần hỏi riêng; không bao giờ đọc data rows. Kết quả lưu `extract/db-<name>.metadata.json`; `sync` dùng bản cache này, chỉ refresh khi user đồng ý.

**Model (single source of truth)**
- Định danh bảng: `<db>.<schema>.<table>`. Engine không có schema (MySQL, SQLite, Mongo) dùng `_` ở vị trí schema. Segment không được chứa dấu `.`.
- Mỗi bảng: domain, note, cột (type, nullable, pk, unique, default, auto_increment, generated, enum + nghĩa từng giá trị, note ngắn cho mọi cột, cờ `pii`), index (`indexes`: columns, unique, where, using, name).
- Mỗi quan hệ:
  - `from: { table, columns: [..] }`, `to: { table, columns: [..] }` (hỗ trợ composite key)
  - `cardinality: 1-1 | 1-n | n-1 | n-n`, `optional` (suy từ NOT NULL)
  - `kind: db_fk | declared | inferred | cross_db`
  - `evidence: ["<repo>:<path>#<symbol>"]` (line number tuỳ chọn, không dùng khi so sánh) hoặc `db`
  - `review: pending | reviewed | stale`
- Polymorphic là block riêng trong model (1 association có nhiều target): `polymorphic: [{ name, table, type_column, id_column, optional, targets: [..], note?, internal_note?, evidence, review }]`.
- Quan hệ suy đoán **vẫn vẽ**, nét đứt, kèm evidence, `review: pending`.
- Fact `reviewed` không bao giờ bị sync đổi hay xoá. Code không còn khớp → sync đánh dấu `stale` và đưa vào To review; chỉ xoá khi user xác nhận.
- **Rename** phát hiện lúc `sync`: AI hỏi user xác nhận, ghi `renamed_from`; sync chuyển vị trí layout và trạng thái review sang id mới.
- Pattern đặc biệt: polymorphic, STI, join table n-n, self-reference, view/materialized view, partition (gộp), schema-per-tenant (gộp thành 1 mẫu, ghi "× N tenants"), NoSQL embedded document (entity con trong box cha), replica/shard (1 DB logic).
- File model và config đều có `schema_version`; đổi schema phải kèm migration cho workspace cũ.

**Chống chằng chịt**
- 3 tầng view:
  - **Overview**: DB → thẻ domain, không vẽ line mặc định. Mỗi thẻ cùng kích thước: vạch màu domain, tên, số bảng, mô tả nghiệp vụ 1 câu (`domains.<tên>.note` trong `model/<db>.yaml`, tối đa 2 dòng, đủ trong tooltip), bảng trung tâm, tối đa 3 domain liên quan nhất kèm thanh độ mạnh 5 ô (căn bậc hai theo cặp mạnh nhất, không hiện số; khác DB có nhãn DB nhỏ). Trong 1 DB thẻ xếp lưới theo thứ tự domain liên kết nhiều nhất trước, hoà thì theo tên; layout cũ giữ vị trí, domain mới đặt cạnh domain liên quan nhất. Hover / focus bàn phím 1 thẻ → line cong tới mọi domain liên quan (dày theo số quan hệ, tooltip "n relations between A and B", click → panel chip quan hệ), thẻ khác mờ đi. Click thẻ → domain view; click 1 domain liên quan → domain đó. Tính sẵn lúc build (trừ line hover).
  - **Connections**: ma trận domain × domain (thứ tự như thẻ, nhóm theo DB), ô tô đậm nhạt theo số quan hệ hàng → cột, đường chéo = quan hệ trong domain (màu xám); hover ô → số theo 2 chiều, click → panel chip; hàng/cột tiêu đề dính mép khi pan. Vẽ sẵn lúc build, không cần layout.json.
  - **Domain**: bảng trong domain; bảng ngoài domain là stub mờ; domain khác có ≥ 2 bảng liên quan thì gộp thành 1 hộp nhóm (tên domain + danh sách bảng, tối đa 8 dòng + "+N more"), mỗi cặp (hộp nhóm, cột của bảng trong domain) 1 line dày theo số quan hệ. Stub xếp 2 bên domain, dư thì thành hàng trên/dưới cho view gọn. Tính sẵn lúc build.
  - **Neighborhood** (UI: "Related: Direct · +1 level"): 1 bảng + 1–2 hop, line có crow's foot như view chính. Tính trong viewer bằng thuật toán radial deterministic (không ELK).
- **Hub**: cột/bảng khai báo hub (`created_by`, `tenant_id`, `users`, …) hiện thành badge trong box (`→ users ×3`), không vẽ line. Chỉ dùng cho tham chiếu cắt ngang (audit, tenant/company), không cho bảng nghiệp vụ trung tâm; ưu tiên `hub.columns`. Panel của bảng hub liệt kê mọi quan hệ hub trỏ vào nó; chọn bảng hub thì line hub (route tính sẵn lúc build, ẩn mặc định) hiện trong view hiện tại; neighborhood của bảng hub gồm cả các bảng đó.
- **Polymorphic**: 1 node ảo `«commentable»` + danh sách target. Overview: nối tới domain chứa target. Domain/Neighborhood: line tới từng target chỉ hiện khi click node. Double-click node → neighborhood quanh node gồm bảng sở hữu và mọi target. Panel hiện `note` nghiệp vụ của association (nếu có).
- Line orthogonal, không xuyên box, crow's foot notation.

**Layout và ổn định thị giác**
- Bảng cùng domain luôn đứng thành cụm. Thêm bảng → bảng mới vào đúng cụm của nó; cụm được nới ra, các bảng khác **được phép dịch** để nhường chỗ, nhưng dịch theo luật cố định để người xem vẫn quen mắt:
  1. Thứ tự tương đối giữa các cụm giữ nguyên (cụm A bên trái cụm B thì vẫn bên trái).
  2. Trong 1 cụm, thứ tự tương đối giữa các bảng cũ giữ nguyên (trên/dưới, trái/phải).
  3. Cụm không chứa thay đổi chỉ được tịnh tiến nguyên khối, không bị xếp lại bên trong.
- Cụm do domain quyết định; muốn đổi vị trí cụm/bảng, user nói bằng lời, AI sửa `layout.json`.
- `layout` là lệnh riêng: ghi toạ độ cho node mới và báo các node bị dịch. `render` chỉ đọc, không ghi `layout.json`; gặp node chưa có toạ độ thì báo lỗi.
- Router orthogonal tự viết, đi line trên toạ độ đã chốt (ELK dùng cho xếp cụm, router riêng đảm bảo line không xuyên box).
- Chiều rộng chữ tính bằng bảng advance-width của 1 font cố định nhúng trong engine; SVG khai báo đúng font đó. Ký tự CJK tính full-width; quá dài thì cắt và hiện đủ trong tooltip.

**Đầu ra**
- **1 file SVG tự chứa** (style + script + data nhúng):
  - Click bảng → highlight bảng và các line nối vào, phần còn lại mờ đi.
  - Click line → animation chạy tới bảng đích.
  - Phím tắt (⌘ trên Mac, Ctrl nơi khác): F tìm bảng/cột, J join path (2 ô From/To), A về All tables, C copy SQL bảng đang chọn; Backspace / Alt+← quay lại; danh sách trong ⋯ › Keyboard shortcuts. Search bảng/cột mở ô tìm giữa màn hình, hover cột → chi tiết, chuyển view; bảng trung tâm (nhiều liên kết nhất) của mỗi domain được tô đậm và đặt giữa cụm khi layout mới.
  - Mở mặc định ở All tables, zoom sẵn tỉ lệ 1 quanh bảng trung tâm nhất (cả view khi chữ vẫn đọc được) + minimap; > 300 bảng thì Overview; `default_view` ghi đè.
  - Không có JS → vẫn hiện view mặc định tĩnh (All tables / Overview dạng thẻ / ma trận Connections). Viewer nào không chạy JS thì mở bằng browser.
- **Excel**: Overview (sheet đầu, mỗi bảng 1 dòng), mỗi bảng 1 sheet dạng lưới cột như DB client (`# | Name | Type | Nullable | Default | Generated | Expression | Primary Key | Auto Inc | Index | Comment`, Comment = note cột + nghĩa enum), Relations, Polymorphic, Indexes, To review (`pending` + `stale`), Changes (khi có diff); hyperlink giữa các sheet.
- **Diff ngữ nghĩa** giữa 2 snapshot:
  - Tóm tắt 1 dòng; SVG tô màu thêm/xoá/đổi/rename; click bảng → panel câu tiếng Anh; sheet Changes.
  - Rename đọc từ `renamed_from`. Heuristic (độ giống tập cột, ngưỡng cố định) chỉ gắn nhãn "Possibly renamed".
  - Layout diff = hợp layout 2 phía; trùng thì lấy phía "to"; bảng bị xoá giữ toạ độ phía "from".
- **Profile chia sẻ**: profile lọc dữ liệu ở bước normalize, trước mọi output. Profile `public` mặc định bỏ evidence, cột `pii`, note nội bộ, bảng/cột trong `hidden`.

**Phát hiện quan hệ bị sót**
- `validate` cảnh báo (không fail): cột `*_id` hoặc cặp `*_type`/`*_id` không thuộc relation/hub/polymorphic nào; bảng không có quan hệ nào; relation trỏ cột không tồn tại. Cảnh báo xuất hiện trong sheet To review ("Possibly missing relation") và dấu cảnh báo cạnh cột trong SVG. Có thể tắt từng cảnh báo bằng khai báo trong `open-erd.yaml` (cột không phải khoá ngoại thật).
- Skill `init`/`sync`: sau khi dựng model, một agent reviewer context sạch đọc lại code, dùng danh sách cảnh báo làm checklist, đề xuất quan hệ bị sót kèm evidence; agent chính thêm vào với `review: pending`.

**Tìm đường join (viewer)**
- Chọn 2 bảng → tối đa 3 đường ngắn nhất, xếp hạng: `db_fk`/`reviewed` trước, `inferred`/`pending` sau, đi qua bảng hub với chi phí cao; hoà thì theo id.
- Tô sáng đường trên sơ đồ, animation theo thứ tự hop; panel liệt kê từng điều kiện nối (`a.x_id = b.id`, composite key đúng thứ tự, join table gộp được tách lại 2 hop).
- Cờ: inferred/pending, cross-DB, polymorphic ("cần lọc theo `<type_column>`", không điền giá trị), cảnh báo nhân dòng khi hop đi theo chiều 1-n.
- Copy danh sách điều kiện, hoặc copy SQL skeleton (`SELECT *`, INNER JOIN theo hop, comment `--` trên hop cần kiểm); đường xuyên DB không có skeleton.
- Profile `public`: đường không đi qua bảng/cột bị lọc.

**Workspace ERD**
- Nằm **ngoài repo code**, `git init` riêng, **vị trí do user chọn** khi `init`.
- `sync` kết thúc bằng 1 commit trong workspace, ghi commit SHA của từng repo nguồn.
- Snapshot = git tag (ví dụ `v1.0-handover`).
- Push workspace lên remote: chỉ khi user yêu cầu.

### Ngoài phạm vi bản đầu

Export DBML/Mermaid, HTML wrapper, lint gợi ý `add_foreign_key` / FK thiếu index, sinh câu SQL hoàn chỉnh, Redis/Elasticsearch store node.

## Tech Stack

| Thành phần | Lựa chọn |
|---|---|
| Runtime | Node.js ≥ 20, ESM; phát hành 1 file bundle esbuild commit trong repo |
| Xếp cụm | `elkjs` exact version, `elk.randomSeed` cố định, mọi option khai báo tường minh |
| Route line | Router orthogonal tự viết (A* trên grid) |
| Đo chữ | Bảng advance-width của 1 font nhúng |
| Excel | `exceljs`; `created`/`modified` lấy từ commit time; mtime entry zip = hằng số |
| YAML | `yaml`; schema model/config khai báo 1 nơi (`src/model/schema.js`), validator viết tay (không thêm `ajv`) |
| Font | Inter (OFL), subset nhúng base64 vào SVG; `opentype.js` chỉ là devDependency để sinh bảng advance-width |
| Test | `node:test` + `node:assert` |
| Kiểm bằng mắt | Chrome headless (chỉ khi dev) |
| Plugin | `.claude-plugin/plugin.json` + `skills/*/SKILL.md` |

## Commands

Plugin (user gõ trong Claude Code):

```
/open-erd:init      # hỏi vị trí workspace, viết extract script (xin phép chạy), chia domain, layout + render lần đầu
/open-erd:sync      # chạy extract, AI bổ sung phần đổi, xác nhận rename, đánh dấu stale, commit workspace
/open-erd:review    # đi qua từng quan hệ pending/stale, user xác nhận/sửa bằng lời
/open-erd:render    # xuất out/erd.svg, out/erd.xlsx (không gọi LLM)
/open-erd:diff      # so 2 snapshot → out/diff.svg + sheet Changes
/open-erd:snapshot  # tạo git tag trong workspace
/open-erd:feedback <nội dung>  # tạo GitHub issue trên repo open-erd để góp ý / báo lỗi
```

`/open-erd:feedback`:
- Tạo issue trên repo `TOMOSIA-VIETNAM/open-erd` qua `gh` (account của người dùng). Không có `gh` hoặc chưa đăng nhập → in sẵn tiêu đề + nội dung và link tạo issue thủ công.
- Body gồm nội dung góp ý, phiên bản plugin/engine, OS, lệnh vừa chạy. **Không** tự đính kèm model, tên bảng, đường dẫn hay dữ liệu dự án; muốn đính kèm thì người dùng tự thêm.
- Luôn hiện bản nháp và xin xác nhận trước khi tạo issue (hành động ra bên ngoài).

Cuối mỗi lần `init`, `sync`, `review`, `render`, `diff` hoàn tất, skill in 1 dòng gợi ý: `Góp ý / báo lỗi: /open-erd:feedback <nội dung>`.

Chỉnh sửa nội dung/vị trí: user nói bằng lời, AI sửa `model/*.yaml` hoặc `layout.json`, chạy `layout` rồi `render`.

Engine CLI (skill gọi; dev cũng chạy được):

```
node dist/open-erd.mjs validate --workspace <dir>           # schema + locked facts
node dist/open-erd.mjs layout   --workspace <dir>           # ghi toạ độ node mới, báo node bị dịch
node dist/open-erd.mjs render   --workspace <dir> [--profile public]
node dist/open-erd.mjs diff     --workspace <dir> --from v1.0 --to HEAD|WORKTREE
```

Dev engine:

```
cd engine && npm ci
npm test            # node --test
npm run build       # esbuild → ../dist/open-erd.mjs
npm run eval        # chấm extraction quality trên fixtures
```

## Project Structure

Repo plugin:

```
open-erd/
  .claude-plugin/plugin.json
  skills/<command>/SKILL.md    # init, sync, review, render, diff, snapshot
  dist/open-erd.mjs            # bundled engine, committed
  engine/
    cli.js
    src/model/        # schema, load, validate, normalize, profile filter, migrations
    src/layout/       # ELK cluster placement, stability rules, orthogonal router, text metrics
    src/render/svg/   # SVG + embedded viewer script (views, highlight, animation, search, radial neighborhood)
    src/render/xlsx/
    src/diff/
    test/
  fixtures/<case>/    # sample repos + expected model, used by eval
  evals/
  notebooks/          # dev-time docs (spec, plan, proposal); not user docs
  README.md
  LICENSE
```

Workspace ERD (user chọn vị trí, git riêng):

```
<workspace>/
  open-erd.yaml       # schema_version, sources, hub, hidden, profiles, theme
  open-erd.local.yaml # per-machine source paths; gitignored; never credentials
  model/<db>.yaml
  model/cross-db.yaml
  layout.json         # positions keyed by view/node
  extract/            # Node extract scripts + db-<name>.metadata.json
  tests/locked.yaml   # declarative checks verified by `validate` (no executable code)
  out/                # erd.svg, erd.xlsx, diff.svg
```

Ví dụ model:

```yaml
schema_version: 1
database: billing
engine: postgresql
tables:
  - id: billing.public.invoices
    domain: Billing
    note: One invoice per customer per billing cycle.
    columns:
      - { name: id, type: bigint, pk: true }
      - { name: user_id, type: bigint, nullable: false }
      - name: status
        type: varchar
        enum:
          draft: Created, not yet sent to customer
          paid: Payment confirmed by gateway
relations:
  - from: { table: billing.public.invoices, columns: [user_id] }
    to:   { table: auth._.users, columns: [id] }
    cardinality: n-1
    optional: false
    kind: cross_db
    evidence: [ "billing-api:src/services/user-client.ts#fetchUser" ]
    review: pending
```

## Code Style

```js
// Sort by id before layout so identical models always yield identical output.
export function normalizeModel(model) {
  const tables = [...model.tables].sort((a, b) => a.id.localeCompare(b.id));
  return { ...model, tables };
}
```

- ESM, `camelCase` cho hàm/biến, `kebab-case` cho tên file.
- Hàm thuần ở model/layout/render/diff; I/O chỉ ở `cli.js`.
- Không `Math.random`, `Date.now`, thứ tự `Object.keys` chưa sort trong đường render.
- Comment tiếng Anh, chỉ giải thích "vì sao".

## Testing Strategy

**Engine** (`engine/test/`):
- Determinism: render cùng model 100 lần → sha256 giống nhau (SVG và XLSX).
- Ổn định layout: thêm/xoá bảng → 3 luật ổn định ở phần Layout đều đúng.
- Hình học: không line nào xuyên box; text không tràn box.
- Profile: output `public` không chứa id/evidence/cột `pii` bị lọc (grep).
- Diff: cặp model trước/sau → danh sách thay đổi mong đợi, gồm rename và "Possibly renamed".
- XLSX: đủ sheet, đúng thứ tự, hyperlink đúng.
- Fixture lớn: 1000 bảng; schema-per-tenant 500 tenant.

**Chất lượng AI** (`evals/` + `fixtures/`): mỗi stack 1 repo mẫu + `expected.yaml` viết tay, cộng repo multi-DB/microservice và repo có NoSQL. Chấm precision/recall bảng, quan hệ, cardinality, polymorphic, enum. Mỗi fixture chạy 3 lần, lấy median; ngưỡng tính trên tổng mọi fixture. Note chỉ kiểm có và không rỗng. Chạy khi đổi model LLM hoặc sửa prompt skill.

**Workspace** (`tests/locked.yaml`, kiểm bởi `validate`): mọi fact `reviewed` phải còn nguyên; model đúng schema. Test là dữ liệu khai báo, engine kiểm — workspace không chứa code test thực thi.

**Kiểm bằng mắt**: mỗi thay đổi renderer → render PNG bằng Chrome headless, xem ảnh trước khi báo xong.

## Boundaries

- **Always**: sort input trước layout/render; ghi evidence cho mọi quan hệ AI suy ra; `npm test` trước commit; không đổi/xoá fact `reviewed` khi chưa có user xác nhận; profile lọc dữ liệu trước khi render.
- **Ask first**: tạo issue feedback; chọn vị trí workspace; chạy extract script lần đầu và sau mỗi lần sửa; đọc DB (từng lần); xác nhận rename; xoá fact `stale`; push lên remote; thêm dependency; đổi schema model.
- **Never**: ghi credentials vào workspace; đọc data rows; ghi bất cứ gì vào repo nguồn; boot app nguồn trong script extract; để LLM sinh SVG/XLSX trực tiếp; xoá test đang fail để cho pass.

## Success Criteria

1. Cùng `engine_version` + cùng workspace → `erd.svg`, `erd.xlsx` byte-identical qua 100 lần render.
2. Thêm 1 bảng vào fixture 150 bảng → 3 luật ổn định layout đều đúng; cụm không liên quan chỉ tịnh tiến.
3. Fixture 150 bảng: 0 line xuyên box, 0 text tràn; render < 10 s; `erd.svg` < 5 MB. Fixture 1000 bảng: render < 60 s, Overview hiện < 2 s khi mở trong Chrome. Máy chuẩn: Apple M1, 8 GB.
4. Eval: recall bảng ≥ 0.98; quan hệ precision ≥ 0.90 và recall ≥ 0.90; polymorphic recall ≥ 0.90.
5. `erd.svg` mở trong Chrome và Safari: click bảng, click line (animation), search, chuyển view đều hoạt động; tắt JS vẫn thấy Overview.
6. Diff giữa 2 tag: tóm tắt đúng số lượng; rename hiện "Renamed"; sheet Changes khớp SVG.
7. Sau `sync` bằng LLM khác, `validate` pass: không fact `reviewed` nào bị đổi hoặc xoá mà không có user xác nhận.
8. Cài plugin trên máy không có mạng → `render` chạy được.

## Open Questions

1. Repo open source đặt dưới GitHub account/org nào?
2. Ngưỡng eval ở Success Criteria 4 có phù hợp không?
