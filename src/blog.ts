import { type CollectionEntry, getCollection } from "astro:content";

export type Post = CollectionEntry<"blog">;

export const AUTHOR = { name: "Beñat Espiña", url: "https://github.com/benatespina" } as const;

export const KIND_LABEL: Record<Post["data"]["kind"], string> = {
  essay: "Essay",
  tutorial: "Tutorial",
  comparison: "Comparison",
  engineering: "Engineering",
};

// Newest first. Drafts only exist on the dev server, so a build never publishes one by accident.
export const posts = async (): Promise<Post[]> =>
  (await getCollection("blog", ({ data }) => import.meta.env.DEV || !data.draft)).toSorted(
    (a, b) => b.data.date.getTime() - a.data.date.getTime(),
  );

const WORDS_PER_MINUTE = 230;

export const readingMinutes = (post: Post): number =>
  Math.max(1, Math.round((post.body ?? "").split(/\s+/).filter(Boolean).length / WORDS_PER_MINUTE));

export const formatDate = (date: Date): string =>
  date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
