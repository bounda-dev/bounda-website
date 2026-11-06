import type { APIRoute, GetStaticPaths } from "astro";
import { formatDate, KIND_LABEL, type Post, posts } from "../../../blog";
import { socialCard } from "../../../social-card";

// The card each post shares, at /blog/<post>/og.png; the post's page points og:image here.
export const getStaticPaths = (async () =>
  (await posts()).map((post) => ({ params: { slug: post.id }, props: { post } }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ readonly post: Post }> = async ({ props: { post } }) =>
  new Response(
    await socialCard({
      label: `${KIND_LABEL[post.data.kind]} · ${formatDate(post.data.date)}`,
      title: post.data.title,
      description: post.data.description,
    }),
    { headers: { "Content-Type": "image/png" } },
  );
