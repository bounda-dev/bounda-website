// A Sätteri hast plugin for posts: code keeps its words when a browser translates the page, so
// `forget("c-42")` is not rendered as `olvidar("c-42")` to a reader who reads it in Spanish.
// It runs after syntax highlighting, so it marks the `pre` Shiki writes.

interface Element {
  readonly tagName: string;
}

interface VisitorContext {
  setProperty(node: Element, name: string, value: string): void;
}

export const untranslatedCode = {
  name: "untranslated-code",
  element: {
    filter: ["pre", "code"],
    visit: (node: Element, ctx: VisitorContext) => ctx.setProperty(node, "translate", "no"),
  },
};
