# bounda.dev

The landing page for [Bounda](https://github.com/bounda-dev/bounda), an event sourcing and CQRS
framework for TypeScript. Built with Astro and deployed to Cloudflare Pages.

Deployed as a Worker with static assets: `wrangler.jsonc` serves `dist/`, and `404.html` answers
anything it does not find.

The documentation is a separate site: it lives in the framework repository, next to the code it
documents, and is served at [docs.bounda.dev](https://docs.bounda.dev). This repository holds only
what answers "what is this and why", so anything about *how* belongs there.

```bash
pnpm install
pnpm dev      # http://localhost:4321
pnpm build    # dist/
```

pnpm, like the framework repository, and not only for consistency: `npm ci` cannot install this
tree on Linux from a lockfile resolved on macOS, because rolldown ships its native bindings as
per-platform optional dependencies. The pnpm lockfile carries all of them.

## Keeping the two sites coherent

`src/styles/global.css` holds the colours and typography the documentation mirrors in its own
Starlight theme. A change to those tokens has to be carried across, or the two sites drift apart
visually — which is the reason this repository is separate from the framework but not independent
of it.
