/* ── Scroll reveal ─────────────────────────────────────────── */
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

/* ── Staggered children ─────────────────────────────────────── */
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

/* ── Card spotlight (Linear-style torch) ───────────────────── */
for (const card of document.querySelectorAll(".feature-card")) {
  card.addEventListener("mousemove", (e) => {
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mouse-x", `${e.clientX - rect.left}px`);
    card.style.setProperty("--mouse-y", `${e.clientY - rect.top}px`);
  });
}

/* ── Count-up ───────────────────────────────────────────────── */
const countUp = (el) => {
  const target = Number.parseInt(el.dataset.count, 10);
  const suffix = el.dataset.suffix ?? "";
  const duration = 1400;
  const start = performance.now();

  const tick = (now) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - (1 - progress) ** 3;
    el.textContent = `${Math.floor(eased * target)}${suffix}`;
    if (progress < 1) requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
};

const countObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        countUp(entry.target);
        countObserver.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.5 },
);

for (const el of document.querySelectorAll("[data-count]")) {
  countObserver.observe(el);
}
