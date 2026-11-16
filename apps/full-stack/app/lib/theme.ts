/** Static script applied before hydration. */
export const THEME_SCRIPT =
  "(function () {\n  var theme;\n  try { theme = localStorage.getItem('theme'); } catch { /* Storage may be unavailable. */ }\n  var dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);\n  document.documentElement.classList.toggle('dark', dark);\n  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';\n})();";
