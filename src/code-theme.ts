// A Shiki theme whose colours are the design tokens, so code follows the mode on its own:
// keywords in the accent's text colour, strings in verdigris, types in stone, comments muted.
export const codeTheme = {
  name: "bounda",
  type: "dark" as const,
  colors: {
    "editor.foreground": "var(--text)",
    "editor.background": "transparent",
  },
  tokenColors: [
    { settings: { foreground: "var(--text)" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "var(--muted)" },
    },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "keyword.operator.new",
        "keyword.operator.expression",
        "constant.language",
        "constant.numeric",
      ],
      settings: { foreground: "var(--accent-text)" },
    },
    { scope: ["keyword.operator", "punctuation"], settings: { foreground: "var(--text)" } },
    {
      scope: [
        "string",
        "string.template",
        "punctuation.definition.string",
        "punctuation.definition.template-expression",
      ],
      settings: { foreground: "var(--code-string)" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.type",
        "support.class",
        "entity.other.inherited-class",
      ],
      settings: { foreground: "var(--code-type)" },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
      ],
      settings: { foreground: "var(--text)", fontStyle: "bold" },
    },
  ],
};
