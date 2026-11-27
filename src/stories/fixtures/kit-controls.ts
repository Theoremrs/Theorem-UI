// SOURCING: none: one App per @theorem/ui control, each drawing the first
// example on that control's page at astryx.atmeta.com/components (the
// references under docs/plans/evidence/refs/astryx-*@0.7.17-*.png) on a sheet
// the reference's size, so the collage lays the two over each other. Built
// from source in the same pipeline as any App the agent writes.

/** The example each reference shows, as the body of an App component. */
const EXAMPLES = {
  button: {
    title: 'Button',
    imports: 'Button, HStack',
    body: `<HStack gap={3}>
      <Button label="Primary" variant="primary" />
      <Button label="Secondary" variant="secondary" />
      <Button label="Ghost" variant="ghost" />
      <Button label="Destructive" variant="destructive" />
    </HStack>`,
  },
  'number-input': {
    title: 'NumberInput',
    imports: 'NumberInput',
    state: 'const [value, setValue] = useState<number | null>(0)',
    body: `<NumberInput label="Quantity" value={value} onChange={setValue} width={300} hasNumberSteppers
      formatValue={(n) => \`\${n} items\`} />`,
  },
  'segmented-control': {
    title: 'SegmentedControl',
    imports: 'SegmentedControl, SegmentedControlItem',
    state: "const [value, setValue] = useState('grid')",
    body: `<SegmentedControl label="View" value={value} onChange={setValue}>
      <SegmentedControlItem value="grid" label="Grid" />
      <SegmentedControlItem value="list" label="List" />
      <SegmentedControlItem value="table" label="Table" />
    </SegmentedControl>`,
  },
  selector: {
    title: 'Selector',
    imports: 'Selector',
    state: 'const [value, setValue] = useState<string>()',
    body: `<Selector label="Fruit" options={['Apple', 'Banana', 'Orange']} value={value}
      onChange={setValue} placeholder="Select a fruit..." width={300} />`,
  },
  slider: {
    title: 'Slider',
    imports: 'Slider',
    state: 'const [value, setValue] = useState(50)',
    body: '<Slider label="Volume" value={value} min={0} max={100} onChange={setValue} width={300} />',
  },
  switch: {
    title: 'Switch',
    imports: 'Switch',
    state: 'const [value, setValue] = useState(true)',
    body: '<Switch label="Enable notifications" value={value} onChange={setValue} />',
  },
} as const

export type KitControl = keyof typeof EXAMPLES
export const KIT_CONTROLS = Object.keys(EXAMPLES) as Array<KitControl>

const main = ({ imports, body, ...rest }: (typeof EXAMPLES)[KitControl]) => `
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ${imports}, Theme } from '@theorem/ui'
import './look.css'

function Example() {
  ${'state' in rest ? rest.state : ''}
  return (
    <div className="sheet">
      ${body}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Theme><Example /></Theme>)
`

// The reference's own frame: 912 by 513 CSS pixels, the example in its middle.
const LOOK = `html, body { margin: 0; }
.sheet {
  width: 912px; height: 513px; margin: 0 auto;
  display: grid; place-items: center;
  background: var(--theorem-surface);
}`

/** The App document showing `control`'s reference example. */
export function kitControlApp(control: KitControl): string {
  const example = EXAMPLES[control]
  return `<!doctype html>
<html lang="en"><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${example.title}</title>
</head><body>
<div id="root"></div>
<script type="text/theorem-source" data-path="main.tsx">${main(example)}</script>
<script type="text/theorem-source" data-path="look.css">${LOOK}</script>
</body></html>
`
}
