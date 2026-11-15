import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/button.tsx';

type Theme = 'system' | 'light' | 'dark';

/** A local preference; system mode continues to follow the operating system. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    try {
      const stored = localStorage.getItem('theme');
      setTheme(stored === 'light' || stored === 'dark' ? stored : 'system');
    } catch {
      setTheme('system');
    }
  }, []);
  useEffect(() => {
    if (theme === null) return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  function cycle() {
    const next =
      theme === null || theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    try {
      if (next === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', next);
    } catch {
      /* The preference still works for this page. */
    }
    setTheme(next);
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      onClick={cycle}
      aria-label={'Theme: ' + (theme ?? 'system')}
    >
      <span aria-hidden="true">
        {theme === null || theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'}
      </span>
    </Button>
  );
}
