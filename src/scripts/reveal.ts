// Sections enter once, from below, as they come into view (see [data-reveal] in global.css).
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      observer.unobserve(entry.target);
    }
  },
  { rootMargin: "0px 0px -8% 0px" },
);

for (const el of document.querySelectorAll("[data-reveal]")) observer.observe(el);
