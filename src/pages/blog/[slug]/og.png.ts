import type { APIRoute, GetStaticPaths } from "astro";
import { type Article, articles } from "../../../blog";
import { articleCard } from "../../../social-card";

// The card each post shares, at /blog/<post>/og.png; the post's page points og:image here.
export const getStaticPaths = (async () =>
  (await articles("en")).map((article) => ({ params: { slug: article.slug }, props: { article } }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ readonly article: Article }> = async ({ props: { article } }) =>
  new Response(await articleCard(article), { headers: { "Content-Type": "image/png" } });
