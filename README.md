# siyuan-mermaid-next · Mermaid 12 渲染增强

用 **Mermaid 官方最新版 12.3.0** 替换思源笔记内置的 Mermaid 11.16.1，**仍然是文档内直接渲染**——
你在代码块里写 Mermaid 源码，思源照常把它渲染成图，只是底层引擎换成了新版。

## 这个插件做了什么

思源（3.8.6-alpha.9）内置的 Mermaid 是 **11.16.1**。它的渲染流程本身是好的（幂等标记、图标栏、
净化、折叠块延迟渲染、语法报错提示都在），问题只在引擎版本。所以本插件**不重写渲染流程**，
只做「换引擎」这一件事：

1. **抢占注入位**：思源用 `loadScript(url, "protyleMermaidScript")` 懒加载 Mermaid，且这个函数
   一进来就 `if (document.getElementById(id)) return`。插件先把自己的 vendor 脚本放在同一个 id 上，
   思源就再也不会去加载 11.16.1。
2. **接管全局**：`window.mermaid` 被定义成一个代理对象（`get` 返回代理、`set` 接住真正的引擎）。
   vendor 是 UMD 构建，末尾执行 `globalThis["mermaid"] = ...`，会被这个 `set` 接住。
   于是思源原生代码里所有 `window.mermaid.render(...)` / `initialize(...)` 都落到 12.3.0 上。
3. **配置合并**：思源每次渲染前都会 `initialize(它自己的配置)`。代理拦下这次调用，把
   「思源原生配置 + 本插件默认配置 + 你的设置」深度合并后再交给真引擎，所以两边都不会被对方覆盖。
4. **注册容错**：思源按需加载 `mermaid-zenuml` / `mermaid-layout-tidy-tree` 再
   `registerExternalDiagrams` / `registerLayoutLoaders`。代理把这些调用排队到引擎就绪后转发，
   并做三重兜底：转发前 `filter(Boolean)`（资源没加载成功时思源会传 `[undefined]` 或 `undefined`）、
   同步 `try/catch`、以及**接住 async 注册返回的 rejected promise**。
   这三条缺一不可——`registerLayoutLoaders` 是同步函数（坏参数同步抛），而
   `registerExternalDiagrams` 是 async 的（坏参数不抛，返回 rejected promise，静默失败）。
   原生的 `.then` 链一旦 reject，整篇文档的图就都不渲染了，所以**失败只 warn 不抛**。

结果：编辑代码块、点刷新按钮、折叠块展开后延迟渲染、语法错误提示，全部和原生一致，
只是图形由 12.3.0 生成。

### 顺带修掉的两个原生小毛病

- **语法错误不再往 `document.body` 里塞垃圾图**：mermaid 渲染失败时默认会先画一张
  `aria-roledescription="error"` 的错误示意图留在 body 里（viewBox 大到 `0 0 2412 724`），
  而思源只清理它自己那个 `#id` 的 span，外层 `div#d<id>` 永远留着。
  插件设了 `suppressErrorRendering: true`，并在 catch 里顺手扫掉可能的残留节点。
- **外部图表资源缺失不再静默降级**：见上面第 4 条。

## 装法

本插件通过 GitHub Release 分发，两种装法任选其一。

**方式一：从 Release 下载 `package.zip`（推荐）**

1. 打开 https://github.com/winicle74-ux/siyuan-mermaid-next/releases/latest
2. 下载 `package.zip`
3. 解压得到 `siyuan-mermaid-next` 目录，整个放进工作空间的插件目录：

```
<工作空间>/data/plugins/siyuan-mermaid-next/
```

4. 重启思源，在 **设置 → 集市 → 已下载** 里启用它

**方式二：直接放源码目录**

把本仓库根目录的所有文件（`plugin.json`、`index.js`、`index.css`、`i18n/`、`vendor/` 等）复制到
`<工作空间>/data/plugins/siyuan-mermaid-next/`，重启思源即可。

> 启用后可以确认 `data/storage/petal/petals.json` 里有 `"name": "siyuan-mermaid-next"` 且 `"enabled": true`。
> 目录名必须是 `siyuan-mermaid-next`，要和 `plugin.json` 的 `name` 一致。

## 设置项

| 设置 | 说明 |
| --- | --- |
| 启用 Mermaid 12 渲染 | 关闭后**立即**交还思源内置 11.16.1 并重渲染当前文档，不需要重载界面 |
| 主题 | `auto` 跟随思源明暗模式（与原生一致），也可强制 `default` / `dark` / `forest` / `neutral` / `neo` / `neo-dark` / `redux` / `base` |
| 外观风格 | `classic` 常规、`handDrawn` 手绘风、`neo` Mermaid 12 的新版样式 |
| 字号 | 图的基准字号（px）。默认 16 时沿用各主题自身字号；改动后统一按此值缩放 |
| 使用 HTML 标签 | 开启后节点文本支持行内 Markdown（粗体、代码等） |
| 宽度自适应 | 图宽限制在代码块宽度内 |
| 时序图显示序号 | 对应原生 `sequence.showSequenceNumbers` |
| 源码上限 / 连线数上限 | 防止超大图卡死 |

> **关于字号的实现细节**：mermaid 12 里顶层 `config.fontSize` 对 flowchart（HTML 标签路径）
> **完全无效**，实测 16/22/30 下拉标签恒为 14px；真正生效的是 `themeVariables.fontSize`。
> 但默认值 16 与各主题自身字号不同（auto/default 是 14px、dark 是 16px），
> 无条件注入会让默认输出偏离原生，所以插件**只在你显式改过字号时才注入**。
> 反过来，`themeVariables.fontSize` 只改字号、不改配色（各主题 fill/stroke/labelColor 不变）。

改完点「保存」后自动重渲染当前文档；也可以用顶栏按钮或命令面板：

- 命令 `重新渲染 Mermaid（mermaid 12）`
- 命令 `查看 Mermaid 渲染引擎状态`（弹窗里是引擎、脚本、当前生效配置的 JSON）

## 图表类型支持

12.3.0 比内置的 11.16.1 多支持一批类型，且**自带的图类型都能直接用**：

- 完整内建：`flowchart` / `flowchart-v2` / `flowchart-elk`、`sequence`、`class`、`state`、
  `er`、`journey`、`gantt`、`pie`、`quadrantChart`、`requirement`、`gitGraph`、`mindmap`、
  `timeline`、`sankey`、`xychart`、`block`、`packet`、`architecture`、`kanban`、`radar`、
  `treemap`、`venn`、`wardley`、`cynefin`、`ishikawa`、`treeView`、`c4`、`railroad` 等。
- **ELK 布局已内置**（`layout: 'elk'`），不需要额外装包。
- `zenuml` 与 `layout: 'tidy-tree'` 由思源随附的资源提供，插件会把它们的注册转发给 12.3.0。

> 注意 mermaid 12 的 `logLevel` 默认是 5（fatal），所以 **layout 名字拼错会静默退回 dagre**，
> 控制台不会有任何提示。这是 mermaid 自身行为，插件无法代你报错。

## 兼容性

- 思源 `3.8.0+`（`minAppVersion: 3.8.0`），桌面端 / 移动端 / 浏览器端均可
- **操作系统无关**：插件本身只跑在思源前端（Electron / 移动端 WebView / 浏览器），
  不碰任何原生模块，所以 Windows、macOS、Linux、Android、iOS 都是同一份 JS
- **老 WebView 已自带兜底**：Mermaid 12 的饼图 / 雷达图在渲染时会调用 `structuredClone`，
  思源直到 3.8.9 才加 `webview-compat.js` 补这些平台 API。本插件在引擎安装前会自己补
  `structuredClone` 与 `Object.groupBy`，所以在 Chrome < 98 / Safari < 15.4 这类
  老内核上饼图、雷达图也不会报 `structuredClone is not a function`
- 与「Mermaid 双向可视化编辑」等第三方 Mermaid 插件**可能冲突**——它们也在改同一批渲染链路，
  建议只启用一个
- 插件加载失败时会自动回退到原生渲染并提示
- **已在 3.8.9 上实测通过**（原生 12.2.0 会让出位置给本插件）：21 篇文档 / 31 个块全部渲染成功，
  桌面端与移动端（430×932 窄屏）均 PASS，关闭开关能立即回滚到 12.2.0
- 3.8.9 的原生渲染改用了 **3 参 `mermaid.render(id, text, container)`**（在屏幕外容器里测量尺寸），
  再挂回块里；本插件的渲染代理对 2 参 / 3 参两种调用都做了转发，因此新旧内核都能用

### 关于思源自身版本

这个插件最初是为「思源内置 Mermaid 太旧」而写的。需要注意思源已经跟上来了：

| 思源版本 | 内置 Mermaid |
| --- | --- |
| 3.8.6 及更早 | 11.16.1 |
| 3.8.7 | 12.1.0 |
| 3.8.8 / 3.8.9 | 12.2.0 |

所以从 **3.8.8 起**，本插件的价值**不在于版本更新**了（12.2.0 与 12.3.0 的差距只有 BPMN 形状、
边箭头样式、`step` 动画、swimlane 修复、DOMPurify 3.4.17 安全修复这些），而在于：

- 思源原生的 mermaid 配置是**完全写死的**（`theme`、`htmlLabels`、`useMaxWidth`、`showSequenceNumbers`、
  gantt padding 全部硬编码，`conf.json` 里没有任何 mermaid 渲染配置项），本插件把这些暴露成设置项
- 主题 / 外观风格（`classic` / `handDrawn` / `neo`）/ 字号 / HTML 标签 / 宽度自适应可调
- 关闭后立即回滚到思源内置引擎，不改任何思源文件

如果你用的思源已经 ≥ 3.8.8 且不在意这些可配置项，可以不用装。

## 卸载回滚

两种方式都行，**都不需要重启思源**：

- 设置面板里关掉「启用 Mermaid 12 渲染」→ 立即还原 `window.mermaid`、摘掉占位 `<script>`，
  原生注入器下次会把 11.16.1 装回来，当前文档随即用旧引擎重渲染。
- 在集市里禁用/卸载插件 → `onunload()` 做同样的还原 + 重渲染。

> 为什么能回滚：插件没有修改任何思源文件，只做了两件**运行时可逆**的事——
> 占一个 `<script id="protyleMermaidScript">`、给 `window.mermaid` 装一个可还原的属性描述符。
> 两者的原始状态都在 `install()` 时存了快照（`originalDescriptor` / `hadOwnMermaid` / `originalMermaid`）。

## 目录结构

```
siyuan-mermaid-next/
├── index.js              插件主体（引擎代理 + 设置面板 + 命令/顶栏）
├── index.css             设置面板与诊断弹窗样式
├── plugin.json           插件元信息
├── i18n/{zh_CN,en_US}.json
├── icon.png / preview.png
└── vendor/mermaid.min.js mermaid 12.3.0 UMD 构建（5.3 MB）
```

## 许可

插件代码 MIT。`vendor/mermaid.min.js` 为 [Mermaid](https://github.com/mermaid-js/mermaid) 官方
12.3.0 构建产物，遵循其 MIT 许可。
