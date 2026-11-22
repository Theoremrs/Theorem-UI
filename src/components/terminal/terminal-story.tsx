import { useEffect, useState } from 'react'
import { showStory, TerminalScreen } from './terminal-screen'
import type { TerminalAction } from './terminal-screen'
import type { storySnapshot } from './terminal-stories'

export default function TerminalStory({
  id,
  title,
  snapshot,
}: {
  id: string
  title: string
  snapshot: ReturnType<typeof storySnapshot>
}) {
  const key = `story:${id}`
  const [action, setAction] = useState<TerminalAction>()
  useEffect(() => showStory(key, snapshot), [key, snapshot])
  return (
    <main
      data-story={id}
      data-action={action && JSON.stringify(action)}
      className="flex h-[640px] w-[900px] flex-col overflow-hidden"
    >
      <TerminalScreen
        hostId={`story-terminal-${id}`}
        tabbed={false}
        tabs={[{ id: key, title }]}
        active={key}
        onAction={setAction}
      />
    </main>
  )
}
