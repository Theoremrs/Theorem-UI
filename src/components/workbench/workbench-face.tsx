// SOURCING: components/face/terminal-face-perch (the element the one face driver rests Theo on) and lib/face/store's `mounted` (whether the page's FaceStage, the one Theo, is up); components/terminal/live-terminal-theme for the palette the terminal is drawn in. This only asks the core for the Theo panel's reserved cells while the face is up, follows them each frame, and places the perch over them; the driver and the face's state are not here.
import { useEffect, useState } from 'react'
import { TerminalFacePerch } from '@/components/face/terminal-face-perch'
import type { FaceCells } from '@/components/face/terminal-face-perch'
import { useTerminalTheme } from '@/components/terminal/live-terminal-theme'
import { useFaceStage } from '@/lib/face/store'
import type { WorkbenchHandle } from '@/terminal-wasm/theorem_terminal'

type Cell = { width: number; height: number }

/** Theo's face on the status row of a Theo panel, over the grid it is drawn on. Renders nothing while the face is off. */
export function WorkbenchFace({
  host,
}: {
  host: Pick<WorkbenchHandle, 'set_face' | 'face_geometry' | 'cell_size'>
}) {
  const wanted = useFaceStage((state) => state.mounted)
  const chrome = useTerminalTheme((state) => state.roles.chrome)
  const [cells, setCells] = useState<FaceCells | null>(null)
  const [cell, setCell] = useState<Cell>()

  useEffect(() => {
    host.set_face(wanted)
    if (!wanted) return
    let epoch = 0
    let frame = 0
    const tick = () => {
      const json = host.face_geometry(epoch)
      if (json) {
        const next = JSON.parse(json) as {
          epoch: number
          cells: FaceCells | null
        }
        epoch = next.epoch
        setCells(next.cells)
      }
      const measured = host.cell_size()
      if (measured) {
        const next = JSON.parse(measured) as Cell
        setCell((held) =>
          held && held.width === next.width && held.height === next.height
            ? held
            : next,
        )
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      host.set_face(false)
    }
  }, [host, wanted])

  if (!wanted || !cell) return null
  return (
    <TerminalFacePerch
      cells={cells}
      cell={cell}
      theme={{ bg: chrome.bg, ink: chrome.text }}
    />
  )
}
