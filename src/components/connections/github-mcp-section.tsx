// SOURCING: the existing MCP server row and dialogs, grouped with GitHub's repository connection.
import { useState } from 'react'
import { SettingsBox } from '@/components/settings/settings-frame'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/theorem/client'
import { useMcpServers } from '@/lib/theorem/connections'
import { isGithubMcp } from './github-mcp'
import { ServerRow } from './mcp-servers'
import { ServerDetail } from './server-detail'
import { ServerDialog } from './server-dialog'

/** The optional hosted tools share GitHub's setup view, with their own account grant. */
export function GithubMcp() {
  const query = useMcpServers()
  const servers = query.data?.filter(isGithubMcp) ?? []
  const [adding, setAdding] = useState(false)
  const [detail, setDetail] = useState<string>()
  const [editing, setEditing] = useState<string>()
  return (
    <div className="flex flex-col gap-3 border-t border-separator pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-sm font-medium">GitHub MCP tools</h3>
          <p className="text-sm text-ink-muted">
            Optional tools from GitHub's hosted server, with their own
            authorization and availability switch.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          {servers.length ? 'Add another GitHub account' : 'Add GitHub tools'}
        </Button>
      </div>
      {query.error ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-error-ink">
            {describeError(query.error)}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Check GitHub tools again
          </Button>
        </div>
      ) : query.isPending ? (
        <p role="status" className="text-sm text-ink-muted">
          Checking GitHub tools...
        </p>
      ) : servers.length ? (
        <SettingsBox>
          {servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              onOpen={() => setDetail(server.id)}
              onEdit={() => setEditing(server.id)}
            />
          ))}
        </SettingsBox>
      ) : (
        <p className="text-sm text-ink-muted">
          GitHub MCP tools are not connected.
        </p>
      )}
      <ServerDialog
        open={adding}
        onOpenChange={setAdding}
        preset="github"
        stdioAvailable={false}
        onReviewTools={setDetail}
      />
      <ServerDialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(undefined)}
        server={servers.find((server) => server.id === editing)}
        stdioAvailable={false}
      />
      <ServerDetail
        id={detail}
        onOpenChange={(open) => !open && setDetail(undefined)}
      />
    </div>
  )
}
