import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import lockupSvg from "../brand/lockup-on-basalt.svg?raw";
import type { Article } from "./blog";
import { formatDate, LANGUAGES } from "./i18n";

// The card a post shows when it is shared, drawn at build in Basalt as the docs draw theirs
// (docs/src/social-card.ts in bounda-dev/bounda): the lockup, a label, the title and the
// description, and the ⅃ closing the card.

const WIDTH = 1200;
const HEIGHT = 630;
// What fits in two lines of the description at its size; longer ones end in an ellipsis. Japanese
// characters are twice as wide, and a line breaks after its punctuation rather than at a space.
const DESCRIPTION_LENGTH = 120;
const CJK_DESCRIPTION_LENGTH = 56;

const shorten = (text: string, cjk: boolean): string => {
  const limit = cjk ? CJK_DESCRIPTION_LENGTH : DESCRIPTION_LENGTH;
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  if (cjk) {
    const end = Math.max(cut.lastIndexOf("、"), cut.lastIndexOf("。"));
    return `${end > 0 ? cut.slice(0, end) : cut}…`;
  }
  // A whole first sentence reads better than more words and an ellipsis.
  const sentence = cut.lastIndexOf(". ");
  if (sentence > limit / 2) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.]$/, "")}…`;
};

const BASALT = {
  bg: "#121314",
  rule: "#2E2F32",
  text: "#E6E0D3",
  muted: "#9C978C",
  accent: "#D9A04A",
};

const require = createRequire(import.meta.url);
const font = (file: string) => readFile(require.resolve(file));

const fonts = Promise.all([
  font("@fontsource/science-gothic/files/science-gothic-latin-600-normal.woff"),
  font("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff"),
  font("@fontsource/red-hat-mono/files/red-hat-mono-latin-400-normal.woff"),
]).then(([display, text, mono]) => [
  { name: "Science Gothic", data: display, weight: 600 as const, style: "normal" as const },
  { name: "IBM Plex Sans", data: text, weight: 400 as const, style: "normal" as const },
  { name: "Red Hat Mono", data: mono, weight: 400 as const, style: "normal" as const },
]);

// Japanese has no glyphs in the brand's faces, so a Japanese card adds Noto Sans JP, cut by Google
// Fonts to the characters the card uses (the build already fetches the site's fonts from there).
const japanese = async (text: string) => {
  const weights = [400, 600] as const;
  return Promise.all(
    weights.map(async (weight) => {
      const css = await (
        await fetch(
          `https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@${weight}&text=${encodeURIComponent(text)}`,
        )
      ).text();
      const url = css.match(/src: url\((.+?)\)/)?.[1];
      if (!url) throw new Error(`no Noto Sans JP ${weight} for the card: ${css.slice(0, 200)}`);
      return { name: "Noto Sans JP", data: await (await fetch(url)).arrayBuffer(), weight, style: "normal" as const };
    }),
  );
};

const dataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

const LOCKUP = dataUri(lockupSvg);

const CLOSE = dataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 35 65"><path fill="${BASALT.text}" d="M25 0h10v65H25v-8H0v-6h25z"/></svg>`,
);

interface Node {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>> & { readonly children?: unknown };
}

const node = (type: string, style: object, children?: unknown, props: object = {}): Node => ({
  type,
  props: { ...props, style, children },
});

export interface SocialCardArgs {
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly host: string;
  readonly cjk: boolean;
}

export const socialCard = async ({ label, title, description, host, cjk }: SocialCardArgs): Promise<Uint8Array<ArrayBuffer>> => {
  const display = cjk ? "Noto Sans JP" : "Science Gothic";
  const summary = shorten(description, cjk);
  const card = node(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      width: WIDTH,
      height: HEIGHT,
      padding: "56px 72px 48px",
      background: BASALT.bg,
      color: BASALT.text,
      fontFamily: "IBM Plex Sans",
    },
    [
      node("div", { display: "flex", justifyContent: "space-between", alignItems: "center" }, [
        node("img", { height: 40 }, undefined, { src: LOCKUP, width: 222, height: 40 }),
        node("div", { fontFamily: "Red Hat Mono", fontSize: 24, color: BASALT.muted }, host),
      ]),
      node("div", { display: "flex", flexDirection: "column", marginTop: "auto" }, [
        node(
          "div",
          {
            fontFamily: display,
            fontWeight: 600,
            fontSize: 22,
            letterSpacing: 3,
            textTransform: "uppercase",
            color: BASALT.accent,
          },
          label,
        ),
        node(
          "div",
          {
            marginTop: 16,
            fontFamily: display,
            fontWeight: 600,
            fontSize: title.length > 32 ? 60 : 72,
            lineHeight: 1.08,
            letterSpacing: -0.5,
          },
          title,
        ),
        node(
          "div",
          { marginTop: 24, maxWidth: 940, fontSize: 28, lineHeight: 1.4, color: BASALT.muted },
          summary,
        ),
      ]),
      node(
        "div",
        {
          display: "flex",
          justifyContent: "flex-end",
          marginTop: 40,
          paddingTop: 24,
          borderTop: `1px solid ${BASALT.rule}`,
        },
        node("img", {}, undefined, { src: CLOSE, width: 19, height: 36 }),
      ),
    ],
  );
  const extra = cjk ? await japanese(`${label}${title}${summary}`) : [];
  const svg = await satori(card as Parameters<typeof satori>[0], {
    width: WIDTH,
    height: HEIGHT,
    fonts: [...(await fonts), ...extra],
  });
  return new Uint8Array(new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng());
};

export const articleCard = (article: Article): Promise<Uint8Array<ArrayBuffer>> => {
  const text = LANGUAGES[article.locale];
  return socialCard({
    label: `${text.kinds[article.kind]} · ${formatDate(article.locale, article.date)}`,
    title: article.title,
    description: article.description,
    host: article.locale === "en" ? "bounda.dev/blog" : `bounda.dev/${article.locale}/blog`,
    cjk: article.locale === "ja",
  });
};
