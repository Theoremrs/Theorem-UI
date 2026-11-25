// SOURCING: @vscode/vscode-languagedetection (VS Code's own guesslang model, the detector its editor runs on untitled files), loaded on first use with its model files served by Vite as VS Code's browser service does; @codemirror/language-data, the list Crepe's code blocks load a language from by alias; a ProseMirror plugin in the shape of the composer's others.
import { languages } from '@codemirror/language-data'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { ModelOperations } from '@vscode/vscode-languagedetection'

/**
 * The model spreads its confidence over 54 languages, so a right answer can
 * score 0.1: a guess is taken when it clears this floor and leads the next
 * one by MARGIN, and otherwise the block stays as it is.
 */
const MIN_CONFIDENCE = 0.08
const MARGIN = 1.8
/** Below this the model has too little to go on. */
const MIN_LENGTH = 20
/** Typing settles before the block is read again. */
const SETTLE_MS = 400

// The model and its files arrive together the first time a fence has no
// language word, in a chunk of their own: nothing of it loads before then.
let model: Promise<ModelOperations> | undefined
const loadModel = () =>
  (model ??= import('@vscode/vscode-languagedetection')
    .then(
      ({ ModelOperations }) =>
        new ModelOperations({
          modelJsonLoaderFunc: async () =>
            (await import('@vscode/vscode-languagedetection/model/model.json'))
              .default,
          weightsLoaderFunc: async () => {
            const { default: weights } =
              await import('@vscode/vscode-languagedetection/model/group1-shard1of1.bin?inline')
            return (await fetch(weights)).arrayBuffer()
          },
        }),
    )
    .catch((error: unknown) => {
      // A failed fetch is tried again by the next fence.
      model = undefined
      throw error
    }))

/**
 * The fence word Crepe can load for one of the model's ids: the id itself
 * when it is an alias (`ts`, `go`), else the first alias of the language
 * that owns it as an extension (`py` is Python's `python`).
 */
function fenceWord(id: string) {
  if (languages.some((language) => language.alias.includes(id))) return id
  return languages.find((language) => language.extensions.includes(id))
    ?.alias[0]
}

/** The language a piece of code is most likely written in, when the model is sure enough. */
export async function detectCodeLanguage(code: string) {
  if (code.trim().length < MIN_LENGTH) return undefined
  const [best, next] = await (await loadModel()).runModel(code)
  if (!best || best.confidence < MIN_CONFIDENCE) return undefined
  if (next && best.confidence < next.confidence * MARGIN) return undefined
  return fenceWord(best.languageId)
}

/** Blocks whose language this plugin chose, by position, with the language it chose. */
const key = new PluginKey<Map<number, string>>('theorem-code-language')

/**
 * A fence opened without a language word is given the one its code reads
 * as, and read again as the code grows. A language typed after the fence or
 * picked from the block's menu is the person's, and is left alone.
 */
export function codeLanguagePlugin() {
  return new Plugin({
    key,
    state: {
      init: () => new Map<number, string>(),
      apply(tr, chosen) {
        const next = new Map<number, string>()
        for (const [pos, language] of chosen) {
          const mapped = tr.mapping.mapResult(pos)
          if (mapped.deleted) continue
          const node = tr.doc.nodeAt(mapped.pos)
          // Changed since: someone picked another language.
          if (
            node?.type.name === 'code_block' &&
            node.attrs.language === language
          )
            next.set(mapped.pos, language)
        }
        const set = tr.getMeta(key) as
          { pos: number; language: string } | undefined
        if (set) next.set(set.pos, set.language)
        return next
      },
    },
    view(view) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let live = true
      const read = () => {
        const chosen = key.getState(view.state) ?? new Map<number, string>()
        view.state.doc.descendants((node, pos) => {
          if (node.type.name !== 'code_block') return true
          const language = String(node.attrs.language ?? '')
          if (language && chosen.get(pos) !== language) return false
          const code = node.textContent
          void detectCodeLanguage(code)
            .then((found) => {
              if (!live || !found) return
              const { state } = view
              const now = state.doc.nodeAt(pos)
              if (now?.type.name !== 'code_block' || now.textContent !== code)
                return
              const current = String(now.attrs.language ?? '')
              if (current === found) return
              if (current && key.getState(state)?.get(pos) !== current) return
              view.dispatch(
                state.tr
                  .setNodeAttribute(pos, 'language', found)
                  .setMeta(key, { pos, language: found })
                  .setMeta('addToHistory', false),
              )
            })
            .catch(() => undefined)
          return false
        })
      }
      // A restored draft or an edited message may open with a bare fence.
      timer = setTimeout(read, SETTLE_MS)
      return {
        update(current, previous) {
          if (current.state.doc.eq(previous.doc)) return
          clearTimeout(timer)
          timer = setTimeout(read, SETTLE_MS)
        },
        destroy() {
          live = false
          clearTimeout(timer)
        },
      }
    },
  })
}
