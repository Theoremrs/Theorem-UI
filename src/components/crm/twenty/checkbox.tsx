// SOURCING: Twenty UI's Checkbox primitive (packages/twenty-ui/src/primitives/input/Checkbox, MIT), ported: the small size's 12 px box with a 1 px border and 4 px radius, the "hoverable" padding that widens the target round it (5 px, so 22 px in all), the filled box when checked or indeterminate, and the disabled look; over Base UI's Checkbox, as Twenty's is, with Theorem's focus colour standing in for Twenty's accent blue.
//
// Ported from twenty-ui at commit 26fa97ebc8a5773e842ba0d2f01e0b24bed6e7d0.
// Copyright (c) 2023-present Twenty.com, PBC. MIT License; the full text is
// in ./LICENSE-twenty.md.
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { cn } from '@/lib/utils'

export function Checkbox({
  className,
  ...props
}: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      {...props}
      className={cn(
        'group/checkbox relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md p-[5px] outline-none hover:bg-ink/4 focus-visible:outline-2 focus-visible:outline-focus data-disabled:cursor-not-allowed data-disabled:hover:bg-transparent',
        className,
      )}
    >
      <span className="box-border flex size-3 items-center justify-center rounded-[3px] border border-ink-muted bg-transparent text-background group-data-checked/checkbox:border-focus group-data-checked/checkbox:bg-focus group-data-indeterminate/checkbox:border-focus group-data-indeterminate/checkbox:bg-focus group-data-disabled/checkbox:border-control">
        <CheckboxPrimitive.Indicator
          keepMounted
          className="flex items-center justify-center data-unchecked:hidden"
          render={(indicator, state) => (
            <span {...indicator}>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-2.5"
              >
                {state.indeterminate ? (
                  <path d="M5 12h14" />
                ) : (
                  <path d="M5 12.5 10 18 19 6" />
                )}
              </svg>
            </span>
          )}
        />
      </span>
    </CheckboxPrimitive.Root>
  )
}
