<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/images/logo/logo-lockup-dark.svg">
    <img src="./docs/images/logo/logo-lockup.svg" alt="open-erd" width="420">
  </picture>
</p>

<p align="center">
  <strong>An ERD of any project, drawn by an agent from its source code.</strong><br>
  <strong>Even when the database has no foreign keys.</strong><br>
  <sub>Rails · Laravel · Django · Prisma · TypeORM · Sequelize · Mongoose · raw SQL</sub><br>
  <code>/open-erd:init</code> · <code>/open-erd:sync</code> · <code>/open-erd:ask</code><br><br>
  <a href="https://tomosia-vietnam.github.io/open-erd/"><strong>▶ Try the live demo</strong></a> — a real 105-table schema, right in your browser
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/TOMOSIA-VIETNAM/open-erd?style=flat-square&color=blue"></a>
  <a href="#install"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square&logo=anthropic&logoColor=white"></a>
  <a href="#what-you-get"><img alt="Output" src="https://img.shields.io/badge/output-SVG_·_Excel_·_draw.io-141B2D?style=flat-square"></a>
</p>

- **Finds the relations the database never declared**: reads models,
  migrations and associations, polymorphic ones included.
- **Checks every fact against the code** with a second agent before it is
  committed.
- **One interactive `erd.svg`** for any browser, plus Excel and draw.io copies.
- **Stays current**: `/open-erd:sync` after code changes.

<p align="center">
  <img src="./docs/images/demo/overview-to-domain.gif" width="760" alt="The overview of an e-commerce schema: one card per domain; a click opens the Orders domain">
</p>

<sub>Demo data: the open-source <a href="https://github.com/solidusio/solidus">Solidus</a> e-commerce app, 105 tables in 14 domains. <a href="https://tomosia-vietnam.github.io/open-erd/">Open it yourself</a> · <a href="./docs/demo/erd.xlsx">erd.xlsx</a> · <a href="./docs/demo/erd.drawio">erd.drawio</a></sub>

## How it works

```
/open-erd:init    # once per project: pick the ERD folder, approve the extract script and the domains
/open-erd:sync    # after code changes: extract, update the model, verify, redraw, commit
```

Open `out/erd.svg` in a browser. `$open-erd-init` and `$open-erd-sync` in Codex.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/images/flow-dark.svg">
    <img src="./docs/images/flow.svg" width="760" alt="init reads your code, open out/erd.svg in the browser, sync after code changes, review what the AI guessed; ask questions or get an ERD diff on every pull request at any time">
  </picture>
</p>

## Install

Claude Code:

```
/plugin marketplace add TOMOSIA-VIETNAM/open-erd
/plugin install open-erd@open-erd
```

- Update: `/plugin marketplace update open-erd` → `/plugin` › **Installed** › **open-erd** › **Update now** → `/reload-plugins`
- Auto-update: `/plugin` › **Marketplaces** › **open-erd** › **Enable auto-update**

Codex:

```bash
codex plugin marketplace add TOMOSIA-VIETNAM/open-erd
codex plugin add open-erd@open-erd
```

- Update: `codex plugin marketplace upgrade open-erd` → new session

After an update, run `/open-erd:sync` in each ERD workspace to redraw it with the new viewer. Other ways to install: [docs/install.md](docs/install.md).

<details>
<summary>Uninstall</summary>

Your ERD workspaces stay where they are; only the plugin goes.

Claude Code:

```
/plugin uninstall open-erd@open-erd
/plugin marketplace remove open-erd
```

Codex, installed from the plugin catalog:

```bash
codex plugin remove open-erd@open-erd
codex plugin marketplace remove open-erd
```

Codex, installed with the one-line script:

```bash
curl -fsSL https://raw.githubusercontent.com/TOMOSIA-VIETNAM/open-erd/main/install.sh | bash -s -- --uninstall
```

The second line of each pair (removing the marketplace) is optional. Open a new session afterwards.

</details>

## What you get

### Find any table in a second

`⌘K` searches tables and columns and runs every command. Type `a > b` to see
how two tables join.

<p align="center"><img src="./docs/images/demo/search.gif" width="760" alt="Command palette: typing ship jumps to spree_shipments"></p>

### See how two tables join

Each hop with its condition, warnings when a hop multiplies rows, and a
ready-to-check `SELECT … JOIN`.

<p align="center"><img src="./docs/images/demo/join-path.gif" width="760" alt="Join path from spree_users to spree_shipments"></p>

### Every table explained

Columns with types, defaults and enum meanings, relations you can follow,
indexes, and a note on what the table is for. `←` goes back.

<p align="center"><img src="./docs/images/demo/table-panel.gif" width="760" alt="Table panel with columns, relations and notes"></p>

### Where personal data lives

**Highlight › Personal data** tints every PII column across the schema, with a
list per domain. The `public` sharing profile leaves them out entirely.

<p align="center"><img src="./docs/images/demo/pii.gif" width="760" alt="Personal data map"></p>

### Schema health, without a score

Missing foreign keys, unindexed references, redundant indexes — each with a
one-line reason and reference SQL for your database.

<p align="center"><img src="./docs/images/demo/health.gif" width="760" alt="Schema health findings"></p>

### Present it

Press `T` for a tour: one domain after another, with its description.

<p align="center"><img src="./docs/images/demo/tour.gif" width="760" alt="Tour through the domains"></p>

### Also

- **`/open-erd:ask "how does a customer get a refund?"`** — an answer from the
  ERD, with a link that opens the viewer on the tables it used.
- **`/open-erd:ci-setup`** — every pull request that touches the schema gets
  one comment with the ERD changes and a `diff.svg`. No AI in CI.
- **Excel** (`out/erd.xlsx`) — one sheet per table, plus Relations, PII,
  Health. **draw.io** (`out/erd.drawio`) — to rearrange or annotate.
- Change anything by just saying it: *"orders.status: refunded means the money
  was returned"*.

## Commands

| Command | When |
|---|---|
| `/open-erd:init` | Once per project: creates the ERD |
| `/open-erd:sync [focus]` | After code changes — run it often |
| `/open-erd:review` | Confirm or correct the relations the AI guessed (dashed lines), one by one. Not a code review |
| `/open-erd:ask "<question>"` | Questions about the data model |
| `/open-erd:ci-setup` | ERD diff comment on pull requests |
| `/open-erd:diff [from] [to]` | Compare two versions of the ERD: a tag, any commit, or your uncommitted edits |
| `/open-erd:feedback <text>` | Tell us what to improve |

## Safe by design

- Reads files only; never boots your app, never writes to your repositories.
- Database metadata only with your approval each time, read-only; credentials
  are never stored.
- Nothing is pushed anywhere unless you ask.

---

[Full reference](docs/USAGE.md) · [Development](docs/DEVELOPMENT.md) · MIT
