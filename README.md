# bounda.dev

The landing page for [Bounda](https://github.com/bounda-dev/bounda), an event sourcing and CQRS
framework for TypeScript. Built with Astro and deployed to Cloudflare Pages.

The documentation is a separate site: it lives in the framework repository, next to the code it
documents, and is served at [docs.bounda.dev](https://docs.bounda.dev). This repository holds only
what answers "what is this and why", so anything about *how* belongs there.

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # dist/
```

## Keeping the two sites coherent

`src/styles/global.css` holds the colours and typography the documentation mirrors in its own
Starlight theme. A change to those tokens has to be carried across, or the two sites drift apart
visually — which is the reason this repository is separate from the framework but not independent
of it.
