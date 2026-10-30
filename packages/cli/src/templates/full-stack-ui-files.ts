/** Copied shadcn/ui components and the app-owned theme toggle. */
import type { GeneratedFile } from '../utils/file-writer.ts';
import { renderThemeScript, THEME_STORAGE_KEY } from './ui-tokens.ts';

const button = `/** Source: https://ui.shadcn.com/r/styles/new-york-v4/button.json — shadcn/ui, MIT licence. */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { Slot } from 'radix-ui';

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs:
          "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}:
  & React.ComponentProps<'button'>
  & VariantProps<typeof buttonVariants>
  & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot='button'
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
`;

const card = `/** Source: https://ui.shadcn.com/r/styles/new-york-v4/card.json — shadcn/ui, MIT licence. */
import * as React from 'react';
import { cn } from 'cn';

function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='card'
      className={cn(
        'flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='card-header'
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='card-title'
      className={cn('leading-none font-semibold', className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='card-description'
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='card-action'
      className={cn(
        'col-start-2 row-span-2 row-start-1 self-start justify-self-end',
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='card-content'
      className={cn('px-6', className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='card-footer'
      className={cn('flex items-center px-6 [.border-t]:pt-6', className)}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
`;

const themeToggle = `import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/button.tsx';

type Theme = 'system' | 'light' | 'dark';

/** A local preference; system mode continues to follow the operating system. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    try {
      const stored = localStorage.getItem('${THEME_STORAGE_KEY}');
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
    const next = theme === null || theme === 'system'
      ? 'light'
      : theme === 'light'
      ? 'dark'
      : 'system';
    try {
      if (next === 'system') localStorage.removeItem('${THEME_STORAGE_KEY}');
      else localStorage.setItem('${THEME_STORAGE_KEY}', next);
    } catch { /* The preference still works for this page. */ }
    setTheme(next);
  }

  return (
    <Button
      variant='ghost'
      size='icon'
      type='button'
      onClick={cycle}
      aria-label={'Theme: ' + (theme ?? 'system')}
    >
      <span aria-hidden='true'>
        {theme === null || theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'}
      </span>
    </Button>
  );
}
`;
/** Extra files consumed by the full-stack template on every runtime. */
export const FULL_STACK_UI_FILES: readonly GeneratedFile[] = [
  {
    path: 'components.json',
    contents: `{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "app/app.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "~/components",
    "utils": "~/lib/utils",
    "ui": "~/components/ui",
    "lib": "~/lib",
    "hooks": "~/hooks"
  }
}
`,
  },
  { path: 'app/components/ui/button.tsx', contents: button },
  { path: 'app/components/ui/card.tsx', contents: card },
  { path: 'app/components/theme-toggle.tsx', contents: themeToggle },
  {
    path: 'app/lib/theme.ts',
    contents: `/** Static script applied before hydration. */
export const THEME_SCRIPT =
  ${JSON.stringify(renderThemeScript())};
`,
  },
];
