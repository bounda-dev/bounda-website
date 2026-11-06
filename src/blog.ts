import { type CollectionEntry, getCollection } from "astro:content";
import { type Kind, type Locale, LOCALES } from "./i18n";

export const AUTHOR = { name: "Beñat Espiña", url: "https://github.com/benatespina" } as const;

/** A post in one language: the English original, or a translation of it. */
export interface Article {
  readonly locale: Locale;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly date: Date;
  readonly updated: Date | undefined;
  readonly kind: Kind;
  readonly tryIt: { readonly label: string; readonly href: string } | undefined;
  readonly draft: boolean;
  /** Every language the post can be read in, the English original first. */
  readonly locales: readonly Locale[];
  readonly entry: CollectionEntry<"blog"> | CollectionEntry<"translations">;
}

// Drafts only exist on the dev server, so a build never publishes one by accident.
const visible = ({ data }: CollectionEntry<"blog">) => import.meta.env.DEV || !data.draft;

/** The posts of one language, newest first. A translation without its original fails the build. */
export const articles = async (locale: Locale): Promise<Article[]> => {
  const all = await getCollection("blog");
  const translations = await getCollection("translations");
  for (const translation of translations) {
    const slug = translation.id.slice(translation.id.indexOf("/") + 1);
    if (!all.some(({ id }) => id === slug)) {
      throw new Error(`translation ${translation.id} has no original at src/content/blog/${slug}.md`);
    }
  }
  const originals = all.filter(visible);
  const localesOf = (slug: string): Locale[] =>
    LOCALES.filter(
      (candidate) =>
        candidate === "en" || translations.some((t) => t.id === `${candidate}/${slug}`),
    );
  return originals
    .flatMap((original): Article[] => {
      const base = {
        slug: original.id,
        date: original.data.date,
        updated: original.data.updated,
        kind: original.data.kind,
        draft: original.data.draft,
        locales: localesOf(original.id),
      };
      if (locale === "en") {
        return [{ ...base, locale, title: original.data.title, description: original.data.description, tryIt: original.data.tryIt, entry: original }];
      }
      const translation = translations.find(({ id }) => id === `${locale}/${original.id}`);
      if (!translation) return [];
      const tryIt = original.data.tryIt && {
        label: translation.data.tryIt?.label ?? original.data.tryIt.label,
        href: original.data.tryIt.href,
      };
      return [{ ...base, locale, title: translation.data.title, description: translation.data.description, tryIt, entry: translation }];
    })
    .toSorted((a, b) => b.date.getTime() - a.date.getTime());
};

const WORDS_PER_MINUTE = 230;
// Japanese has no spaces between words; a reader takes in about this many characters a minute.
const JAPANESE_CHARACTERS_PER_MINUTE = 500;

export const readingMinutes = ({ locale, entry }: Article): number => {
  const body = entry.body ?? "";
  const minutes =
    locale === "ja"
      ? body.replace(/\s+/g, "").length / JAPANESE_CHARACTERS_PER_MINUTE
      : body.split(/\s+/).filter(Boolean).length / WORDS_PER_MINUTE;
  return Math.max(1, Math.round(minutes));
};
