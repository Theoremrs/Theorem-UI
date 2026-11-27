// SOURCING: components/pages (ModuleInstance and PageRuntimeProvider: the
// existing module runtime that places a vault module). A panel or shell
// contribution a module declares carries `meta.moduleId` and no component
// code, so the shell mounts the module itself, one runtime per mount, inside
// the host's error boundary (EXT-08).
import type { ComponentType } from 'react'
import { ModuleInstance } from '@/components/pages/module-instance'
import { PageRuntimeProvider } from '@/components/pages/page-runtime'

export function ModuleMount({
  moduleId,
  label,
}: {
  moduleId: string
  label: string
}) {
  return (
    <PageRuntimeProvider>
      <ModuleInstance
        type={moduleId}
        props={{ id: `shell:${moduleId}`, title: label }}
        arranging={false}
      />
    </PageRuntimeProvider>
  )
}

/** A component that mounts the module a contribution names, if it names one. */
export function moduleComponentOf(contribution: {
  label: string
  meta?: Readonly<Record<string, unknown>>
}): ComponentType<any> | undefined {
  const moduleId = contribution.meta?.moduleId
  if (typeof moduleId !== 'string') return undefined
  return function MountedModule() {
    return <ModuleMount moduleId={moduleId} label={contribution.label} />
  }
}
