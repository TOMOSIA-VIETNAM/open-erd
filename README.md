# open-erd

ERD for any project, drawn from its source code — even without foreign keys.

![All tables](docs/images/table-highlight.png)

## Install

In Claude Code:

```
/plugin marketplace add TOMOSIA-VIETNAM/open-erd
/plugin install open-erd@open-erd
```

## Use

1. **Create the ERD** (once per project) — `/open-erd:init`
2. **Open it** — `out/erd.svg` in Chrome or Safari
3. **Update after code changes** (run often) — `/open-erd:sync` or `/open-erd:sync <what to focus on>`
4. **Confirm relations AI guessed** (dashed lines; optional) — `/open-erd:review`
5. **Preview ERD changes on pull requests** (optional) — `/open-erd:ci-setup`
6. **Send feedback** — `/open-erd:feedback <text>`

Want a change? Just say it: *"orders.status: refunded means money returned"*.

Every change is checked against the code by a second agent before it is committed (`verify` in `open-erd.yaml`; see [docs/USAGE.md](docs/USAGE.md#verification)).

## Output

| File | Open with |
|---|---|
| `out/erd.svg` | Browser — interactive diagram |
| `out/erd.xlsx` | Excel — one sheet per table |
| `out/erd.drawio` | draw.io — edit the layout |

![Overview](docs/images/overview.png)

## Shortcuts

`⌘F` search · `⌘J` join path · `⌘A` all tables · `⌘C` copy table SQL · `Backspace` back

---

[Full reference](docs/USAGE.md) · [Development](docs/DEVELOPMENT.md) · MIT
