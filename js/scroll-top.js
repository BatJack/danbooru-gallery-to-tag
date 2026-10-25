/**
 * Back-to-top behavior for the static gallery.
 * Kept separate from core.js so the visibility/scroll rules are unit-testable.
 */
(function () {
    const DG = (window.DG = window.DG || {});
    const SHOW_AFTER_PX = 360;

    function currentScrollY() {
        return Number(window.scrollY || window.pageYOffset || 0);
    }

    function shouldShow(scrollY) {
        return Number(scrollY) > SHOW_AFTER_PX;
    }

    function syncButton(button, scrollY = currentScrollY()) {
        if (!button) {
            return false;
        }
        const visible = shouldShow(scrollY);
        button.classList.toggle("is-visible", visible);
        return visible;
    }

    function scrollToTop() {
        const reduceMotion = typeof window.matchMedia === "function"
            && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    }

    function bind(button) {
        if (!button) {
            return;
        }
        button.addEventListener("click", scrollToTop);
        window.addEventListener("scroll", () => syncButton(button), { passive: true });
        syncButton(button);
    }

    DG.scrollTop = {
        SHOW_AFTER_PX,
        shouldShow,
        syncButton,
        scrollToTop,
        bind,
    };
})();
