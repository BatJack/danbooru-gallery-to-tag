const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "js", "scroll-top.js"), "utf8");

function loadModule({ reducedMotion = false } = {}) {
    const scrollCalls = [];
    const scrollListeners = [];
    const window = {
        DG: {},
        scrollY: 0,
        scrollTo(options) {
            scrollCalls.push(options);
        },
        addEventListener(type, handler) {
            if (type === "scroll") {
                scrollListeners.push(handler);
            }
        },
        matchMedia() {
            return { matches: reducedMotion };
        },
    };

    vm.runInNewContext(SOURCE, { window });
    return { api: window.DG.scrollTop, window, scrollCalls, scrollListeners };
}

function fakeButton() {
    const classes = new Set();
    const listeners = {};

    return {
        classList: {
            toggle(name, force) {
                const shouldAdd = force === undefined ? !classes.has(name) : force;
                if (shouldAdd) {
                    classes.add(name);
                } else {
                    classes.delete(name);
                }
            },
            contains(name) {
                return classes.has(name);
            },
        },
        addEventListener(type, handler) {
            listeners[type] = handler;
        },
        click() {
            listeners.click?.();
        },
    };
}

test("shows only after scrolling past the threshold", () => {
    const { api } = loadModule();

    assert.equal(api.shouldShow(0), false);
    assert.equal(api.shouldShow(api.SHOW_AFTER_PX), false);
    assert.equal(api.shouldShow(api.SHOW_AFTER_PX + 1), true);
});

test("syncButton toggles the visible class from scroll position", () => {
    const { api } = loadModule();
    const button = fakeButton();

    api.syncButton(button, 0);
    assert.equal(button.classList.contains("is-visible"), false);

    api.syncButton(button, 1000);
    assert.equal(button.classList.contains("is-visible"), true);
});

test("clicking the button scrolls smoothly to the top", () => {
    const { api, scrollCalls } = loadModule();
    const button = fakeButton();

    api.bind(button);
    button.click();

    assert.equal(scrollCalls.length, 1);
    assert.equal(scrollCalls[0].top, 0);
    assert.equal(scrollCalls[0].behavior, "smooth");
});

test("binding updates visibility when the page scrolls", () => {
    const { api, window, scrollListeners } = loadModule();
    const button = fakeButton();

    api.bind(button);
    assert.equal(button.classList.contains("is-visible"), false);

    window.scrollY = 1000;
    scrollListeners.forEach((listener) => listener());
    assert.equal(button.classList.contains("is-visible"), true);
});

test("reduced-motion preference uses instant scrolling", () => {
    const { api, scrollCalls } = loadModule({ reducedMotion: true });

    api.scrollToTop();

    assert.equal(scrollCalls.length, 1);
    assert.equal(scrollCalls[0].top, 0);
    assert.equal(scrollCalls[0].behavior, "auto");
});
