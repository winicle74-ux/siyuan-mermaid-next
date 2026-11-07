"use strict";

/**
 * siyuan-mermaid-next
 * 用 mermaid 官方最新版（12.3.0）替换思源内置的 11.16.1，直接在文档中渲染。
 *
 * 实现思路（引擎劫持，不重写渲染流程）：
 *   1. 抢注原生脚本注入器使用的 <script id="protyleMermaidScript">，
 *      原生注入器 T(url, id) 只要 getElementById(id) 命中就立刻返回，不再注入 11.16.1。
 *   2. 同步安装 window.mermaid 的「占位代理」，让原生渲染代码拿到的永远是代理对象。
 *   3. 异步加载本插件目录下的 mermaid 12.3.0 UMD；它末尾执行
 *      globalThis["mermaid"] = ...，被我们 defineProperty 的 setter 接住 → 完成绑定。
 *   4. 绑定后把原生传入的 config 与用户设置深度合并后再交给真引擎 initialize，
 *      并给 registerIconPacks / registerExternalDiagrams 加上 try/catch（思源自带旧版
 *      zenuml / icons.json 与 12.x 未必兼容，失败不能连带整篇渲染中断）。
 *   5. 渲染流程（data-render 幂等、图标栏、DOMPurify 净化、错误提示、折叠块延迟）
 *      依旧由思源原生逻辑负责，因此行为与原生一致，只是跑的是 12.3.0。
 */

const siyuan = require("siyuan");

const PLUGIN_NAME = "siyuan-mermaid-next";
/** 插件自身版本，与 plugin.json 的 version 保持一致（集市更新时必须同步递增） */
const PLUGIN_VERSION = "1.0.2";
const ENGINE_VERSION = "12.3.0";

/** 原生注入器使用的脚本 id —— 必须占用它才能阻断内置 11.16.1 */
const SCRIPT_ID = "protyleMermaidScript";
/** 插件目录下的 12.3.0 产物，由内核静态托管 */
const VENDOR_URL = "/plugins/" + PLUGIN_NAME + "/vendor/mermaid.min.js?v=" + ENGINE_VERSION;

const LOG_PREFIX = "[mermaid-next]";

/** 引擎加载超时（毫秒）：超时后渲染请求会显式失败，而不是永久挂起。 */
const READY_TIMEOUT_MS = 20000;

/**
 * 基线配置：与思源原生 module 8496 里那份 C 保持一致。
 * 原生每次渲染前都会 initialize(C)，那份配置会覆盖成 nativeConfig；
 * 这里只是保证「原生还没 initialize 过」时也有安全默认值（尤其是 startOnLoad:false）。
 */
const BASE_CONFIG = {
    startOnLoad: false,
    securityLevel: "loose",
    fontFamily: "sans-serif",
    altFontFamily: "sans-serif",
    htmlLabels: true,
    // 语法错误时不要让 mermaid 往 document.body 里塞一张错误示意图：
    // 原生 catch 已经会显示错误文案，那张图只会变成清理不掉的垃圾节点。
    suppressErrorRendering: true,
    flowchart: { htmlLabels: true, useMaxWidth: true },
    sequence: {
        useMaxWidth: true,
        diagramMarginX: 8,
        diagramMarginY: 8,
        boxMargin: 8,
        showSequenceNumbers: true,
    },
    gantt: { leftPadding: 75, rightPadding: 20 },
};

const THEME_OPTIONS = ["auto", "default", "base", "dark", "forest", "neutral", "neo", "neo-dark", "redux"];
const LOOK_OPTIONS = ["classic", "handDrawn", "neo"];

const DEFAULT_SETTINGS = {
    enabled: true,
    theme: "auto",
    look: "classic",
    fontSize: 16,
    htmlLabels: true,
    useMaxWidth: true,
    sequenceNumbers: true,
    maxTextSize: 50000,
    maxEdges: 500,
};

const TOPBAR_ICON =
    '<svg viewBox="0 0 32 32" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 6h5v5H4zM23 6h5v5h-5zM13.5 21h5v5h-5z"/>' +
    '<path d="M9 8.5h13.5M6.5 11v7.5h7M25 11v7.5h-7"/></svg>';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, over) {
    const out = isPlainObject(base) ? Object.assign({}, base) : {};
    if (!isPlainObject(over)) return out;
    for (const key of Object.keys(over)) {
        const value = over[key];
        if (value === undefined) continue;
        if (isPlainObject(value) && isPlainObject(out[key])) {
            out[key] = deepMerge(out[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

function notice(msg, type) {
    try {
        if (siyuan && typeof siyuan.showMessage === "function") {
            siyuan.showMessage(msg, 4000, type || "info");
            return;
        }
    } catch (e) {
        /* ignore */
    }
    console.log(LOG_PREFIX, msg);
}

/* ------------------------------------------------------------------ */
/* 老内核 / 老 WebView 兼容层                                           */
/* ------------------------------------------------------------------ */

/**
 * Mermaid 12 用了一些比较新的平台 API。实测（tools/probe-oldapi2.mjs）：
 *   - pie / radar 两个图类型在 render 时直接调用 structuredClone，
 *     缺失时报 "structuredClone is not a function"；
 *   - 其余 22 种图类型在缺失 structuredClone / Object.groupBy /
 *     URL.parse / AbortSignal.any / Promise.withResolvers 时仍能渲染。
 *
 * 思源自己是到 3.8.9 才加 app/src/protyle/util/browserCompat.ts，
 * 在缺少这些 API 时才去拉 /stage/protyle/js/webview-compat.js 兜底。
 * 也就是说：3.8.9 之前的内核 + 老 Android WebView / 老 iOS Safari
 * （Chrome < 98、Safari < 15.4 一类）上，饼图和雷达图会直接报错。
 *
 * 这里只补「缺了就会真的崩」的那几个，纯增量、不覆盖浏览器已有实现：
 * 归一化用 structuredClone 的首个语义（失败即抛 DataCloneError），
 * 避免拖进来一个行为不一致的假实现。
 */
const installPlatformShims = () => {
    const applied = [];

    if (typeof globalThis.structuredClone !== "function") {
        const clone = (value, seen) => {
            if (value === null || typeof value !== "object") return value;
            if (typeof value === "function") throw new DOMException("function is not cloneable", "DataCloneError");
            const map = seen || new Map();
            if (map.has(value)) return map.get(value);
            if (value instanceof Date) return new Date(value.getTime());
            if (value instanceof RegExp) return new RegExp(value.source, value.flags);
            if (value instanceof ArrayBuffer) return value.slice(0);
            if (ArrayBuffer.isView(value)) {
                return new value.constructor(value.buffer.slice(0), value.byteOffset, value.length);
            }
            if (value instanceof Map) {
                const out = new Map();
                map.set(value, out);
                value.forEach((v, k) => out.set(clone(k, map), clone(v, map)));
                return out;
            }
            if (value instanceof Set) {
                const out = new Set();
                map.set(value, out);
                value.forEach((v) => out.add(clone(v, map)));
                return out;
            }
            if (Array.isArray(value)) {
                const out = [];
                map.set(value, out);
                value.forEach((v, i) => (out[i] = clone(v, map)));
                return out;
            }
            const out = Object.create(Object.getPrototypeOf(value));
            map.set(value, out);
            Object.keys(value).forEach((k) => (out[k] = clone(value[k], map)));
            return out;
        };
        try {
            Object.defineProperty(globalThis, "structuredClone", {
                configurable: true,
                writable: true,
                value: function structuredClone(value) {
                    return clone(value);
                },
            });
            applied.push("structuredClone");
        } catch (e) {
            /* 只读环境，放弃这一项 */
        }
    }

    // mermaid 12 的 syntax 校验里用了 Object.groupBy（仅在校验重复产生式时触发，
    // 正常渲染不会走到，但补上更稳妥，成本几乎为零）。
    if (typeof Object.groupBy !== "function") {
        try {
            Object.defineProperty(Object, "groupBy", {
                configurable: true,
                writable: true,
                value: function groupBy(items, callback) {
                    const out = Object.create(null);
                    if (items == null) return out;
                    let i = 0;
                    for (const item of items) {
                        const key = callback(item, i++);
                        (out[key] || (out[key] = [])).push(item);
                    }
                    return out;
                },
            });
            applied.push("Object.groupBy");
        } catch (e) {
            /* ignore */
        }
    }

    return applied;
};

/* ------------------------------------------------------------------ */
/* engine                                                             */
/* ------------------------------------------------------------------ */

class MermaidNextEngine {
    constructor() {
        this.real = null;
        /** idle | loading | ready | failed */
        this.status = "idle";
        this.version = ENGINE_VERSION;
        this.lastError = null;
        this.nativeConfig = null;
        this.userConfig = {};
        this.appliedConfig = null;
        /** 引擎就绪前原生调用 register* 的暂存队列 */
        this.queue = [];
        this.pendingParseErrorHandler = null;
        this.scriptEl = null;
        this.originalDescriptor = null;
        this.hadOwnMermaid = false;
        this.originalMermaid = undefined;
        this.placeholder = null;
        this.ready = null;
        this._resolveReady = null;
        this._rejectReady = null;
        this._readyTimer = null;
    }

    /* ---------------- 占位代理 ---------------- */

    _buildPlaceholder() {
        const engine = this;
        const ph = {
            __mermaidNext: true,
            get version() {
                return ENGINE_VERSION;
            },
            get __engine() {
                return engine;
            },
            initialize: (cfg) => engine.handleInitialize(cfg),
            render: (id, text, container) => engine.handleRender(id, text, container),
            parse: (...a) => engine.callReal("parse", a),
            run: (...a) => engine.callReal("run", a),
            init: (...a) => engine.callReal("init", a),
            detectType: (...a) => engine.callReal("detectType", a),
            contentLoaded: () => engine.callReal("contentLoaded", []),
            getRegisteredDiagramsMetadata: () =>
                engine.real && typeof engine.real.getRegisteredDiagramsMetadata === "function"
                    ? engine.real.getRegisteredDiagramsMetadata()
                    : [],
            setParseErrorHandler: (fn) => engine.handleParseErrorHandler(fn),
            registerIconPacks: (packs) => engine.handleRegister("registerIconPacks", packs),
            registerExternalDiagrams: (diagrams, opts) =>
                engine.handleRegister("registerExternalDiagrams", diagrams, opts),
            registerLayoutLoaders: (loaders) => engine.handleRegister("registerLayoutLoaders", loaders),
        };
        try {
            Object.defineProperty(ph, "mermaidAPI", {
                enumerable: true,
                get() {
                    return engine.real ? engine.real.mermaidAPI : undefined;
                },
            });
            Object.defineProperty(ph, "startOnLoad", {
                enumerable: true,
                get() {
                    return engine.real ? engine.real.startOnLoad : false;
                },
                set(v) {
                    if (engine.real) engine.real.startOnLoad = v;
                },
            });
        } catch (e) {
            /* ignore */
        }
        return ph;
    }

    /* ---------------- 安装 / 卸载 ---------------- */

    install() {
        if (this.status === "ready" || this.status === "loading") return this;

        // 0) 老内核 / 老 WebView：先补齐 Mermaid 12 会真的用到的平台 API
        this.appliedShims = installPlatformShims();
        if (this.appliedShims.length > 0) {
            console.log(LOG_PREFIX, "已补齐平台 API:", this.appliedShims.join(", "));
        }

        this.placeholder = this._buildPlaceholder();
        this.ready = new Promise((resolve, reject) => {
            this._resolveReady = resolve;
            this._rejectReady = reject;
        });
        // 超时/卸载会让 ready 变成 rejected；页面里可能一时没有 render 在 await 它，
        // 这里挂一个空 catch，避免 "Unhandled promise rejection" 污染控制台。
        this.ready.catch(() => {});
        // 引擎加载不能无限等：原生 render() 会 await 我们，vendor 永远拿不到时
        // 整个渲染链路会永久挂起（块停在转圈状态）。超时后让 await 抛错，
        // 走原生 catch 分支显示错误，而不是静默卡死。
        this._readyTimer = setTimeout(() => {
            if (this.status === "ready") return;
            this.lastError = new Error("Mermaid " + ENGINE_VERSION + " 加载超时");
            console.error(LOG_PREFIX, this.lastError.message);
            this.status = "failed";
            if (this._rejectReady) {
                this._rejectReady(this.lastError);
                this._rejectReady = null;
                this._resolveReady = null;
            }
        }, READY_TIMEOUT_MS);

        // 1) 接管 window.mermaid（含已有的 11.16.1）
        this.hadOwnMermaid = Object.prototype.hasOwnProperty.call(window, "mermaid");
        this.originalMermaid = window.mermaid;
        try {
            this.originalDescriptor = Object.getOwnPropertyDescriptor(window, "mermaid") || null;
        } catch (e) {
            this.originalDescriptor = null;
        }
        const engine = this;
        try {
            Object.defineProperty(window, "mermaid", {
                configurable: true,
                enumerable: true,
                get() {
                    return engine.placeholder;
                },
                set(value) {
                    engine._bindReal(value);
                },
            });
        } catch (e) {
            this.lastError = e;
            console.error(LOG_PREFIX, "无法接管 window.mermaid", e);
            this.status = "failed";
            return this;
        }

        // 2) 抢注原生注入器的脚本 id，并让它指向 12.3.0
        this._occupyScriptSlot();

        this.status = "loading";
        window.__mermaidNextVersion = ENGINE_VERSION;
        return this;
    }

    _occupyScriptSlot() {
        const existing = document.getElementById(SCRIPT_ID);
        if (existing) existing.remove();

        const script = document.createElement("script");
        script.id = SCRIPT_ID;
        script.async = true;
        script.src = VENDOR_URL;
        script.setAttribute("data-siyuan-mermaid-next", "1");
        script.addEventListener("load", () => {
            // UMD 已经执行，正常情况下 setter 已把 real 绑上；这里兜底
            if (!this.real && window.__esbuild_esm_mermaid_nm) {
                try {
                    const mod = window.__esbuild_esm_mermaid_nm.mermaid;
                    this._bindReal(mod && mod.default ? mod.default : mod);
                } catch (e) {
                    console.error(LOG_PREFIX, "从全局命名空间取回 mermaid 失败", e);
                }
            }
            this._cleanupGlobals();
        });
        script.addEventListener("error", () => {
            this.lastError = new Error("无法加载 " + VENDOR_URL);
            console.error(LOG_PREFIX, this.lastError.message);
            script.remove();
            this._release();
            notice("Mermaid 12.3.0 引擎加载失败，已回退到思源内置版本", "error");
        });
        this.scriptEl = script;
        document.head.appendChild(script);
    }

    _cleanupGlobals() {
        try {
            delete window.__esbuild_esm_mermaid_nm;
        } catch (e) {
            /* ignore */
        }
    }

    _bindReal(value) {
        if (!value || typeof value !== "object") return;
        if (this.real === value) return;
        this.real = value;
        this.status = "ready";
        this.lastError = null;
        if (this._readyTimer) {
            clearTimeout(this._readyTimer);
            this._readyTimer = null;
        }

        // 原生 zenuml / icons.json 是给 11.x 准备的，12.x 未必认；失败只影响对应图表，
        // 不能把整篇渲染链路打断（原生 .then 链一旦 reject 就完全不再渲染）。
        this._flushQueue();
        if (this.pendingParseErrorHandler) {
            this._safeCall("setParseErrorHandler", [this.pendingParseErrorHandler]);
            this.pendingParseErrorHandler = null;
        }
        this.applyConfig();

        if (this._resolveReady) {
            this._resolveReady(this.real);
            this._resolveReady = null;
        }
        console.log(LOG_PREFIX, "engine ready:", ENGINE_VERSION);
        try {
            window.dispatchEvent(
                new CustomEvent("siyuan-mermaid-next:ready", { detail: { version: ENGINE_VERSION } })
            );
        } catch (e) {
            /* ignore */
        }
    }

    _flushQueue() {
        const queue = this.queue;
        this.queue = [];
        for (const [name, payload, extra] of queue) {
            this._applyRegister(name, payload, extra);
        }
    }

    _release() {
        if (this._readyTimer) {
            clearTimeout(this._readyTimer);
            this._readyTimer = null;
        }
        // 还没就绪就卸载：让所有 await this.ready 的调用立刻失败，
        // 而不是永远挂着（原生 render 的 await 会被它的 catch 接住）。
        if (this.status !== "ready" && this._rejectReady) {
            this._rejectReady(new Error(LOG_PREFIX + " 引擎已卸载"));
            this._rejectReady = null;
            this._resolveReady = null;
        }
        try {
            if (this.scriptEl) this.scriptEl.remove();
        } catch (e) {
            /* ignore */
        }
        try {
            // 占位脚本去掉后，原生注入器下次会重新注入 11.16.1
            const slot = document.getElementById(SCRIPT_ID);
            if (slot && slot.getAttribute("data-siyuan-mermaid-next") === "1") slot.remove();
        } catch (e) {
            /* ignore */
        }
        try {
            if (this.originalDescriptor) {
                Object.defineProperty(window, "mermaid", this.originalDescriptor);
            } else if (this.hadOwnMermaid) {
                window.mermaid = this.originalMermaid;
            } else {
                delete window.mermaid;
            }
        } catch (e) {
            /* ignore */
        }
        try {
            delete window.__mermaidNextVersion;
        } catch (e) {
            /* ignore */
        }
        this.status = "idle";
    }

    destroy() {
        this._release();
        this.real = null;
        this.queue = [];
        this.nativeConfig = null;
        this.appliedConfig = null;
    }

    /* ---------------- 转发 ---------------- */

    async callReal(name, args) {
        try {
            await this.ready;
        } catch (e) {
            throw new Error(LOG_PREFIX + " mermaid." + name + " 不可用：" + (e && e.message ? e.message : e));
        }
        if (!this.real || typeof this.real[name] !== "function") {
            throw new Error(LOG_PREFIX + " mermaid." + name + " 不可用");
        }
        return this.real[name](...args);
    }

    _safeCall(name, args) {
        if (!this.real || typeof this.real[name] !== "function") return undefined;
        try {
            return this.real[name](...args);
        } catch (e) {
            console.warn(LOG_PREFIX, "mermaid." + name + " 调用失败（已忽略）", e);
            return undefined;
        }
    }

    async handleRender(id, text, container) {
        try {
            await this.ready;
        } catch (e) {
            // 引擎不可用：把原因抛给原生的 catch 分支，它会渲染错误提示。
            throw new Error(
                LOG_PREFIX + " mermaid " + ENGINE_VERSION + " 引擎不可用：" + (e && e.message ? e.message : e)
            );
        }
        if (!this.real) throw new Error(LOG_PREFIX + " mermaid 引擎未就绪");
        try {
            if (container === undefined) return await this.real.render(id, text);
            return await this.real.render(id, text, container);
        } catch (e) {
            // mermaid 渲染失败时可能在 body 里留下 <div id="d<id>"> 错误图；
            // 原生只清理 #<id> 那个 span，这个外层 div 得我们自己扫掉。
            this._sweepErrorNode(id);
            throw e;
        }
    }

    /** 清掉 mermaid 渲染失败时留在 body 里的错误图容器（d<id> / <id>）。 */
    _sweepErrorNode(id) {
        if (!id) return;
        for (const key of ["d" + id, id]) {
            try {
                const el = document.getElementById(key);
                if (el && el.parentElement && el.parentElement !== document.body) continue;
                if (el) el.remove();
            } catch (e) {
                /* ignore */
            }
        }
    }

    handleInitialize(cfg) {
        this.nativeConfig = isPlainObject(cfg) ? cfg : this.nativeConfig;
        if (this.real) this.applyConfig();
    }

    handleParseErrorHandler(fn) {
        this.pendingParseErrorHandler = fn;
        if (this.real) this._safeCall("setParseErrorHandler", [fn]);
    }

    handleRegister(name, payload, extra) {
        if (!this.real) {
            this.queue.push([name, payload, extra]);
            return Promise.resolve();
        }
        return Promise.resolve(this._applyRegister(name, payload, extra));
    }

    _applyRegister(name, payload, extra) {
        if (!this.real || typeof this.real[name] !== "function") return undefined;

        // 思源原生那几行是字面量转发：registerExternalDiagrams([window.zenuml]) /
        // registerLayoutLoaders(window.mermaidTidyTree)。资源没加载成功时传进来的是
        // [undefined] 或 undefined —— 前者会让 12.x 内部 reject，后者会同步抛
        // TypeError: r is not iterable。两种都必须在我们这层堵掉。
        const LIST_REGISTERS = { registerExternalDiagrams: 1, registerLayoutLoaders: 1, registerIconPacks: 1 };
        let args = payload;
        if (LIST_REGISTERS[name]) {
            if (!Array.isArray(args)) return undefined;
            args = args.filter(Boolean);
            if (args.length === 0) return undefined;
        }

        try {
            const result = extra === undefined ? this.real[name](args) : this.real[name](args, extra);
            // registerExternalDiagrams 是 async 的：坏参数不会同步抛，而是返回一个
            // rejected promise。原生链路是 await 它的，一旦 reject 整篇就再也不渲染了。
            if (result && typeof result.then === "function") {
                return result.then(
                    (v) => v,
                    (e) => {
                        console.warn(
                            LOG_PREFIX,
                            "mermaid." + name + " 注册被拒绝（已忽略，相关图表可能降级）",
                            e
                        );
                        return undefined;
                    }
                );
            }
            return result;
        } catch (e) {
            console.warn(LOG_PREFIX, "mermaid." + name + " 注册失败（已忽略，相关图表可能降级）", e);
            return undefined;
        }
    }

    /* ---------------- 配置 ---------------- */

    setUserConfig(cfg) {
        this.userConfig = isPlainObject(cfg) ? cfg : {};
        if (this.real) this.applyConfig();
    }

    buildConfig() {
        return deepMerge(deepMerge(BASE_CONFIG, this.nativeConfig || {}), this.userConfig);
    }

    applyConfig() {
        if (!this.real) return;
        const merged = this.buildConfig();
        try {
            this.real.initialize(merged);
            this.appliedConfig = merged;
        } catch (e) {
            console.error(LOG_PREFIX, "mermaid.initialize 失败", e);
        }
    }

    /* ---------------- 重渲染 ---------------- */

    /**
     * 把当前页面上已经渲染过的 mermaid 块全部重渲染一遍。
     * 只处理 data-render="true" 的块（正在编辑/尚未渲染的块由思源自己的流程接管）。
     */
    rerenderAll() {
        const blocks = Array.from(
            document.querySelectorAll('[data-type="NodeCodeBlock"][data-subtype="mermaid"][data-render="true"]')
        );
        if (blocks.length === 0) return 0;
        for (const block of blocks) block.removeAttribute("data-render");

        const method = siyuan && siyuan.ProtyleMethod;
        let done = 0;
        if (method && typeof method.mermaidRender === "function") {
            for (const block of blocks) {
                try {
                    method.mermaidRender(block);
                    done += 1;
                } catch (e) {
                    console.warn(LOG_PREFIX, "重渲染失败", e);
                }
            }
        } else {
            console.warn(LOG_PREFIX, "拿不到 ProtyleMethod.mermaidRender，无法主动重渲染");
        }
        return done;
    }

    report() {
        return {
            plugin: PLUGIN_NAME,
            engineVersion: ENGINE_VERSION,
            status: this.status,
            realBound: !!this.real,
            scriptId: SCRIPT_ID,
            scriptPresent: !!document.getElementById(SCRIPT_ID),
            scriptSrc: this.scriptEl ? this.scriptEl.src : null,
            nativeConfig: this.nativeConfig,
            userConfig: this.userConfig,
            appliedConfig: this.appliedConfig,
            lastError: this.lastError ? String(this.lastError && this.lastError.message) || String(this.lastError) : null,
        };
    }
}

/* ------------------------------------------------------------------ */
/* plugin                                                             */
/* ------------------------------------------------------------------ */

class MermaidNextPlugin extends siyuan.Plugin {
    constructor(options) {
        super(options);
        this.engine = null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS);
        this.setting = null;
        this._rerenderTimer = null;
    }

    _t(key, fallback) {
        const i18n = this.i18n;
        if (i18n && typeof i18n[key] === "string" && i18n[key]) return i18n[key];
        return fallback;
    }

    async onload() {
        await this.loadSettings();

        if (this.settings.enabled !== false) {
            this.installEngine();
        } else {
            console.log(LOG_PREFIX, "已按设置禁用（原生 11.16.1 保持生效）");
        }

        this.initSetting();

        this.addCommand({
            langKey: "rerenderMermaid",
            langText: this._t("command.rerender", "重新渲染 Mermaid（mermaid 12）"),
            editorCallback: () => this.rerenderNow(),
        });

        this.addCommand({
            langKey: "mermaidEngineInfo",
            langText: this._t("command.engineInfo", "查看 Mermaid 渲染引擎状态"),
            editorCallback: () => this.showEngineInfo(),
        });

        try {
            this.addTopBar({
                id: "mermaidNext",
                icon: TOPBAR_ICON,
                title: this._t("topbar.title", "Mermaid 12 渲染器"),
                position: "right",
                callback: () => {
                    const n = this.rerenderNow();
                    notice(n > 0 ? this._t("toast.rerender", "已重新渲染 ") + n + this._t("toast.blocks", " 个 Mermaid 图") : this._t("toast.none", "当前文档没有已渲染的 Mermaid 图"));
                },
            });
        } catch (e) {
            console.warn(LOG_PREFIX, "addTopBar 失败", e);
        }

        this.onEngineReady(() => {
            // 插件可能晚于文档渲染加载（例如刚启用插件），此时页面里是 11.16.1 的结果
            const n = this.rerenderNow();
            if (n > 0) console.log(LOG_PREFIX, "已用 12.3.0 重渲染", n, "个块");
        });
    }

    async onunload() {
        if (this._rerenderTimer) {
            clearTimeout(this._rerenderTimer);
            this._rerenderTimer = null;
        }
        const engine = this.engine;
        if (engine) {
            if (engine.status === "ready") {
                // 交还控制权后让思源用回内置版本
                engine.destroy();
                setTimeout(() => {
                    try {
                        this.rerenderAfterRestore();
                    } catch (e) {
                        /* ignore */
                    }
                }, 0);
            } else {
                engine.destroy();
            }
        }
        this.engine = null;
        if (window.__siyuanMermaidNext && window.__siyuanMermaidNext.plugin === this) {
            delete window.__siyuanMermaidNext;
        }
        console.log(LOG_PREFIX, "unloaded");
    }

    rerenderAfterRestore() {
        const blocks = Array.from(
            document.querySelectorAll('[data-type="NodeCodeBlock"][data-subtype="mermaid"][data-render="true"]')
        );
        for (const block of blocks) block.removeAttribute("data-render");
        const method = siyuan && siyuan.ProtyleMethod;
        if (method && typeof method.mermaidRender === "function") {
            for (const block of blocks) {
                try {
                    method.mermaidRender(block);
                } catch (e) {
                    /* ignore */
                }
            }
        }
    }

    /* ---------------- engine 生命周期 ---------------- */

    installEngine() {
        try {
            this.engine = new MermaidNextEngine();
            this.engine.install();
            this.engine.setUserConfig(this.buildUserConfig());
            window.__siyuanMermaidNext = {
                plugin: this,
                engine: this.engine,
                pluginVersion: PLUGIN_VERSION,
                version: ENGINE_VERSION,
                rerenderAll: () => this.rerenderNow(),
                report: () => this.engine.report(),
            };
            window.__mermaidNextVersion = ENGINE_VERSION;
        } catch (e) {
            console.error(LOG_PREFIX, "安装引擎失败，回退到原生渲染", e);
            notice("Mermaid 12 安装失败，已回退到思源内置渲染", "error");
            this.engine = null;
        }
    }

    onEngineReady(callback) {
        const engine = this.engine;
        if (!engine) return;
        if (engine.status === "ready") {
            try {
                callback();
            } catch (e) {
                console.warn(LOG_PREFIX, "onEngineReady 回调异常", e);
            }
            return;
        }
        const done = () => {
            window.removeEventListener("siyuan-mermaid-next:ready", done);
            try {
                callback();
            } catch (e) {
                console.warn(LOG_PREFIX, "onEngineReady 回调异常", e);
            }
        };
        window.addEventListener("siyuan-mermaid-next:ready", done);
        // 兜底：即便自定义事件丢了（比如引擎在监听前就绪），也在一个宏任务后再试一次
        setTimeout(() => {
            if (engine.status === "ready") done();
            else window.removeEventListener("siyuan-mermaid-next:ready", done);
        }, 1500);
    }

    /* ---------------- 设置 ---------------- */

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS);
        try {
            const saved = await this.loadData("settings");
            if (saved && typeof saved === "object" && !Array.isArray(saved)) {
                this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
            }
        } catch (e) {
            console.warn(LOG_PREFIX, "读取设置失败，使用默认值", e);
        }
        this.settings.fontSize = clampInt(this.settings.fontSize, DEFAULT_SETTINGS.fontSize, 8, 48);
        this.settings.maxTextSize = clampInt(this.settings.maxTextSize, DEFAULT_SETTINGS.maxTextSize, 1000, 1000000);
        this.settings.maxEdges = clampInt(this.settings.maxEdges, DEFAULT_SETTINGS.maxEdges, 10, 20000);
        if (THEME_OPTIONS.indexOf(this.settings.theme) < 0) this.settings.theme = "auto";
        if (LOOK_OPTIONS.indexOf(this.settings.look) < 0) this.settings.look = "classic";
    }

    async saveSettings() {
        try {
            await this.saveData("settings", this.settings);
        } catch (e) {
            console.warn(LOG_PREFIX, "保存设置失败", e);
        }
    }

    buildUserConfig() {
        const s = this.settings;
        const cfg = {};
        if (s.theme && s.theme !== "auto") cfg.theme = s.theme;
        if (s.look) cfg.look = s.look;
        if (Number.isFinite(s.fontSize)) {
            cfg.fontSize = s.fontSize;
            // mermaid 12 里顶层 fontSize 对 flowchart（htmlLabels 路径）无效，
            // 真正生效的是 themeVariables.fontSize。但默认值 16 与各主题自身的
            // 字号并不相同（auto/default 是 14px），所以只在用户显式改过字号时
            // 才注入，保证默认输出与原生一致。
            if (s.fontSize !== DEFAULT_SETTINGS.fontSize) {
                cfg.themeVariables = Object.assign({}, cfg.themeVariables, {
                    fontSize: s.fontSize + "px",
                });
            }
        }
        if (Number.isFinite(s.maxTextSize)) cfg.maxTextSize = s.maxTextSize;
        if (Number.isFinite(s.maxEdges)) cfg.maxEdges = s.maxEdges;
        cfg.htmlLabels = !!s.htmlLabels;
        cfg.flowchart = Object.assign({}, cfg.flowchart, {
            htmlLabels: !!s.htmlLabels,
            useMaxWidth: !!s.useMaxWidth,
        });
        cfg.sequence = Object.assign({}, cfg.sequence, {
            useMaxWidth: !!s.useMaxWidth,
            showSequenceNumbers: !!s.sequenceNumbers,
        });
        return cfg;
    }

    applySettings() {
        if (this.engine) this.engine.setUserConfig(this.buildUserConfig());
        this.scheduleRerender();
    }

    /**
     * 运行时开/关引擎接管，不需要重载界面。
     * 关：还原 window.mermaid 并摘掉占位 script → 原生注入器下次会重新加载 11.16.1。
     * 开：重新 install 并接管，随后重渲染让新引擎的图立刻出现。
     */
    setEngineEnabled(on) {
        if (on) {
            if (this.engine) return;
            this.installEngine();
            notice(this._t("toast.enabled", "已接管渲染，正在重新渲染…"));
            this.onEngineReady(() => this.rerenderNow());
            return;
        }
        const engine = this.engine;
        if (!engine) return;
        this.engine = null;
        try {
            engine.destroy();
        } catch (e) {
            console.warn(LOG_PREFIX, "释放引擎失败", e);
        }
        if (window.__siyuanMermaidNext) delete window.__siyuanMermaidNext;
        notice(this._t("toast.disabled", "已交还思源内置渲染，正在重新渲染…"));
        // 原生注入器是异步的，等它把 11.16.1 装回来再触发重渲染。
        setTimeout(() => {
            try {
                this.rerenderAfterRestore();
            } catch (e) {
                /* ignore */
            }
        }, 0);
    }

    scheduleRerender() {
        if (this._rerenderTimer) clearTimeout(this._rerenderTimer);
        this._rerenderTimer = setTimeout(() => {
            this._rerenderTimer = null;
            this.rerenderNow();
        }, 250);
    }

    rerenderNow() {
        if (!this.engine || this.engine.status !== "ready") return 0;
        return this.engine.rerenderAll();
    }

    engineStatusText() {
        if (!this.engine) return this._t("status.disabled", "已禁用：使用思源内置 Mermaid 11.16.1");
        switch (this.engine.status) {
            case "ready":
                return this._t("status.ready", "已接管：mermaid 12.3.0 正在渲染");
            case "loading":
                return this._t("status.loading", "正在加载 mermaid 12.3.0 …");
            case "failed":
                return this._t("status.failed", "加载失败：已回退到内置 11.16.1");
            default:
                return this._t("status.idle", "未启用");
        }
    }

    createSelect(options, value, onChange) {
        const select = document.createElement("select");
        select.className = "b3-select fn__flex-center fn__size200 siyuan-mermaid-next__select";
        for (const opt of options) {
            const el = document.createElement("option");
            el.value = opt.value;
            el.textContent = opt.label;
            if (opt.value === value) el.selected = true;
            select.appendChild(el);
        }
        select.addEventListener("change", () => onChange(select.value));
        return select;
    }

    createSwitch(checked, onChange) {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "b3-switch fn__flex-center";
        input.checked = !!checked;
        input.addEventListener("change", () => onChange(!!input.checked));
        return input;
    }

    createNumber(value, min, max, step, onChange) {
        const input = document.createElement("input");
        input.type = "number";
        input.className = "b3-text-field fn__flex-center fn__size200";
        input.value = String(value);
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.addEventListener("change", () => {
            const next = clampInt(input.value, value, min, max);
            input.value = String(next);
            onChange(next);
        });
        return input;
    }

    createButton(label, onClick) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "b3-button b3-button--outline fn__flex-center";
        btn.textContent = label;
        btn.addEventListener("click", () => onClick());
        return btn;
    }

    initSetting() {
        const t = (k, fb) => this._t(k, fb);
        this.setting = new siyuan.Setting({
            confirmCallback: () => {
                this.saveSettings();
                this.applySettings();
            },
        });

        this.setting.addItem({
            title: t("setting.engine.title", "渲染引擎"),
            description: t(
                "setting.engine.desc",
                "本插件用 mermaid 官方 12.3.0 取代思源内置的 11.16.1，文档中的代码块仍由思源原生流程渲染。"
            ),
            createActionElement: () => {
                const span = document.createElement("span");
                span.className = "b3-label__text siyuan-mermaid-next__engine";
                span.textContent = this.engineStatusText();
                return span;
            },
        });

        this.setting.addItem({
            title: t("setting.enabled.title", "启用 Mermaid 12 渲染"),
            description: t(
                "setting.enabled.desc",
                "关闭后立即交还思源内置 11.16.1 并重新渲染当前文档。"
            ),
            createActionElement: () =>
                this.createSwitch(this.settings.enabled, (v) => {
                    this.settings.enabled = v;
                    this.setEngineEnabled(v);
                }),
        });

        this.setting.addItem({
            title: t("setting.theme.title", "主题"),
            description: t("setting.theme.desc", "auto 跟随思源的明暗模式（与原生行为一致）。"),
            createActionElement: () =>
                this.createSelect(
                    THEME_OPTIONS.map((theme) => ({
                        value: theme,
                        label:
                            theme === "auto"
                                ? t("setting.theme.auto", "跟随思源（auto）")
                                : theme,
                    })),
                    this.settings.theme,
                    (v) => {
                        this.settings.theme = v;
                        this.applySettings();
                    }
                ),
        });

        this.setting.addItem({
            title: t("setting.look.title", "外观风格"),
            description: t("setting.look.desc", "handDrawn 为手绘风，neo 为 mermaid 12 的新版样式。"),
            createActionElement: () =>
                this.createSelect(
                    LOOK_OPTIONS.map((look) => ({ value: look, label: look })),
                    this.settings.look,
                    (v) => {
                        this.settings.look = v;
                        this.applySettings();
                    }
                ),
        });

        this.setting.addItem({
            title: t("setting.fontSize.title", "字号"),
            description: t("setting.fontSize.desc", "Mermaid 图的基准字号（px）。"),
            createActionElement: () =>
                this.createNumber(this.settings.fontSize, 8, 48, 1, (v) => {
                    this.settings.fontSize = v;
                    this.applySettings();
                }),
        });

        this.setting.addItem({
            title: t("setting.htmlLabels.title", "使用 HTML 标签"),
            description: t(
                "setting.htmlLabels.desc",
                "开启时节点文本支持 Markdown 行内语法（粗体、代码等），关闭则用纯 SVG 文本。"
            ),
            createActionElement: () =>
                this.createSwitch(this.settings.htmlLabels, (v) => {
                    this.settings.htmlLabels = v;
                    this.applySettings();
                }),
        });

        this.setting.addItem({
            title: t("setting.useMaxWidth.title", "宽度自适应"),
            description: t("setting.useMaxWidth.desc", "开启后图形宽度限制在代码块宽度内。"),
            createActionElement: () =>
                this.createSwitch(this.settings.useMaxWidth, (v) => {
                    this.settings.useMaxWidth = v;
                    this.applySettings();
                }),
        });

        this.setting.addItem({
            title: t("setting.sequenceNumbers.title", "时序图显示序号"),
            description: t("setting.sequenceNumbers.desc", "与时序图原生行为一致，默认开启。"),
            createActionElement: () =>
                this.createSwitch(this.settings.sequenceNumbers, (v) => {
                    this.settings.sequenceNumbers = v;
                    this.applySettings();
                }),
        });

        this.setting.addItem({
            title: t("setting.maxTextSize.title", "源码上限"),
            description: t("setting.maxTextSize.desc", "单个 Mermaid 代码块允许的最大字符数。"),
            createActionElement: () =>
                this.createNumber(this.settings.maxTextSize, 1000, 1000000, 1000, (v) => {
                    this.settings.maxTextSize = v;
                    this.applySettings();
                }),
        });

        this.setting.addItem({
            title: t("setting.maxEdges.title", "连线数上限"),
            description: t("setting.maxEdges.desc", "超过上限会渲染失败，用于防止超大图卡死。"),
            createActionElement: () =>
                this.createNumber(this.settings.maxEdges, 10, 20000, 10, (v) => {
                    this.settings.maxEdges = v;
                    this.applySettings();
                }),
        });

        this.setting.addItem({
            title: t("setting.action.title", "立即生效"),
            description: t("setting.action.desc", "改完设置后可以马上重渲染当前文档里的 Mermaid 图。"),
            createActionElement: () => {
                const box = document.createElement("div");
                box.className = "fn__flex siyuan-mermaid-next__actions";
                box.appendChild(
                    this.createButton(t("button.rerender", "重新渲染"), () => {
                        const n = this.rerenderNow();
                        notice(
                            n > 0
                                ? t("toast.rerender", "已重新渲染 ") + n + t("toast.blocks", " 个 Mermaid 图")
                                : t("toast.none", "当前文档没有已渲染的 Mermaid 图")
                        );
                    })
                );
                box.appendChild(
                    this.createButton(t("button.diagnostics", "引擎状态"), () => this.showEngineInfo())
                );
                return box;
            },
        });
    }

    /** 思源版本号：不同版本放在不同位置，逐个探测。 */
    getSiyuanVersion() {
        const cfg = window.siyuan && window.siyuan.config;
        const cands = [
            cfg && cfg.system && cfg.system.kernelVersion,
            cfg && cfg.system && cfg.system.version,
            window.siyuan && window.siyuan.version,
            window.siyuan && window.siyuan.kernelVersion,
        ];
        for (const v of cands) {
            if (typeof v === "string" && v) return v;
        }
        return "unknown";
    }

    showEngineInfo() {
        const engine = this.engine;
        const report = engine ? engine.report() : { status: "disabled" };
        const diag = {
            plugin: PLUGIN_NAME,
            pluginVersion: PLUGIN_VERSION,
            engineVersion: ENGINE_VERSION,
            statusText: this.engineStatusText(),
            nativeMermaidScript: Array.from(document.querySelectorAll("script[id]"))
                .filter((s) => /mermaid/i.test(s.id))
                .map((s) => ({ id: s.id, src: s.src || "(inline)", next: s.getAttribute("data-siyuan-mermaid-next") })),
            engine: report,
            renderedBlocks: document.querySelectorAll(
                '[data-type="NodeCodeBlock"][data-subtype="mermaid"][data-render="true"] svg'
            ).length,
            siyuanVersion: this.getSiyuanVersion(),
            engineReadyAwaitable: !!(engine && engine.ready),
        };
        const content =
            '<div class="b3-dialog__content"><pre class="siyuan-mermaid-next__diag">' +
            Lute.EscapeHTMLStr(JSON.stringify(diag, null, 2)) +
            "</pre></div>";
        try {
            new siyuan.Dialog({
                title: this._t("dialog.diagnostics", "Mermaid 渲染引擎状态"),
                content,
                width: "min(760px, 92vw)",
                height: "70vh",
            });
        } catch (e) {
            console.log(LOG_PREFIX, "engine info", diag);
            notice("引擎状态已输出到控制台", "info");
        }
    }
}

exports.default = MermaidNextPlugin;
