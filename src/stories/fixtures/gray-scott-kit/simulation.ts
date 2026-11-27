// SOURCING: none: the Gray–Scott fixture's own simulation (../gray-scott.html),
// its shaders, palette, sizes and seeding unchanged, taken out of its page so
// a React App drives it. The loop reads its settings each frame, so moving a
// control never restarts it, and `stop` ends the loop and lets the context go.

export interface Settings {
  feed: number
  kill: number
  /** Steps a frame. */
  speed: number
  /** Brush radius, in simulation cells. */
  brush: number
  running: boolean
}

export interface Simulation {
  /** A software renderer, which gets a smaller field and fewer steps. */
  software: boolean
  reset: () => void
  sprinkle: () => void
  clear: () => void
  stop: () => void
}

const VERT = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const SIM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform ivec2 uSize;
uniform float uFeed, uKill, uDu, uDv, uDt;
out vec4 outColor;
ivec2 wrap(ivec2 p){
  return ivec2((p.x + uSize.x) % uSize.x, (p.y + uSize.y) % uSize.y);
}
vec2 at(ivec2 p){ return texelFetch(uState, wrap(p), 0).rg; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 c = at(p);
  vec2 lap = -c
    + 0.20 * (at(p+ivec2(1,0)) + at(p+ivec2(-1,0)) + at(p+ivec2(0,1)) + at(p+ivec2(0,-1)))
    + 0.05 * (at(p+ivec2(1,1)) + at(p+ivec2(-1,1)) + at(p+ivec2(1,-1)) + at(p+ivec2(-1,-1)));
  float u = c.r, v = c.g;
  float uvv = u * v * v;
  float du = uDu * lap.r - uvv + uFeed * (1.0 - u);
  float dv = uDv * lap.g + uvv - (uFeed + uKill) * v;
  outColor = vec4(clamp(c + uDt * vec2(du, dv), 0.0, 1.0), 0.0, 1.0);
}`

const SEED_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uBrush;
uniform float uRadius;
out vec4 outColor;
void main(){
  vec2 c = texelFetch(uState, ivec2(gl_FragCoord.xy), 0).rg;
  float d = length(gl_FragCoord.xy - uBrush);
  float m = 1.0 - smoothstep(uRadius * 0.45, uRadius, d);
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  m *= 0.75 + 0.25 * jitter;
  outColor = vec4(mix(c.r, 0.5, m), max(c.g, 0.9 * m), 0.0, 1.0);
}`

const FILL_FRAG = `#version 300 es
precision highp float;
uniform vec2 uValue;
out vec4 outColor;
void main(){ outColor = vec4(uValue, 0.0, 1.0); }`

const SHOW_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uRes;
out vec4 outColor;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float v = texture(uState, uv).g;
  float t = clamp(v * 2.6, 0.0, 1.0);
  vec3 bg    = vec3(0.043, 0.055, 0.078);
  vec3 mid   = vec3(0.075, 0.360, 0.440);
  vec3 crest = vec3(0.965, 0.870, 0.620);
  vec3 col = mix(bg, mid, smoothstep(0.02, 0.55, t));
  col = mix(col, crest, smoothstep(0.55, 1.0, t));
  vec2 q = uv - 0.5;
  col *= 1.0 - 0.35 * dot(q, q);
  outColor = vec4(col, 1.0);
}`

interface Program {
  p: WebGLProgram
  u: Record<string, WebGLUniformLocation | null>
}

interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
}

/** Starts the simulation on `canvas`; throws with what the browser lacks. */
export function simulate(canvas: HTMLCanvasElement, settings: () => Settings): Simulation {
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true })
  if (!gl) throw new Error('This app needs WebGL2, which this browser did not provide.')
  if (!gl.getExtension('EXT_color_buffer_float'))
    throw new Error(
      'This GPU/browser cannot render to floating-point textures (EXT_color_buffer_float), which the simulation needs.',
    )
  let rendererName = ''
  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  if (debug) rendererName = String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? '')
  const software = /swiftshader|llvmpipe|softpipe|software/i.test(rendererName)

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(shader)}`)
    return shader
  }
  const program = (fragment: string): Program => {
    const p = gl.createProgram()
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Link: ${gl.getProgramInfoLog(p)}`)
    const u: Program['u'] = {}
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(p, i)!
      u[info.name] = gl.getUniformLocation(p, info.name)
    }
    return { p, u }
  }
  const simProg = program(SIM_FRAG)
  const seedProg = program(SEED_FRAG)
  const fillProg = program(FILL_FRAG)
  const showProg = program(SHOW_FRAG)

  gl.bindVertexArray(gl.createVertexArray())
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.BLEND)

  // The field's size follows the stage's aspect when it starts.
  const stage = canvas.parentElement!
  const rect0 = stage.getBoundingClientRect()
  const LONG = software ? 384 : 720
  const aspect = Math.max(0.4, Math.min(2.5, rect0.width / Math.max(1, rect0.height)))
  const simW = aspect >= 1 ? LONG : Math.max(160, Math.round(LONG * aspect))
  const simH = aspect >= 1 ? Math.max(160, Math.round(LONG / aspect)) : LONG

  const makeTarget = (): Target => {
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, simW, simH, 0, gl.RGBA, gl.HALF_FLOAT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('Float framebuffer incomplete')
    return { tex, fbo }
  }
  let A = makeTarget()
  let B = makeTarget()
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3)
  const swap = () => {
    const t = A
    A = B
    B = t
  }
  const fill = (u: number, v: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo)
    gl.viewport(0, 0, simW, simH)
    gl.useProgram(fillProg.p)
    gl.uniform2f(fillProg.u.uValue!, u, v)
    draw()
  }
  const stamp = (x: number, y: number, r: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbo)
    gl.viewport(0, 0, simW, simH)
    gl.useProgram(seedProg.p)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, A.tex)
    gl.uniform1i(seedProg.u.uState!, 0)
    gl.uniform2f(seedProg.u.uBrush!, x, y)
    gl.uniform1f(seedProg.u.uRadius!, r)
    draw()
    swap()
  }
  const step = (feed: number, kill: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbo)
    gl.viewport(0, 0, simW, simH)
    gl.useProgram(simProg.p)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, A.tex)
    gl.uniform1i(simProg.u.uState!, 0)
    gl.uniform2i(simProg.u.uSize!, simW, simH)
    gl.uniform1f(simProg.u.uFeed!, feed)
    gl.uniform1f(simProg.u.uKill!, kill)
    gl.uniform1f(simProg.u.uDu!, 0.2097)
    gl.uniform1f(simProg.u.uDv!, 0.105)
    gl.uniform1f(simProg.u.uDt!, 1.0)
    draw()
    swap()
  }
  const show = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(showProg.p)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, A.tex)
    gl.uniform1i(showProg.u.uState!, 0)
    gl.uniform2f(showProg.u.uRes!, canvas.width, canvas.height)
    draw()
  }

  // ---------- seeding ----------
  const stamps: Array<{ x: number; y: number; r: number }> = []
  const spotR = software ? 0.55 : 1
  const randomSpots = (n: number) => {
    for (let i = 0; i < n; i++)
      stamps.push({
        x: simW * (0.15 + 0.7 * Math.random()),
        y: simH * (0.15 + 0.7 * Math.random()),
        r: (5 + Math.random() * 7) * spotR,
      })
  }

  let dragging = false
  let lastPt: { x: number; y: number } | null = null
  const toSim = (event: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    return { x: ((event.clientX - r.left) / r.width) * simW, y: (1 - (event.clientY - r.top) / r.height) * simH }
  }
  const pushStroke = (pt: { x: number; y: number }) => {
    const r = settings().brush
    if (lastPt) {
      const dx = pt.x - lastPt.x
      const dy = pt.y - lastPt.y
      const n = Math.min(48, Math.max(1, Math.ceil(Math.hypot(dx, dy) / (r * 0.4))))
      for (let i = 1; i <= n; i++) stamps.push({ x: lastPt.x + (dx * i) / n, y: lastPt.y + (dy * i) / n, r })
    } else stamps.push({ x: pt.x, y: pt.y, r })
    lastPt = pt
  }
  const down = (event: PointerEvent) => {
    dragging = true
    lastPt = null
    canvas.setPointerCapture(event.pointerId)
    pushStroke(toSim(event))
    event.preventDefault()
  }
  const move = (event: PointerEvent) => {
    if (dragging) pushStroke(toSim(event))
  }
  const end = () => {
    dragging = false
    lastPt = null
  }
  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('pointercancel', end)

  // ---------- sizing ----------
  const fitCanvas = () => {
    const r = stage.getBoundingClientRect()
    const dpr = software ? 1 : Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(2, Math.round(r.width * dpr))
    const h = Math.max(2, Math.round(r.height * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
  }
  const resized = new ResizeObserver(fitCanvas)
  resized.observe(stage)
  fitCanvas()

  // ---------- startup: seed and develop briefly so first paint is alive ----------
  fill(1, 0)
  for (let i = 0; i < 12; i++)
    stamp(simW * (0.15 + 0.7 * Math.random()), simH * (0.15 + 0.7 * Math.random()), (5 + Math.random() * 7) * spotR)
  const first = settings()
  for (let i = 0, warmup = software ? 20 : 60; i < warmup; i++) step(first.feed, first.kill)
  show()

  // ---------- main loop ----------
  let request = 0
  const frame = () => {
    fitCanvas()
    let budget = 64
    while (stamps.length && budget-- > 0) {
      const s = stamps.shift()!
      stamp(s.x, s.y, s.r)
    }
    const now = settings()
    if (now.running && !document.hidden) for (let i = 0; i < now.speed; i++) step(now.feed, now.kill)
    show()
    request = requestAnimationFrame(frame)
  }
  request = requestAnimationFrame(frame)

  return {
    software,
    reset: () => {
      fill(1, 0)
      randomSpots(12)
    },
    sprinkle: () => randomSpots(10),
    clear: () => {
      fill(1, 0)
      stamps.length = 0
    },
    stop: () => {
      cancelAnimationFrame(request)
      resized.disconnect()
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', end)
      canvas.removeEventListener('pointercancel', end)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
