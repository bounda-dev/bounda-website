import rss from "@astrojs/rss";
import type { APIRoute } from "astro";
import { AUTHOR, posts } from "../../blog";

export const GET: APIRoute = async ({ site }) =>
  rss({
    title: "Bounda blog",
    description:
      "Essays, tutorials and measurements on event sourcing and CQRS in TypeScript, with Bounda as the worked example.",
    site: site ?? "https://bounda.dev",
    items: (await posts()).map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: `/blog/${post.id}/`,
      author: AUTHOR.name,
    })),
    customData: "<language>en</language>",
  });
