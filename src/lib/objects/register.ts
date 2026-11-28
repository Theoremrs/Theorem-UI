// SOURCING: the records register's hooks (components/records/queries: the data model and declareSchema) and @tanstack/react-query; the registry itself is the pure classes.ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { declareObjectType } from '@/components/records/api'
import { useDataModel } from '@/components/records/queries'
import { classRegistry, missingStandardClasses } from './classes'

/** The effective class registry: the schema register's declared types, as Notes reads them. */
export function useClassRegistry() {
  const model = useDataModel()
  const registry = useMemo(() => classRegistry(model.data), [model.data])
  return { registry, model }
}

/**
 * Declares the standard library's classes the register still lacks, once per
 * visit, through the same declareSchema any class goes through. A register
 * that refuses keeps its error on the returned mutation.
 */
export function useStandardLibrary() {
  const { registry, model } = useClassRegistry()
  const client = useQueryClient()
  const declare = useMutation({
    mutationFn: async (inputs: Parameters<typeof declareObjectType>[0][]) => {
      for (const input of inputs) await declareObjectType(input)
    },
    onSettled: () =>
      void client.invalidateQueries({
        queryKey: ['theorem', 'records', 'model'],
      }),
  })
  const tried = useRef(false)
  useEffect(() => {
    if (!model.data || tried.current) return
    const missing = missingStandardClasses(model.data)
    if (!missing.length) return
    tried.current = true
    declare.mutate(missing)
  }, [model.data, declare])
  return { registry, model, declare }
}
