/* ── Animations module ─────────────────────────────────────── */
/* Enhanced animation system for the new landing page.        */
/* Respects prefers-reduced-motion: skip all animations.     */

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── Shared RAF-gated scroll handler (module scope) ─────────── */
// All scroll-driven tasks register here; a single rAF call per frame
// prevents multiple independent layout reads and style mutations.
const scrollTasks = [];
let scrollRaf = 0;
if (!prefersReducedMotion) {
  window.addEventListener(
    "scroll",
    () => {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        for (const task of scrollTasks) task();
      });
    },
    { passive: true },
  );
}

/* ── Scroll reveal ─────────────────────────────────────────── */
if (!prefersReducedMotion) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          revealObserver.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.1 },
  );

  for (const el of document.querySelectorAll(".reveal:not([data-stagger] .reveal)")) {
    revealObserver.observe(el);
  }

  /* ── Staggered children ─────────────────────────────────── */
  const staggerObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const items = entry.target.querySelectorAll(".stagger-item");
          items.forEach((item, i) => {
            item.style.transitionDelay = `${i * 90}ms`;
            item.classList.add("visible");
          });
          staggerObserver.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.1 },
  );

  for (const container of document.querySelectorAll("[data-stagger]")) {
    staggerObserver.observe(container);
  }

  /* ── Showcase pipeline observer ─────────────────────────── */
  const pipelineNodes = document.querySelectorAll(".l-pipeline-node");

  const stepObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const pipelineIdx = parseInt(entry.target.dataset.pipelineTarget ?? entry.target.dataset.stepIndex, 10);

          // Activate corresponding pipeline node
          for (const node of pipelineNodes) {
            node.removeAttribute("data-active");
          }
          if (pipelineNodes[pipelineIdx]) {
            pipelineNodes[pipelineIdx].setAttribute("data-active", "");
          }
        }
      }
    },
    { threshold: 0.3 },
  );

  for (const step of document.querySelectorAll(".showcase-step")) {
    stepObserver.observe(step);
  }
} else {
  // If reduced motion, make all reveal elements visible immediately
  for (const el of document.querySelectorAll(".reveal, .stagger-item")) {
    el.classList.add("visible");
  }
}

/* ── CTA frontal entry (scroll-driven 3D zoom) ─────────────── */
const ctaSection = document.querySelector(".l-cta");
if (ctaSection) {
  if (prefersReducedMotion) {
    ctaSection.style.opacity = "1";
  } else {
    // Start hidden and pushed back in Z
    ctaSection.style.opacity = "0";
    ctaSection.style.transform = "perspective(1000px) translateZ(-200px) scale(0.86)";
    ctaSection.style.willChange = "transform, opacity";

    const updateCta = () => {
      const rect = ctaSection.getBoundingClientRect();
      const viewH = window.innerHeight;
      // 0 when section top is at viewport bottom, 1 when section top is 55% up the viewport
      const raw = (viewH - rect.top) / (viewH * 0.55);
      const p = Math.max(0, Math.min(1, raw));

      const tz = -200 * (1 - p);
      const scale = 0.86 + 0.14 * p;
      const opacity = p < 0.3 ? p / 0.3 : 1; // fade in over first 30% of progress

      ctaSection.style.transform = `perspective(1000px) translateZ(${tz}px) scale(${scale})`;
      ctaSection.style.opacity = String(opacity);

      if (p >= 1) ctaSection.style.willChange = "auto";
    };

    scrollTasks.push(updateCta);
    updateCta(); // check initial position (e.g. if page reloads mid-scroll)
  }
}
