// Sends each new post of the blog's feed to the newsletter, once. Run every hour by
// .github/workflows/newsletter.yml; it reads the live feed, so a post goes out only once it is
// deployed. A post counts as sent when a Resend broadcast is named after its address, so a run
// that is repeated, or one that fails halfway, never sends twice.
//
//   RESEND_API_KEY=… node scripts/newsletter.mjs            # send what is missing
//   RESEND_API_KEY=… node scripts/newsletter.mjs --dry-run  # only say what it would send
//
// Off while src/newsletter.json says `"enabled": false`. Posts published before its `since` are
// never sent.

import { readFileSync } from "node:fs";

const FEED = "https://bounda.dev/blog/rss.xml";
const RESEND = "https://api.resend.com";

const config = JSON.parse(readFileSync(new URL("../src/newsletter.json", import.meta.url), "utf8"));
const dryRun = process.argv.includes("--dry-run");

if (!config.enabled) {
  console.log("newsletter: off (src/newsletter.json), nothing to do");
  process.exit(0);
}
const key = process.env.RESEND_API_KEY;
if (!key || !config.segment) {
  console.error("newsletter: RESEND_API_KEY and the segment in src/newsletter.json are both needed");
  process.exit(1);
}

const resend = async (path, init = {}) => {
  const response = await fetch(`${RESEND}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
};

const unescape = (text) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const field = (item, name) => {
  const match = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!match) return "";
  const value = match[1].trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return cdata ? cdata[1] : unescape(value);
};

const feed = await (await fetch(FEED)).text();
const posts = [...feed.matchAll(/<item>([\s\S]*?)<\/item>/g)]
  .map(([, item]) => ({
    title: field(item, "title"),
    link: field(item, "link"),
    date: new Date(field(item, "pubDate")),
    content: field(item, "content:encoded"),
  }))
  .filter((post) => post.date >= new Date(config.since))
  .sort((a, b) => a.date - b.date);

/** Every broadcast's name, across pages. */
const sent = new Set();
for (let after; ; ) {
  const page = await resend(`/broadcasts?limit=100${after ? `&after=${after}` : ""}`);
  for (const broadcast of page.data) sent.add(broadcast.name);
  if (!page.has_more || page.data.length === 0) break;
  after = page.data.at(-1).id;
}

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Links in the feed may be relative to the site; in an email they must be absolute.
const absolute = (html) => html.replace(/(href|src)="\//g, '$1="https://bounda.dev/');

const email = (post) => `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px;background:#ECEAE4;color:#1A1916;font:16px/1.6 -apple-system,'Segoe UI',sans-serif;">
<div style="max-width:620px;margin:0 auto;">
<p style="margin:0 0 8px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#5F5B53;">Bounda blog</p>
<h1 style="margin:0 0 24px;font-size:28px;line-height:1.15;"><a href="${post.link}" style="color:#1A1916;text-decoration:none;">${escape(post.title)}</a></h1>
${absolute(post.content)}
<hr style="border:0;border-top:1px solid #D3CFC5;margin:32px 0 16px;">
<p style="font-size:13px;color:#5F5B53;">Read it on <a href="${post.link}" style="color:#8A5508;">bounda.dev</a>. You get this because you subscribed there. <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#8A5508;">Unsubscribe</a>.</p>
</div>
</body>
</html>`;

const missing = posts.filter((post) => !sent.has(post.link));
if (missing.length === 0) console.log("newsletter: nothing new");
for (const post of missing) {
  if (dryRun) {
    console.log(`newsletter: would send ${post.link}`);
    continue;
  }
  await resend("/broadcasts", {
    method: "POST",
    body: JSON.stringify({
      segment_id: config.segment,
      from: config.from,
      subject: post.title,
      name: post.link,
      html: email(post),
      send: true,
    }),
  });
  console.log(`newsletter: sent ${post.link}`);
}
