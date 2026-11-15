// The site's only code on the server: the newsletter's double opt-in. Everything else is static
// and served by Cloudflare before this runs (`run_worker_first: ["/api/*"]` in wrangler.jsonc).
//
//   POST /api/subscribe  mails a link to confirm; nothing is stored until it is used
//   GET  /api/confirm    the confirmation page, with a button (a mail scanner opening the link
//                        confirms nothing)
//   POST /api/confirm    adds the address to the Resend segment the posts are sent to
//
// The link carries the address and an expiry, signed with NEWSLETTER_SECRET. Secrets, set with
// `wrangler secret put`: RESEND_API_KEY and NEWSLETTER_SECRET. The rest is src/newsletter.json.

import newsletter from "../src/newsletter.json";

interface Env {
  readonly ASSETS: { fetch(request: Request | URL): Promise<Response> };
  readonly RESEND_API_KEY?: string;
  readonly NEWSLETTER_SECRET?: string;
}

declare class HTMLRewriter {
  on(selector: string, handlers: { element(element: { setAttribute(name: string, value: string): void }): void }): HTMLRewriter;
  transform(response: Response): Response;
}

const RESEND = "https://api.resend.com";
const LINK_LIFETIME = 48 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromBase64url = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

const key = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

/** `<address and expiry>.<signature>`, both base64url. */
const sign = async (secret: string, email: string, now: number): Promise<string> => {
  const payload = encoder.encode(JSON.stringify({ e: email, x: now + LINK_LIFETIME }));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), payload));
  return `${base64url(payload)}.${base64url(signature)}`;
};

/** The address a token was signed for, if the signature holds and it has not expired. */
const verify = async (secret: string, token: string, now: number): Promise<string | null> => {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  try {
    const bytes = fromBase64url(payload);
    if (!(await crypto.subtle.verify("HMAC", await key(secret), fromBase64url(signature), bytes))) return null;
    const { e, x } = JSON.parse(new TextDecoder().decode(bytes)) as { e?: unknown; x?: unknown };
    return typeof e === "string" && typeof x === "number" && x > now ? e : null;
  } catch {
    return null;
  }
};

const resend = (env: Env, path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${RESEND}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const sha256 = async (text: string): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));

const to = (request: Request, path: string): Response => Response.redirect(new URL(path, request.url).href, 303);

const confirmationEmail = (link: string) => ({
  subject: "Confirm your subscription to the Bounda blog",
  text: [
    "Someone, hopefully you, asked to get each new post of the Bounda blog at this address.",
    "",
    `Confirm here: ${link}`,
    "",
    "If it was not you, ignore this email and nothing happens. The link expires in 48 hours.",
  ].join("\n"),
  html: [
    "<p>Someone, hopefully you, asked to get each new post of the Bounda blog at this address.</p>",
    `<p><a href="${link}">Confirm the subscription</a></p>`,
    "<p>If it was not you, ignore this email and nothing happens. The link expires in 48 hours.</p>",
  ].join(""),
});

const subscribe = async (request: Request, env: Env, secret: string): Promise<Response> => {
  const form = await request.formData();
  // The trap field is hidden from people; whatever fills it is a bot, told nothing.
  if (form.get("website")) return to(request, "/newsletter/check/");
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return to(request, "/newsletter/invalid/");

  const token = await sign(secret, email, Date.now());
  const link = new URL(`/api/confirm?t=${token}`, request.url).href;
  // One confirmation per address per day, however often the form is sent: Resend drops repeats.
  const day = new Date().toISOString().slice(0, 10);
  const sent = await resend(
    env,
    "/emails",
    "POST",
    { from: newsletter.from, to: [email], ...confirmationEmail(link) },
    { "Idempotency-Key": `confirm/${await sha256(email)}/${day}` },
  );
  return to(request, sent.ok ? "/newsletter/check/" : "/newsletter/failed/");
};

/** The confirmation page, with the token in its form. */
const confirmPage = async (request: Request, env: Env, token: string): Promise<Response> => {
  const page = await env.ASSETS.fetch(new URL("/newsletter/confirm/", request.url));
  return new HTMLRewriter()
    .on('input[name="t"]', {
      element(element) {
        element.setAttribute("value", token);
      },
    })
    .transform(new Response(page.body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }));
};

/** Adds the address to the segment, whether or not Resend already knows it. */
const confirm = async (env: Env, email: string): Promise<boolean> => {
  const created = await resend(env, "/contacts", "POST", { email, unsubscribed: false, segments: [{ id: newsletter.segment }] });
  if (created.ok) return true;
  const contact = encodeURIComponent(email);
  const updated = await resend(env, `/contacts/${contact}`, "PATCH", { unsubscribed: false });
  if (!updated.ok) return false;
  // Every contact is created here with the segment; this only mends one that lost it.
  await resend(env, `/contacts/${contact}/segments/${newsletter.segment}`, "POST");
  return true;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const secret = env.NEWSLETTER_SECRET;
    const ready = newsletter.enabled && newsletter.segment && env.RESEND_API_KEY && secret;
    if (!ready) return new Response("Not found", { status: 404 });

    if (url.pathname === "/api/subscribe" && request.method === "POST") return subscribe(request, env, secret);

    if (url.pathname === "/api/confirm") {
      const token = request.method === "POST" ? String((await request.formData()).get("t") ?? "") : (url.searchParams.get("t") ?? "");
      const email = await verify(secret, token, Date.now());
      if (!email) return to(request, "/newsletter/expired/");
      if (request.method === "GET") return confirmPage(request, env, token);
      if (request.method === "POST") return to(request, (await confirm(env, email)) ? "/newsletter/confirmed/" : "/newsletter/failed/");
    }

    return new Response("Not found", { status: 404 });
  },
};
