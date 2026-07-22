# Chartdown Render — GitHub Action

Render [Chartdown](https://github.com/Nossimonov/Chartdown) maps in your repo on every push: `.cd` files and ` ```chartdown ` fences inside Markdown become SVGs committed beside them — so your campaign notes, session logs, and READMEs show maps natively on GitHub.

```yaml
# .github/workflows/maps.yml
name: Render maps
on:
  push:
    branches: [main]
permissions:
  contents: write
jobs:
  render:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Nossimonov/chartdown-action@v1
```

Write a map anywhere in your repo:

````markdown
```chartdown
# Ambush at Redford Crossing
map: battlemap
grid: square 20x15
scale: 5ft
[terrain]
river redford "The Redford" : path A9 F9 K9 P10 T10 width=2
road tollroad "Old Toll Road" : path K1 K15
ford : on redford on tollroad difficult
```

![The map](./session-3.ambush-at-redford-crossing.svg)
````

…push, and the image link resolves. A fence in `notes/session-3.md` renders to `notes/session-3.<doc-id>.svg`; a standalone `maps/keep.cd` renders to `maps/keep.svg` (and `keep-gm.svg` with `mode: both`).

## Inputs

| Input | Default | |
|---|---|---|
| `root` | `.` | Directory to scan recursively |
| `mode` | `player` | `player` \| `gm` \| `both` — player strips secrets fail-closed |
| `markdown` | `true` | Also render fences inside `.md` files |
| `theme` | | Path to a Chartdown theme document |
| `verify` | `false` | Render and **diff** instead of writing — CI fails if committed SVGs drift from sources |
| `clean` | `warn` | Orphaned outputs: `warn` \| `true` (delete) \| `false` (ignore) — see below |
| `commit` | `true` | Commit + push rendered SVGs (job needs `permissions: contents: write`) |
| `commit-message` | `Render Chartdown maps` | |

Render errors fail the run with `file:line` diagnostics that cite the spec sections they enforce. Theme and vocabulary `.cd` documents (no `map:` header) are skipped.

## Provenance and orphan cleanup

Every SVG the action writes carries a `<metadata>` provenance marker recording its source, doc id, mode, and output path (no timestamps or versions — re-renders stay byte-identical). Rename a doc, delete a fence, or switch `mode`, and the old output becomes an **orphan**: still on disk, still showing in docs as if current, produced by nothing.

An SVG is treated as an orphan only when *all three* hold: it bears the marker, the marker's recorded output path is the file's own path, and no current render job produces that path. Hand-made SVGs carry no marker; a copy of a generated SVG you kept deliberately records its *old* path — both always survive. `clean: warn` (the default) reports orphans, `clean: true` deletes them (the commit step stages deletions automatically), `clean: false` skips the scan. In `verify` mode an orphan fails the run like any other drift.

The first run with a marker-aware renderer rewrites every output once to stamp it — a one-time reconciliation commit. Pre-marker orphans can't be identified with certainty; obviously suspicious ones are warned about but never auto-deleted.

## Verify mode (CI guard)

The Chartdown repo itself uses `verify: true` to guarantee its committed example SVGs never drift from their sources:

```yaml
- uses: Nossimonov/chartdown-action@v1
  with:
    root: examples
    mode: both
    markdown: false
    verify: true
```

## Development

This is the release repository — the driver is built from the [Chartdown monorepo](https://github.com/Nossimonov/Chartdown) (`packages/action`), where the source, tests, and issue tracker live. The language: [spec](https://github.com/Nossimonov/Chartdown/tree/main/docs/spec) · [playground](https://nossimonov.github.io/Chartdown/) · [npm packages](https://www.npmjs.com/org/chartdown).

## License

[MIT](LICENSE).
