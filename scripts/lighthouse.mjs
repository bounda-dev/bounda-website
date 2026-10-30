// Lighthouse against the built site, the way CI runs it: serves dist/ with Astro's preview server,
// audits the page on the mobile default and the desktop preset, takes the median of a few runs, and
// fails when a category falls under its budget. Reports land in lighthouse-reports/.
//
//   pnpm build && pnpm lighthouse            # three runs per preset, as in CI
//   pnpm lighthouse --runs=1                 # a quick look
//   pnpm lighthouse --out=somewhere --url=/  # where the reports go, and which page

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "astro";

/** A category's lowest acceptable score. Performance has a little slack for the runner; the rest is exact. */
const BUDGET = { performance: 0.95, accessibility: 1, "best-practices": 1, seo: 1 };
/** Third parties the page loads but does not control, kept out of the audit so that neither their
 * outages nor an offline run count against it (Lighthouse ignores the console errors of what it blocks). */
const BLOCKED = ["https://static.cloudflareinsights.com/*"];
const PRESETS = [
  { name: "mobile", flags: [] },
  { name: "desktop", flags: ["--preset=desktop"] },
];

const root = fileURLToPath(new URL("..", import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);
const runs = Math.max(1, Number(args.runs ?? 3) || 3);
const out = path.resolve(root, args.out ?? "lighthouse-reports");
const page = args.url ?? "/";

if (!existsSync(path.join(root, "dist", "index.html"))) {
  console.error("dist/index.html is missing: run `pnpm build` first.");
  process.exit(2);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const lighthouseCli = createRequire(import.meta.url).resolve("lighthouse/cli/index.js");

// The preview server lives in this process, so Lighthouse has to run without blocking the event loop.
// Its own log is kept quiet and shown only when a run fails.
const lighthouse = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [lighthouseCli, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lighthouse exited with ${code}\n${log.split("\n").slice(-30).join("\n")}`));
    });
  });

const audit = async (url, name, flags) => {
  const file = path.join(out, name);
  await lighthouse([
    url,
    "--output=json",
    "--output=html",
    `--output-path=${file}`,
    `--only-categories=${Object.keys(BUDGET).join(",")}`,
    ...BLOCKED.map((pattern) => `--blocked-url-patterns=${pattern}`),
    "--chrome-flags=--headless=new --no-sandbox",
    ...flags,
  ]);
  const report = JSON.parse(readFileSync(`${file}.report.json`, "utf8"));
  const scores = Object.fromEntries(
    Object.entries(report.categories).map(([id, category]) => [id, category.score ?? 0]),
  );
  const metrics = Object.fromEntries(
    ["first-contentful-paint", "largest-contentful-paint", "total-blocking-time", "cumulative-layout-shift"].map(
      (id) => [id, report.audits[id]?.displayValue ?? "–"],
    ),
  );
  // The audits that cost each category points: the weighted ones under a perfect score.
  const failing = Object.fromEntries(
    Object.entries(report.categories).map(([id, category]) => [
      id,
      category.auditRefs
        .filter((ref) => ref.weight > 0 && (report.audits[ref.id]?.score ?? 1) < 1)
        .map((ref) => ref.id),
    ]),
  );
  return { scores, metrics, failing };
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percent = (score) => String(Math.round(score * 100)).padStart(3);

process.env.ASTRO_TELEMETRY_DISABLED = "1";
const server = await preview({ root, logLevel: "error", server: { host: "127.0.0.1", port: 4321 } });
const url = new URL(page, `http://127.0.0.1:${server.port}`).href;

let failed = false;
const lines = [`| Preset | ${Object.keys(BUDGET).join(" | ")} | LCP | TBT | CLS |`, `|---|${"---|".repeat(Object.keys(BUDGET).length + 3)}`];
try {
  for (const preset of PRESETS) {
    const results = [];
    for (let i = 1; i <= runs; i++) {
      process.stderr.write(`lighthouse: ${preset.name} ${i}/${runs} on ${url}\n`);
      results.push(await audit(url, `${preset.name}-${i}`, preset.flags));
    }
    // The run whose performance score is the median stands for the preset, so its metrics match its scores.
    const scores = Object.fromEntries(
      Object.keys(BUDGET).map((id) => [id, median(results.map((r) => r.scores[id]))]),
    );
    const representative =
      results.find((r) => r.scores.performance === scores.performance) ?? results[0];
    const under = Object.entries(BUDGET).filter(([id, floor]) => scores[id] < floor);
    if (under.length) failed = true;
    const cells = Object.keys(BUDGET).map((id) => `${percent(scores[id])}${scores[id] < BUDGET[id] ? " ✗" : ""}`);
    const m = representative.metrics;
    lines.push(
      `| ${preset.name} | ${cells.join(" | ")} | ${m["largest-contentful-paint"]} | ${m["total-blocking-time"]} | ${m["cumulative-layout-shift"]} |`,
    );
    for (const [id, floor] of under) {
      const culprits = [...new Set(results.flatMap((r) => r.failing[id] ?? []))].join(", ") || "none";
      console.error(`${preset.name}: ${id} ${percent(scores[id])} is under its budget of ${percent(floor)}. Failing audits: ${culprits}`);
    }
  }
} finally {
  await server.stop();
}

const table = lines.join("\n");
console.log(`\n${table}\n\nReports: ${path.relative(root, out)}/`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Lighthouse (median of ${runs})\n\n${table}\n`);
}
process.exit(failed ? 1 : 0);
