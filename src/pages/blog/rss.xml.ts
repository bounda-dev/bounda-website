import rss from "@astrojs/rss";
import type { APIRoute } from "astro";
import { AUTHOR, articles } from "../../blog";
import { LANGUAGES, postPath } from "../../i18n";

// The English posts; a translation is linked from its post, not repeated in the feed.
export const GET: APIRoute = async ({ site }) =>
  rss({
    title: "Bounda blog",
    description: LANGUAGES.en.lead,
    site: site ?? "https://bounda.dev",
    items: (await articles("en")).map((article) => ({
      title: article.title,
      description: article.description,
      pubDate: article.date,
      link: postPath("en", article.slug),
      author: AUTHOR.name,
    })),
    customData: "<language>en</language>",
  });
