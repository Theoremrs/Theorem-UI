// SOURCING: coss ui Sidebar (provider, group and menu parts) over @tanstack/react-query's
// program list and the session graphs saved beside it (lib/program/api); the
// shell's ContextPanel mounts it in Canvas mode.
import { Link, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
} from '@/components/coss/sidebar'
import { Icon } from '@/components/icons'
import { listPrograms, listSessionGraphs, programKeys } from '@/lib/program/api'
import type { SessionGraphSummary } from '@/lib/program/api'
import { useOrganization } from '@/lib/theorem/organization'
import { useNewGraph } from './new-graph'
import { ToolError } from './section'

/** The session and project graphs a person saved, each opening on the canvas with its sessions read fresh. */
function SessionGraphsGroup() {
  const open = useSearch({ strict: false }).view
  const graphs = useQuery({
    queryKey: programKeys.sessionGraphs(),
    queryFn: listSessionGraphs,
  })
  const { data: organization } = useOrganization()
  const describe = (graph: SessionGraphSummary) => {
    if (graph.scope.kind === 'project') {
      const title = organization?.projects.find(
        (p) => p.projectId === graph.scope.id,
      )?.title
      return title ? `Project · ${title}` : 'Project graph'
    }
    const title = organization?.threads.find(
      (t) => t.threadId === graph.scope.id,
    )?.title
    return title ? `Tree · ${title}` : 'Session tree'
  }
  // Listed once there is one: a project or session menu is where a graph starts.
  if (!graphs.error && !graphs.data?.length) return null
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Session graphs</SidebarGroupLabel>
      <SidebarGroupContent>
        <ToolError error={graphs.error} />
        <SidebarMenu>
          {graphs.data?.map((graph) => (
            <SidebarMenuItem key={graph.node_id}>
              <SidebarMenuButton
                size="lg"
                className="data-[active=true]:bg-selected"
                isActive={open === graph.node_id}
                render={<Link to="/canvas" search={{ view: graph.node_id }} />}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm">{graph.name}</span>
                  <span className="block truncate text-xs font-normal text-ink-faint-sheet">
                    {describe(graph)}
                  </span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

export function ProgramsPanel() {
  const open = useSearch({ strict: false }).program
  const programs = useQuery({
    queryKey: programKeys.list(),
    queryFn: listPrograms,
  })
  const newGraph = useNewGraph()
  return (
    <SidebarProvider className="h-full min-h-0">
      <Sidebar collapsible="none" className="w-full bg-transparent">
        <SidebarContent role="navigation" aria-label="Graphs">
          <SidebarGroup>
            <SidebarGroupLabel render={<Link to="/canvas" />}>
              Graphs
            </SidebarGroupLabel>
            <SidebarGroupAction
              aria-label="New graph"
              title="New graph"
              disabled={newGraph.isPending}
              onClick={() => newGraph.mutate({})}
            >
              <Icon.NewGraph />
            </SidebarGroupAction>
            <SidebarGroupContent>
              <ToolError error={programs.error ?? newGraph.error} />
              <SidebarMenu>
                {programs.isPending && (
                  <>
                    <SidebarMenuSkeleton />
                    <SidebarMenuSkeleton />
                    <SidebarMenuSkeleton />
                  </>
                )}
                {programs.data?.map((program) => (
                  <SidebarMenuItem key={program.node_id}>
                    <SidebarMenuButton
                      size="lg"
                      className="data-[active=true]:bg-selected"
                      isActive={open === program.node_id}
                      render={
                        <Link
                          to="/canvas"
                          search={{ program: program.node_id }}
                        />
                      }
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm">
                          {program.name}
                        </span>
                        <span className="block truncate text-xs font-normal text-ink-faint-sheet">
                          {program.intent}
                        </span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SessionGraphsGroup />
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  )
}
