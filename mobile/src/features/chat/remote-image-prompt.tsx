import { Button } from '@/ui/button'
import { Text } from '@/ui/text'

/** Let the reader choose whether to make a request outside Theorem. */
export function RemoteImagePrompt({ uri, onLoad }: { uri: string; onLoad: () => void }) {
  const { host } = new URL(uri)
  return (
    <>
      <Text variant="label" tone="muted" selectable>
        Loading this image connects to {host}.
      </Text>
      <Button label="Load external image" variant="quiet" onPress={onLoad} />
    </>
  )
}
