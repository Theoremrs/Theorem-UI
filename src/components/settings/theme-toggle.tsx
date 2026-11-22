// Reuse the app's accessible icon button and next-themes mode persistence.
import { useTheme } from 'next-themes'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode'
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      className="size-8 text-ink-muted"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? (
        <Icon.Sun className="size-4" />
      ) : (
        <Icon.Moon className="size-4" />
      )}
    </Button>
  )
}
