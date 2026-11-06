import type { APIRoute, GetStaticPaths } from "astro";
import { type Article, articles } from "../../../../blog";
import { TRANSLATED_LOCALES } from "../../../../i18n";
import { articleCard } from "../../../../social-card";

// The card of a translation, at /<locale>/blog/<post>/og.png, in its own language.
export const getStaticPaths = (async () =>
  (
    await Promise.all(
      TRANSLATED_LOCALES.map(async (lang) =>
        (await articles(lang)).map((article) => ({ params: { lang, slug: article.slug }, props: { article } })),
      ),
    )
  ).flat()) satisfies GetStaticPaths;

export const GET: APIRoute<{ readonly article: Article }> = async ({ props: { article } }) =>
  new Response(await articleCard(article), { headers: { "Content-Type": "image/png" } });
