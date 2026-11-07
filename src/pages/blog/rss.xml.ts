import rss from "@astrojs/rss";
import type { APIRoute } from "astro";
import { AUTHOR, articles } from "../../blog";
import { LANGUAGES, postPath } from "../../i18n";

// The English posts, in full, so a reader (or DEV's import, which keeps bounda.dev as the canonical
// address) gets the whole text; a translation is linked from its post, not repeated in the feed.
// Code keeps its tokens but not the site's colours, which are CSS variables a reader cannot resolve.
// A line break inside a paragraph is a space to a browser, but DEV's import drops it next to a link
// or inline code, gluing words together; outside code blocks it becomes a plain space.
const forFeeds = (html: string): string =>
  html
    .replace(/ style="[^"]*"/g, "")
    .split(/(<pre[\s\S]*?<\/pre>)/)
    .map((part) => (part.startsWith("<pre") ? part : part.replaceAll("\n", " ")))
    .join("");

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
      content: forFeeds(article.entry.rendered?.html ?? ""),
    })),
    customData: "<language>en</language>",
  });
