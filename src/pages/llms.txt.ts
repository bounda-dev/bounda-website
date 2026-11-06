import type { APIRoute } from "astro";
import { articles } from "../blog";
import { postPath } from "../i18n";

// What an assistant reads first about Bounda (llmstxt.org): what it is, where the docs are, and the
// posts, so an answer about event sourcing in TypeScript can cite them.
export const GET: APIRoute = async ({ site }) => {
  const base = site ?? new URL("https://bounda.dev");
  const lines = [
    "# Bounda",
    "",
    "> An event sourcing and CQRS framework for TypeScript. Plain modules, inferred types, one database (SQLite, PostgreSQL or a Cloudflare Durable Object), and read models that rebuild from the global stream.",
    "",
    "## Docs",
    "",
    "- [Documentation for assistants](https://docs.bounda.dev/llms.txt): every page, as plain text",
    "- [Getting started](https://docs.bounda.dev/getting-started/): `npm create bounda@latest`",
    "- [What is not there yet](https://docs.bounda.dev/reference/limitations/): the honest list",
    "",
    "## Blog",
    "",
    ...(await articles("en")).map(
      (article) => `- [${article.title}](${new URL(postPath("en", article.slug), base).href}): ${article.description}`,
    ),
    "",
    "## Optional",
    "",
    "- [Live demo](https://demo.bounda.dev): a theatre box office running on Bounda, one Durable Object per visitor",
    "- [Source](https://github.com/bounda-dev/bounda): Apache 2.0",
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
