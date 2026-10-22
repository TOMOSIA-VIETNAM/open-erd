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

1. **Create the ERD** — `/open-erd:init`
2. **Open it** — `out/erd.svg` in Chrome or Safari
3. **Code changed? Update** — `/open-erd:sync`
4. **Confirm what AI guessed** — `/open-erd:review`
5. **Send feedback** — `/open-erd:feedback <text>`

Want a change? Just say it: *"orders.status: refunded means money returned"*.

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
