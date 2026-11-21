// liquid-gl 3.0.0 ships no declarations. These are the parts glass.tsx uses,
// from its README's parameter table.
declare module 'liquid-gl' {
  export interface LiquidGLOptions {
    target: string
    snapshot?: string
    resolution?: number
    engine?: 'auto' | 'webgpu' | 'webgl2' | 'webgl'
    zIndex?: number
    content?: string | false
    refraction?: number
    aberration?: number
    bevelDepth?: number
    bevelWidth?: number
    frost?: number
    shadow?: boolean
    specular?: boolean
    reveal?: 'none' | 'fade'
    tint?: string | null
  }
  export interface LiquidGLLens {
    /** Null where liquidGL fell back to a CSS backdrop-filter. */
    renderer: unknown
    destroy(): void
    setTint(value: string | null): unknown
  }
  interface LiquidGL {
    (options: LiquidGLOptions): LiquidGLLens | Array<LiquidGLLens> | undefined
    registerDynamic(elements: string | ReadonlyArray<Element>): void
  }
  /** Undefined where there is no window. */
  const liquidGL: LiquidGL | undefined
  export default liquidGL
}
