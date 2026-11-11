// ==UserScript==
// @name         Gelbooru 标签分类提取
// @namespace    danbooru-gallery-standalone
// @version      1.0.0
// @description  在 Gelbooru 帖子页按画师 / 版权 / 角色 / 普通 / 元数据分组展示标签，支持点击复制，配色对齐本项目
// @match        https://gelbooru.com/index.php*
// @match        https://*.gelbooru.com/index.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    const PANEL_ID = "gbt-panel";
    const TOAST_ID = "gbt-toast";
    const STORAGE_KEY = "gbt.collapsed";

    // 与本项目 core.js 的分类顺序一致
    const CATEGORY_ORDER = ["artist", "copyright", "character", "general", "meta"];
    const CATEGORY_LABEL = {
        artist: "画师",
        copyright: "版权",
        character: "角色",
        general: "普通",
        meta: "元数据",
    };
    const CATEGORY_STYLE = {
        artist: { background: "rgba(255, 219, 127, 0.10)", border: "rgba(255, 219, 127, 0.20)", color: "#f2d487" },
        copyright: { background: "rgba(255, 170, 185, 0.10)", border: "rgba(255, 170, 185, 0.20)", color: "#ffc0cd" },
        character: { background: "rgba(149, 224, 175, 0.10)", border: "rgba(149, 224, 175, 0.20)", color: "#9fe2b5" },
        general: { background: "rgba(172, 196, 255, 0.10)", border: "rgba(172, 196, 255, 0.20)", color: "#acc4ff" },
        meta: { background: "rgba(255, 255, 255, 0.06)", border: "rgba(255, 255, 255, 0.12)", color: "#e7eaf0" },
    };

    // 勾选的分类，只影响"复制勾选"；默认全选
    const pickedCategories = new Set(CATEGORY_ORDER);

    const STYLE_TEXT = `
#${PANEL_ID} {
    position: fixed;
    top: 80px;
    right: 16px;
    z-index: 2147483000;
    width: min(320px, calc(100vw - 32px));
    max-height: 72vh;
    display: flex;
    flex-direction: column;
    color: #e7eaf0;
    background: rgba(24, 26, 32, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    font: 13px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif;
    backdrop-filter: blur(8px);
}
#${PANEL_ID} * { box-sizing: border-box; }
#${PANEL_ID} .gbt-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
#${PANEL_ID} .gbt-title { font-weight: 600; }
#${PANEL_ID} .gbt-total { color: #9aa3b2; font-weight: 400; margin-left: 4px; }
#${PANEL_ID} .gbt-actions { margin-left: auto; display: flex; gap: 6px; }
#${PANEL_ID} button {
    font: inherit;
    color: inherit;
    cursor: pointer;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.06);
    padding: 3px 8px;
    transition: filter 0.12s ease, transform 0.12s ease;
}
#${PANEL_ID} button:hover { filter: brightness(1.15); }
#${PANEL_ID} .gbt-body { overflow: auto; padding: 8px 12px 12px; }
#${PANEL_ID} .gbt-body[hidden] { display: none; }
#${PANEL_ID} .gbt-section + .gbt-section { margin-top: 10px; }
#${PANEL_ID} .gbt-section-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    color: #9aa3b2;
    font-size: 12px;
}
#${PANEL_ID} .gbt-label { font-weight: 600; color: #cfd6e4; }
#${PANEL_ID} .gbt-count { color: #7d8698; }
#${PANEL_ID} .gbt-section-head button { margin-left: auto; padding: 1px 7px; font-size: 11px; }
#${PANEL_ID} .gbt-check {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
}
#${PANEL_ID} .gbt-check input {
    margin: 0;
    cursor: pointer;
    accent-color: #7ea6ff;
}
#${PANEL_ID} .gbt-chips { display: flex; flex-wrap: wrap; gap: 6px; }
#${PANEL_ID} .gbt-chip {
    padding: 4px 9px;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.35;
    max-width: 100%;
    overflow-wrap: anywhere;
}
#${PANEL_ID} .gbt-chip:hover { transform: translateY(-1px); filter: brightness(1.12); }
#${TOAST_ID} {
    position: fixed;
    left: 50%;
    bottom: 32px;
    transform: translateX(-50%);
    z-index: 2147483001;
    padding: 8px 14px;
    border-radius: 9px;
    background: rgba(24, 26, 32, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: #e7eaf0;
    font: 13px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.18s ease;
}
#${TOAST_ID}.is-visible { opacity: 1; }
@media (max-width: 860px) {
    #${PANEL_ID} { top: auto; bottom: 12px; right: 12px; max-height: 55vh; }
}
`;

    function classify(className) {
        const match = /(?:^|\s)tag-type-([a-z_-]+)(?:\s|$)/i.exec(className || "");
        const raw = match ? match[1].toLowerCase() : "general";
        if (raw === "metadata" || raw === "meta") return "meta";
        if (raw === "artist" || raw === "copyright" || raw === "character") return raw;
        return "general";
    }

    function extractTag(item) {
        const anchor = item.querySelector('a[href*="page=post"]') || item.querySelector('a[href*="tags="]');
        if (!anchor) return "";
        const href = anchor.getAttribute("href") || "";
        let tag = "";
        try {
            tag = new URL(href, location.origin).searchParams.get("tags") || "";
        } catch (error) {
            tag = "";
        }
        tag = tag.trim();
        if (!tag || /\s/.test(tag) || tag.startsWith("-") || tag.startsWith("?")) return "";
        return tag;
    }

    function readGroups() {
        const list = document.querySelector("#tag-list");
        if (!list) return null;

        const groups = { artist: [], copyright: [], character: [], general: [], meta: [] };
        const seen = new Set();

        for (const item of list.querySelectorAll("li")) {
            const tag = extractTag(item);
            if (!tag || seen.has(tag)) continue;
            seen.add(tag);
            groups[classify(item.className)].push(tag);
        }
        return groups;
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
            return;
        }
        fallbackCopy(text);
    }

    function fallbackCopy(text) {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        try {
            document.execCommand("copy");
        } catch (error) {
            /* 忽略：浏览器拒绝写入剪贴板 */
        }
        area.remove();
    }

    let toastTimer = 0;
    function toast(message) {
        let node = document.getElementById(TOAST_ID);
        if (!node) {
            node = document.createElement("div");
            node.id = TOAST_ID;
            document.body.appendChild(node);
        }
        node.textContent = message;
        node.classList.add("is-visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove("is-visible"), 1600);
    }

    function makeButton(text, title) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        if (title) button.title = title;
        return button;
    }

    function buildSection(category, tags) {
        const section = document.createElement("section");
        section.className = "gbt-section";

        const head = document.createElement("div");
        head.className = "gbt-section-head";

        const check = document.createElement("label");
        check.className = "gbt-check";

        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = pickedCategories.has(category);
        box.addEventListener("change", () => {
            if (box.checked) {
                pickedCategories.add(category);
            } else {
                pickedCategories.delete(category);
            }
        });

        const label = document.createElement("span");
        label.className = "gbt-label";
        label.textContent = CATEGORY_LABEL[category] || category;

        const count = document.createElement("span");
        count.className = "gbt-count";
        count.textContent = String(tags.length);

        check.append(box, label, count);

        const copyAll = makeButton("复制", `复制全部${CATEGORY_LABEL[category] || category}标签`);
        copyAll.addEventListener("click", () => {
            copyText(tags.join(", "));
            toast(`已复制 ${tags.length} 个${CATEGORY_LABEL[category] || category}标签`);
        });

        head.append(check, copyAll);

        const chips = document.createElement("div");
        chips.className = "gbt-chips";
        for (const tag of tags) {
            const chip = makeButton(tag, "点击复制该标签");
            const style = CATEGORY_STYLE[category] || CATEGORY_STYLE.general;
            chip.className = "gbt-chip";
            Object.assign(chip.style, style);
            chip.addEventListener("click", () => {
                copyText(tag);
                toast(`已复制：${tag}`);
            });
            chips.appendChild(chip);
        }

        section.append(head, chips);
        return section;
    }

    function buildPanel(groups) {
        const total = CATEGORY_ORDER.reduce((sum, category) => sum + groups[category].length, 0);

        const panel = document.createElement("div");
        panel.id = PANEL_ID;

        const head = document.createElement("div");
        head.className = "gbt-head";

        const title = document.createElement("span");
        title.className = "gbt-title";
        title.textContent = "标签分类";
        const totalNode = document.createElement("span");
        totalNode.className = "gbt-total";
        totalNode.textContent = `(${total})`;
        title.appendChild(totalNode);

        const actions = document.createElement("div");
        actions.className = "gbt-actions";

        const copyAll = makeButton("复制勾选", "复制勾选分类下的全部标签，用英文逗号加空格分隔");
        copyAll.addEventListener("click", () => {
            const picked = CATEGORY_ORDER.filter((category) => pickedCategories.has(category));
            if (!picked.length) {
                toast("请先勾选要复制的分类");
                return;
            }
            const all = picked.flatMap((category) => groups[category]);
            if (!all.length) {
                toast("勾选的分类没有标签");
                return;
            }
            copyText(all.join(", "));
            toast(`已复制 ${all.length} 个标签`);
        });

        const collapsed = localStorage.getItem(STORAGE_KEY) === "1";
        const toggle = makeButton(collapsed ? "展开" : "收起", "折叠 / 展开标签面板");

        const body = document.createElement("div");
        body.className = "gbt-body";
        body.hidden = collapsed;

        toggle.addEventListener("click", () => {
            body.hidden = !body.hidden;
            toggle.textContent = body.hidden ? "展开" : "收起";
            localStorage.setItem(STORAGE_KEY, body.hidden ? "1" : "0");
        });

        actions.append(copyAll, toggle);
        head.append(title, actions);
        panel.append(head, body);

        for (const category of CATEGORY_ORDER) {
            if (groups[category].length) {
                body.appendChild(buildSection(category, groups[category]));
            }
        }
        return panel;
    }

    function init() {
        if (document.getElementById(PANEL_ID)) return;
        if (!/^\/index\.php/.test(location.pathname)) return;

        const groups = readGroups();
        if (!groups) return;
        const total = CATEGORY_ORDER.reduce((sum, category) => sum + groups[category].length, 0);
        if (!total) return;

        const style = document.createElement("style");
        style.textContent = STYLE_TEXT;
        document.head.appendChild(style);
        document.body.appendChild(buildPanel(groups));
    }

    init();
})();
