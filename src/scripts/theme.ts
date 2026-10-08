export type Theme = "light" | "dark";

const EVENT = "bounda:theme";
const KEY = "theme";
const systemDark = matchMedia("(prefers-color-scheme: dark)");

/** The mode on screen: the visitor's choice if they made one, the system's otherwise. */
export const currentTheme = (): Theme => {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return systemDark.matches ? "dark" : "light";
};

export const onThemeChange = (listener: (theme: Theme) => void): void => {
  addEventListener(EVENT, () => listener(currentTheme()));
};

// The browser chrome follows the page, not only the system.
const syncThemeColor = (): void => {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    meta.content = bg;
};

const announce = (): void => {
  if (document.documentElement.dataset.theme) syncThemeColor();
  dispatchEvent(new Event(EVENT));
};

export const setTheme = (theme: Theme): void => {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be unavailable (private windows); the choice then lasts for this page.
  }
  announce();
};

systemDark.addEventListener("change", announce);
if (document.documentElement.dataset.theme) syncThemeColor();
