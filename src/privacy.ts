import type { Locale } from "./i18n";

// The privacy page (/privacy/, English only) holds what GDPR art. 13 requires; the note under the
// newsletter form holds what has to be said at the form itself: what the address is for, and that
// consent can be withdrawn (art. 7(3)), with the link to the rest.

/** Whom to write to about personal data. */
export const CONTACT = "privacy@bounda.dev";

export const PRIVACY_PATH = "/privacy/";

export const NOTE: Record<Locale, { readonly text: string; readonly link: string }> = {
  en: { text: "Only to send you new posts. You can unsubscribe at any time.", link: "Privacy" },
  es: { text: "Solo para enviarte los posts nuevos. Puedes darte de baja cuando quieras.", link: "Privacy" },
  ja: { text: "新しい記事をお送りするためだけに使います。いつでも配信を停止できます。", link: "Privacy" },
  "pt-br": { text: "Só para enviar os posts novos. Você pode cancelar quando quiser.", link: "Privacy" },
};
