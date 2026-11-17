// SOURCING: native response-styles API, SDK passthrough and mutation headers, TanStack Query.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { mutate } from './client'
import { theoremJson } from './passthrough'

const stylesSchema = z.object({
  styles: z.array(
    z.object({ id: z.string(), name: z.string(), description: z.string() }),
  ),
  selection: z.object({
    account: z.string().nullable(),
    conversation: z.string().nullable(),
    effective: z.object({
      style: z.string(),
      name: z.string(),
      source: z.string(),
    }),
  }),
})
const path = '/api/chat/v1/response-styles'
const key = ['theorem', 'output-styles'] as const

/** The server owns style inheritance and persistence; never turn a style into a token cap. */
export function useOutputStyles(threadId?: string) {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: [...key, threadId ?? 'account'],
    queryFn: async () =>
      stylesSchema.parse(
        await theoremJson<unknown>(
          threadId ? `${path}?threadId=${encodeURIComponent(threadId)}` : path,
        ),
      ),
  })
  const save = useMutation({
    mutationFn: (style: string | null) =>
      mutate((headers) =>
        theoremJson<unknown>(`${path}/selection`, {
          method: 'PUT',
          headers,
          body: {
            scope: threadId ? 'conversation' : 'account',
            ...(threadId ? { threadId } : {}),
            style,
          },
        }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  })
  return { ...query, save }
}
