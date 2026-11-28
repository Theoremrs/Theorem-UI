// SOURCING: the settings frame's SettingsRow, coss ui Input and Badge, ui/button, @tanstack/react-query (the machine's discover call); the pairing and the call are lib/machine/machine.ts, against theorem-compute-serve on the person's machine
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/coss/badge'
import { Input } from '@/components/coss/input'
import { Icon } from '@/components/icons'
import {
  SettingsBox,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-frame'
import { Button } from '@/components/ui/button'
import {
  callMachine,
  normalUrl,
  pairingFromHash,
  setMachinePairing,
  useMachinePairing,
} from '@/lib/machine/machine'
import type { MachinePairing } from '@/lib/machine/machine'

const DEFAULT_URL = 'http://127.0.0.1:8083'
const SERVE = 'theorem-compute-serve'

interface Discovered {
  hardware?: {
    os?: string
    arch?: string
    cpus?: number
    memory_mb?: number
    cpu_model?: string | null
    accelerator?: string | null
  }
}

function describe(found: Discovered | undefined): string | undefined {
  const hardware = found?.hardware
  if (!hardware) return undefined
  return [
    hardware.cpu_model ?? `${hardware.os} ${hardware.arch}`,
    hardware.cpus && `${hardware.cpus} cores`,
    hardware.memory_mb && `${Math.round(hardware.memory_mb / 1024)} GB`,
    hardware.accelerator,
  ]
    .filter(Boolean)
    .join(', ')
}

function Paired({ pairing }: { pairing: MachinePairing }) {
  const discovered = useQuery({
    queryKey: ['machine-compute', pairing.url, pairing.token],
    queryFn: () =>
      callMachine(
        pairing,
        { action: 'discover' },
        60_000,
      ) as Promise<Discovered>,
    retry: false,
  })
  return (
    <SettingsRow
      Mark={Icon.Terminal}
      title="This machine"
      description={
        [pairing.url, describe(discovered.data)].filter(Boolean).join(', ') +
        (discovered.error ? `: ${discovered.error.message}` : '')
      }
    >
      <div className="flex items-center gap-2">
        <Badge
          variant={
            discovered.isPending
              ? 'secondary'
              : discovered.error
                ? 'error'
                : 'success'
          }
        >
          {discovered.isPending
            ? 'Checking'
            : discovered.error
              ? 'Unreachable'
              : 'Connected'}
        </Badge>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMachinePairing(undefined)}
        >
          Forget
        </Button>
      </div>
    </SettingsRow>
  )
}

function Unpaired({ linked }: { linked?: MachinePairing }) {
  const [url, setUrl] = useState(linked?.url ?? DEFAULT_URL)
  const [token, setToken] = useState(linked?.token ?? '')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  const address = normalUrl(url)
  const pair = async () => {
    if (!address) return
    const pairing = { url: address, token: token.trim() }
    setChecking(true)
    setError(undefined)
    try {
      await callMachine(pairing, { action: 'jobs', limit: 1 }, 15_000)
      setMachinePairing(pairing)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChecking(false)
    }
  }
  return (
    <SettingsRow
      Mark={Icon.Terminal}
      title="This machine"
      description={error ?? <code>{SERVE}</code>}
    >
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void pair()
        }}
      >
        <Input
          aria-label="Server address"
          className="w-48"
          size="sm"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Input
          aria-label="Token"
          className="w-48"
          size="sm"
          type="password"
          placeholder="Token"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          type="submit"
          disabled={!address || token.trim().length < 32 || checking}
        >
          {checking ? 'Pairing' : 'Pair'}
        </Button>
      </form>
    </SettingsRow>
  )
}

/** Computing on the person's own machine: pairing this browser with its server. */
export function ThisMachine() {
  const pairing = useMachinePairing()
  // The link theorem-compute-serve prints carries the pairing after `#`. It
  // only fills the form: pairing waits for Pair, which checks the server.
  const [linked] = useState(() =>
    typeof window === 'undefined'
      ? undefined
      : pairingFromHash(window.location.hash),
  )
  useEffect(() => {
    if (!linked) return
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    )
  }, [linked])
  return (
    <SettingsSection title="Compute">
      <SettingsBox>
        {pairing ? <Paired pairing={pairing} /> : <Unpaired linked={linked} />}
      </SettingsBox>
    </SettingsSection>
  )
}
