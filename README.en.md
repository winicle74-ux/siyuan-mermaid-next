# siyuan-mermaid-next · Mermaid 12 Renderer

Replaces the Mermaid **11.16.1** bundled with SiYuan with upstream **Mermaid 12.3.0** — while keeping
rendering **inline in the document**. You keep writing Mermaid source in fenced code blocks; SiYuan keeps
rendering them into diagrams as usual. Only the engine underneath changes.

## What this plugin does

SiYuan (3.8.6-alpha.9) ships Mermaid **11.16.1**. The surrounding render pipeline is fine — idempotent
render markers, the icon bar, sanitizing, deferred rendering of collapsed blocks and syntax-error notices
are all in place. The only outdated part is the engine itself. So this plugin does not reimplement the
render pipeline; it does exactly one thing: swap the engine.

1. **Claiming the injection slot.** SiYuan lazy-loads Mermaid through
   `loadScript(url, "protyleMermaidScript")`, and that function begins with
   `if (document.getElementById(id)) return`. The plugin parks its own vendor script under the same id, so
   SiYuan never gets around to loading 11.16.1.
2. **Taking over the global.** `window.mermaid` is installed via `Object.defineProperty`: `get` returns a
   proxy, `set` catches the real engine. The vendor is a UMD build whose last statement is
   `globalThis["mermaid"] = ...`, which lands in that setter. Every `window.mermaid.render(...)` and
   `initialize(...)` in SiYuan's own code therefore ends up on 12.3.0.
3. **Merging configuration.** SiYuan calls `initialize(its own config)` before every render. The proxy
   intercepts that call, deep-merges *SiYuan's native config + the plugin defaults + your settings*, and
   only then hands the result to the real engine — so neither side overwrites the other.
4. **Fault-tolerant registration.** SiYuan loads `mermaid-zenuml` / `mermaid-layout-tidy-tree` on demand
   and then calls `registerExternalDiagrams` / `registerLayoutLoaders`. The proxy queues those calls until
   the engine is ready and then forwards them, with three layers of protection: `filter(Boolean)` before
   forwarding (SiYuan passes `[undefined]` or plain `undefined` when a resource failed to load), a
   synchronous `try/catch`, and **catching the rejected promise returned by async registration**. All three
   are necessary: `registerLayoutLoaders` is synchronous (bad arguments throw immediately), while
   `registerExternalDiagrams` is async (bad arguments do not throw — they return a rejected promise and
   fail silently). Once SiYuan's native `.then` chain rejects, *no* diagram in the document renders at all,
   so the plugin only warns on failure and never throws.

The result: editing a code block, using the refresh button, deferred rendering after expanding a collapsed
block, and syntax-error reporting all behave exactly as native — the diagrams are simply produced by
12.3.0.

### Two native rough edges fixed along the way

- **Syntax errors no longer leave junk in `document.body`.** When rendering fails, Mermaid first draws an
  error placeholder marked `aria-roledescription="error"` into the body (with a viewBox as large as
  `0 0 2412 724`). SiYuan only removes the span for its own `#id`, so the outer `div#d<id>` stays behind
  forever. The plugin sets `suppressErrorRendering: true` and also sweeps up any leftover nodes in its
  catch handler.
- **Missing external diagram resources no longer degrade silently.** See step 4 above.

### Validation on a real install

Measured on a real SiYuan 3.8.6-alpha.9 install:

- **31 Mermaid blocks across 21 documents** in one workspace: all rendered, **0 failures**.
- Block-by-block SVG hash comparison against the bundled 11.16.1 output: **every block differs**.
- Repeatability: a single document with 4 blocks reports `changed=0 unchanged=4` on repeated runs.
- Enable/disable switching: **9 of 9 assertions passed**.

## Installation

Copy the whole `siyuan-mermaid-next` directory into your workspace's plugin folder:

```
<workspace>/data/plugins/siyuan-mermaid-next/
```

Then enable it under **SiYuan → Settings → Marketplace → Downloaded**, or restart SiYuan. (Optionally,
before enabling you can confirm that `data/storage/petal/petals.json` contains an entry with
`"name": "siyuan-mermaid-next"`.)

## Settings

| Setting | Description |
| --- | --- |
| Enable Mermaid 12 rendering | Turning it off **immediately** hands rendering back to the bundled 11.16.1 and re-renders the current document — no UI reload required |
| Theme | `auto` follows SiYuan's light/dark mode (matching native behavior); or force `default` / `base` / `dark` / `forest` / `neutral` / `neo` / `neo-dark` / `redux` |
| Look | `classic`, `handDrawn`, or `neo` (Mermaid 12's new look) |
| Font size | Base font size of the diagram, in px. At the default of `16` each theme keeps its own sizing; once changed, everything scales to this value |
| HTML labels | Lets node text contain inline Markdown (bold, code, and so on) |
| Responsive width | Constrains diagram width to the width of the code block |
| Sequence numbers | Corresponds to native `sequence.showSequenceNumbers` |
| Source limit | Upper bound on diagram source size, to keep oversized diagrams from freezing the editor |
| Edge limit | Upper bound on edge count, for the same reason |
| Apply now | Commits the settings and re-renders the current document without reloading |

> **Implementation detail on font size.** In Mermaid 12 the top-level `config.fontSize` has **no effect
> whatsoever** on flowcharts (the HTML-label path) — in testing, the 16/22/30 dropdown values all left
> labels at 14px. What actually works is `themeVariables.fontSize`. But its default of 16 does not match
> the per-theme sizes (auto/default use 14px, dark uses 16px), so injecting it unconditionally would make
> the default output diverge from native. The plugin therefore **only injects it once you have explicitly
> changed the font size**. Conversely, `themeVariables.fontSize` changes only the font size, never the
> palette — across the 9 themes, `fill` / `stroke` / `labelColor` stay identical.

Saving the panel re-renders the current document automatically. The same actions are also reachable from
the top-bar button and the command palette:

- Command **Re-render Mermaid (mermaid 12)**
- Command **Show Mermaid engine status** (the dialog shows the engine, the script, and the effective
  configuration as JSON)

## Diagram type support

12.3.0 supports a larger set of diagram types than the bundled 11.16.1, and everything built in works out
of the box:

- **Fully built in:** `flowchart` / `flowchart-v2` / `flowchart-elk`, `sequence`, `class`, `state`, `er`,
  `journey`, `gantt`, `pie`, `quadrantChart`, `requirement`, `gitGraph`, `mindmap`, `timeline`, `sankey`,
  `xychart`, `block`, `packet`, `architecture`, `kanban`, `radar`, `treemap`, `venn`, `wardley`, `cynefin`,
  `ishikawa`, `treeView`, `c4`, `railroad`, and more.
- **ELK layout is built in** (`layout: 'elk'`) — no extra package to install.
- `zenuml` and `layout: 'tidy-tree'` come from resources SiYuan ships alongside; the plugin forwards their
  registration to 12.3.0.

> Note that Mermaid 12 defaults `logLevel` to 5 (`fatal`), so a **misspelled layout name falls back to
> dagre silently**, with nothing printed to the console. That is upstream behavior; the plugin cannot
> report it on your behalf.

## Compatibility

- SiYuan `3.8.0+` (`minAppVersion: 3.8.0`); works on desktop, mobile, and in the browser.
- **OS-independent:** the plugin runs entirely in the SiYuan front end (Electron, mobile WebView, or
  browser) and touches no native modules, so Windows, macOS, Linux, Android and iOS all run the same JS.
- **Old WebViews are covered:** Mermaid 12 calls `structuredClone` when rendering pie and radar charts,
  and SiYuan only started shipping `webview-compat.js` in 3.8.9. This plugin installs its own
  `structuredClone` and `Object.groupBy` shims before the engine loads, so pie/radar charts do not fail
  with `structuredClone is not a function` on older engines (Chrome < 98, Safari < 15.4).
- **May conflict** with third-party Mermaid plugins such as "Mermaid visual two-way editing" — they
  modify the same rendering chain, so only one should be enabled at a time.
- On SiYuan versions that still bundle 11.16.1 nothing is affected; if the plugin fails to load it falls
  back to native rendering automatically and shows a notice.

## Uninstalling and rollback

Both routes work, and **neither requires restarting SiYuan**:

- Turn off **Enable Mermaid 12 rendering** in the settings panel → `window.mermaid` is restored
  immediately and the placeholder `<script>` is removed; the native injector installs 11.16.1 again on the
  next render, and the current document is re-rendered with the old engine.
- Disable or uninstall the plugin in the marketplace → `onunload()` performs the same restoration and
  re-render.

> **Why rollback is reliable:** the plugin modifies no SiYuan files. It does only two things, both
> reversible at runtime — it occupies a `<script id="protyleMermaidScript">`, and it installs a restorable
> property descriptor on `window.mermaid`. The original state of both is snapshotted at `install()` time
> (`originalDescriptor` / `hadOwnMermaid` / `originalMermaid`).

## Directory layout

```
siyuan-mermaid-next/
├── index.js               plugin body (engine proxy + settings panel + commands/top bar)
├── index.css              styles for the settings panel and diagnostics dialog
├── plugin.json            plugin metadata
├── i18n/{zh_CN,en_US}.json
├── icon.png / preview.png
└── vendor/mermaid.min.js  Mermaid 12.3.0 UMD build (5.3 MB)
```

## License

The plugin code is MIT. `vendor/mermaid.min.js` is the official 12.3.0 build artifact of
[Mermaid](https://github.com/mermaid-js/mermaid) and is distributed under its MIT license.
