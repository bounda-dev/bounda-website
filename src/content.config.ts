import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// One Markdown file per post in src/content/blog; its file name is its address under /blog/.
const blog = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    // The search result and the social card show it, so it says what the reader gets.
    description: z.string().max(200),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    kind: z.enum(["essay", "tutorial", "comparison", "engineering"]),
    // Where the reader sees the idea run: a scene of the demo, a guide, an example.
    tryIt: z.object({ label: z.string(), href: z.url() }).optional(),
    // Drafts render in `astro dev` and are left out of the build.
    draft: z.boolean().default(false),
  }),
});

// A translation of a post, at src/content/translations/<locale>/<slug>.md: the text in another
// language, under the same slug as the English original, which keeps the date, the kind and the
// draft flag.
const translations = defineCollection({
  loader: glob({ pattern: "*/*.md", base: "./src/content/translations" }),
  schema: z.object({
    title: z.string(),
    description: z.string().max(240),
    tryIt: z.object({ label: z.string() }).optional(),
  }),
});

export const collections = { blog, translations };
