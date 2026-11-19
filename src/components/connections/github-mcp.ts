// SOURCING: GitHub's hosted MCP endpoint, shared by the integration view and add-server shortcut.
import type { McpServer } from '@/lib/theorem/connections'

export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/'

/** A hosted GitHub MCP connection, regardless of the name the person gave it. */
export function isGithubMcp(
  server: Pick<McpServer, 'transport' | 'url'>,
): boolean {
  if (server.transport !== 'http' || !server.url) return false
  try {
    const url = new URL(server.url)
    return (
      url.hostname === 'api.githubcopilot.com' &&
      (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'))
    )
  } catch {
    return false
  }
}
