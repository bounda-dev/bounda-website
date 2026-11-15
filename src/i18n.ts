import type { CollectionEntry } from "astro:content";

// The blog's languages. English is the original and lives at /blog/; a translation lives at
// /<locale>/blog/, written from the English post when it is published.

export type Locale = "en" | "es" | "ja" | "pt-br";

export type Kind = CollectionEntry<"blog">["data"]["kind"];

export interface Language {
  /** BCP 47, for `lang` and `hreflang`. */
  readonly tag: string;
  readonly ogLocale: string;
  /** The language's name in itself, for the switcher. */
  readonly name: string;
  readonly kinds: Record<Kind, string>;
  readonly blog: string;
  readonly heading: string;
  readonly lead: string;
  readonly empty: string;
  readonly by: string;
  readonly minutes: (count: number) => string;
  readonly rss: string;
  readonly more: string;
  readonly seeItRun: string;
  readonly languages: string;
  /** The heading of the post's table of contents. */
  readonly contents: string;
  readonly translated: string;
  readonly original: string;
  /** Only for machine translations, which a native reader is asked to correct. */
  readonly report: string;
  /** Under the original, before the translations it has. Only English uses it. */
  readonly alsoIn: string;
  readonly newsletter: Newsletter;
}

/** The newsletter's form: each new post by email, sent from the English feed. */
export interface Newsletter {
  readonly heading: string;
  readonly lead: string;
  readonly email: string;
  readonly subscribe: string;
}

export const LANGUAGES: Record<Locale, Language> = {
  en: {
    tag: "en",
    ogLocale: "en_US",
    name: "English",
    kinds: { essay: "Essay", tutorial: "Tutorial", comparison: "Comparison", engineering: "Engineering" },
    blog: "Blog",
    heading: "Event sourcing, written down.",
    lead: "Essays, tutorials and measurements on event sourcing and CQRS in TypeScript, with Bounda as the worked example.",
    empty: "The first post is on its way.",
    by: "By",
    minutes: (count) => `${count} min read`,
    rss: "Follow by RSS",
    more: "More posts",
    seeItRun: "See it run in the live demo",
    languages: "Read in",
    contents: "On this page",
    translated: "",
    original: "",
    report: "",
    alsoIn: "Also in",
    newsletter: {
      heading: "Newsletter",
      lead: "Each new post by email. Nothing else.",
      email: "Email address",
      subscribe: "Subscribe",
    },
  },
  es: {
    tag: "es",
    ogLocale: "es_ES",
    name: "Español",
    kinds: { essay: "Ensayo", tutorial: "Tutorial", comparison: "Comparativa", engineering: "Ingeniería" },
    blog: "Blog",
    heading: "Event sourcing, por escrito.",
    lead: "Ensayos, tutoriales y mediciones sobre event sourcing y CQRS en TypeScript, con Bounda como ejemplo práctico.",
    empty: "El primer post está en camino.",
    by: "Por",
    minutes: (count) => `${count} min de lectura`,
    rss: "Síguelo por RSS",
    more: "Más posts",
    seeItRun: "Míralo funcionar en la demo",
    languages: "Leer en",
    contents: "En esta página",
    translated: "Traducido del original en inglés.",
    original: "Leer el original",
    report: "",
    alsoIn: "",
    newsletter: {
      heading: "Newsletter",
      lead: "Cada post nuevo por email. Nada más.",
      email: "Dirección de email",
      subscribe: "Suscribirme",
    },
  },
  ja: {
    tag: "ja",
    ogLocale: "ja_JP",
    name: "日本語",
    kinds: { essay: "エッセイ", tutorial: "チュートリアル", comparison: "比較", engineering: "エンジニアリング" },
    blog: "ブログ",
    heading: "イベントソーシングを、言葉で。",
    lead: "TypeScript におけるイベントソーシングと CQRS についてのエッセイ、チュートリアル、計測。実例は Bounda で。",
    empty: "最初の記事を準備中です。",
    by: "著者",
    minutes: (count) => `${count} 分で読めます`,
    rss: "RSS で購読",
    more: "ほかの記事",
    seeItRun: "ライブデモで動きを見る",
    languages: "言語",
    contents: "このページの内容",
    translated: "英語の原文からの機械翻訳です。",
    original: "原文を読む",
    report: "誤りを報告する",
    alsoIn: "",
    newsletter: {
      heading: "ニュースレター",
      lead: "新しい記事をメールで。それ以外は送りません。",
      email: "メールアドレス",
      subscribe: "購読する",
    },
  },
  "pt-br": {
    tag: "pt-BR",
    ogLocale: "pt_BR",
    name: "Português",
    kinds: { essay: "Ensaio", tutorial: "Tutorial", comparison: "Comparação", engineering: "Engenharia" },
    blog: "Blog",
    heading: "Event sourcing, por escrito.",
    lead: "Ensaios, tutoriais e medições sobre event sourcing e CQRS em TypeScript, com o Bounda como exemplo prático.",
    empty: "O primeiro post está a caminho.",
    by: "Por",
    minutes: (count) => `${count} min de leitura`,
    rss: "Siga por RSS",
    more: "Mais posts",
    seeItRun: "Veja funcionando na demo",
    languages: "Ler em",
    contents: "Nesta página",
    translated: "Tradução automática do original em inglês.",
    original: "Ler o original",
    report: "Avisar de um erro",
    alsoIn: "",
    newsletter: {
      heading: "Newsletter",
      lead: "Cada post novo por email. Nada mais.",
      email: "Endereço de email",
      subscribe: "Inscrever-me",
    },
  },
};

export const LOCALES = Object.keys(LANGUAGES) as Locale[];

export const TRANSLATED_LOCALES = LOCALES.filter((locale) => locale !== "en") as Exclude<Locale, "en">[];

export const blogPath = (locale: Locale): string => (locale === "en" ? "/blog/" : `/${locale}/blog/`);

export const postPath = (locale: Locale, slug: string): string => `${blogPath(locale)}${slug}/`;

export const formatDate = (locale: Locale, date: Date): string =>
  date.toLocaleDateString(LANGUAGES[locale].tag, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
