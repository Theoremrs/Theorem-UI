// SOURCING: none: an App that counts its own animation frames and shows the
// presentation the page last sent it, for the presentation work order of
// docs/plans/chromeless-artifacts.md. Expanding, collapsing, resizing or a
// theme change must leave the count climbing: a reload would start it at 0.

const MAIN = `
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import './look.css'

function Counter() {
  const [frames, setFrames] = useState(0)
  const [where, setWhere] = useState('none yet')
  useEffect(() => {
    let id = requestAnimationFrame(function tick() {
      setFrames((n) => n + 1)
      id = requestAnimationFrame(tick)
    })
    const stop = theorem.presentation.onChange((p) => setWhere(\`\${p.mode} \${Math.round(p.width)}×\${Math.round(p.height)}\`))
    return () => {
      cancelAnimationFrame(id)
      stop()
    }
  }, [])
  return (
    <div className="counter">
      <output aria-label="Frames since the App started">{frames}</output>
      <span aria-label="Presentation">{where}</span>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Counter />)
`

const LOOK = `html, body { margin: 0; }
.counter {
  height: 240px; display: grid; place-content: center; gap: 8px; text-align: center;
  font-family: var(--theorem-font-mono, ui-monospace, monospace);
  color: var(--theorem-ink); background: var(--theorem-surface);
}
.counter output { font-size: 56px; font-variant-numeric: tabular-nums; }
.counter span { color: var(--theorem-ink-muted, var(--theorem-ink)); }`

export const FRAME_COUNTER = `<!doctype html>
<html lang="en"><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Frame counter</title>
</head><body>
<div id="root"></div>
<script type="text/theorem-source" data-path="main.tsx">${MAIN}</script>
<script type="text/theorem-source" data-path="look.css">${LOOK}</script>
</body></html>
`
