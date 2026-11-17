// SOURCING: @lobehub/icons-static-svg (Lobe Icons, MIT, https://github.com/lobehub/lobe-icons) for the providers' monochrome marks, imported one file each as an asset URL so only these ship; drawn as a CSS mask so a mark takes the ink around it in every palette. The React package (@lobehub/icons) needs @lobehub/ui, so the static files are the lighter fit.
import anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg?url'
import ai21 from '@lobehub/icons-static-svg/icons/ai21.svg?url'
import alibaba from '@lobehub/icons-static-svg/icons/alibaba.svg?url'
import arcee from '@lobehub/icons-static-svg/icons/arcee.svg?url'
import aws from '@lobehub/icons-static-svg/icons/aws.svg?url'
import baidu from '@lobehub/icons-static-svg/icons/baidu.svg?url'
import bytedance from '@lobehub/icons-static-svg/icons/bytedance.svg?url'
import cohere from '@lobehub/icons-static-svg/icons/cohere.svg?url'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek.svg?url'
import gemini from '@lobehub/icons-static-svg/icons/gemini.svg?url'
import inception from '@lobehub/icons-static-svg/icons/inception.svg?url'
import inflection from '@lobehub/icons-static-svg/icons/inflection.svg?url'
import liquid from '@lobehub/icons-static-svg/icons/liquid.svg?url'
import meta from '@lobehub/icons-static-svg/icons/meta.svg?url'
import microsoft from '@lobehub/icons-static-svg/icons/microsoft.svg?url'
import minimax from '@lobehub/icons-static-svg/icons/minimax.svg?url'
import mistral from '@lobehub/icons-static-svg/icons/mistral.svg?url'
import moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg?url'
import nousresearch from '@lobehub/icons-static-svg/icons/nousresearch.svg?url'
import nvidia from '@lobehub/icons-static-svg/icons/nvidia.svg?url'
import openai from '@lobehub/icons-static-svg/icons/openai.svg?url'
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg?url'
import perplexity from '@lobehub/icons-static-svg/icons/perplexity.svg?url'
import qwen from '@lobehub/icons-static-svg/icons/qwen.svg?url'
import stepfun from '@lobehub/icons-static-svg/icons/stepfun.svg?url'
import xai from '@lobehub/icons-static-svg/icons/xai.svg?url'
import zai from '@lobehub/icons-static-svg/icons/zai.svg?url'
import { Icon } from '@/components/icons'
import { cn } from '@/lib/utils'

/** The maker part of a model id (OpenRouter's spelling) to its mark. */
const MARKS: Readonly<Record<string, string>> = {
  anthropic,
  ai21,
  alibaba,
  'arcee-ai': arcee,
  amazon: aws,
  baidu,
  bytedance,
  'bytedance-seed': bytedance,
  cohere,
  deepseek,
  google: gemini,
  inception,
  inflection,
  liquid,
  'meta-llama': meta,
  meta,
  microsoft,
  minimax,
  mistralai: mistral,
  mistral,
  moonshotai: moonshot,
  moonshot,
  nousresearch,
  nvidia,
  openai,
  openrouter,
  perplexity,
  qwen,
  'stepfun-ai': stepfun,
  'x-ai': xai,
  xai,
  'z-ai': zai,
  thudm: zai,
}

/** Whether the maker has a mark of its own. */
export const hasModelMark = (vendor: string) => vendor.toLowerCase() in MARKS

/**
 * A model's maker as its logo, in the ink around it. A maker without one
 * gets the generic model mark rather than a guess.
 */
export function ModelMark({
  vendor,
  className,
}: {
  vendor: string
  className?: string
}) {
  const url = MARKS[vendor.toLowerCase()]
  if (!url)
    return (
      <Icon.Model
        aria-hidden="true"
        data-model-mark="fallback"
        className={cn('size-4 shrink-0', className)}
      />
    )
  return (
    <span
      aria-hidden="true"
      data-model-mark={vendor.toLowerCase()}
      className={cn('size-4 shrink-0 bg-current', className)}
      style={{
        maskImage: `url("${url}")`,
        WebkitMaskImage: `url("${url}")`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    />
  )
}
