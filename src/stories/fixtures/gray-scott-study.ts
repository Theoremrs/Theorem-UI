// SOURCING: none. The Gray–Scott fixture's own script, unchanged, under three
// layouts drawn on the hosted App's --theorem-* variables (sandbox/theme.ts):
// a study for the owner to pick a direction from, not a component. Its
// controls stay native inputs; the kit replaces them with Astryx once a
// direction is picked.
import GRAY_SCOTT from './gray-scott.html?raw'

export const GRAY_SCOTT_DIRECTIONS = ['strip', 'inspector', 'overlay'] as const
export type GrayScottDirection = (typeof GRAY_SCOTT_DIRECTIONS)[number]

const SLIDERS = `
  <label class="ctl"><span class="name">Feed rate</span><output id="feedOut">0.0370</output>
    <input id="feed" type="range" min="0.010" max="0.090" step="0.0001" value="0.037"></label>
  <label class="ctl"><span class="name">Kill rate</span><output id="killOut">0.0600</output>
    <input id="kill" type="range" min="0.040" max="0.070" step="0.0001" value="0.060"></label>
  <label class="ctl"><span class="name">Steps / frame</span><output id="speedOut">10</output>
    <input id="speed" type="range" min="1" max="24" step="1" value="10"></label>
  <label class="ctl"><span class="name">Brush</span><output id="brushOut">12</output>
    <input id="brush" type="range" min="2" max="40" step="1" value="12"></label>`

const STAGE = `<div class="stage"><canvas id="view" aria-label="Gray–Scott simulation; drag to seed"></canvas><div class="err" id="err"></div></div>`

// What every direction shares: the host's ground and type, a canvas sized by
// its own aspect (not by the frame's height), and the host's quiet controls.
const BASE = `
  *{box-sizing:border-box}
  html,body{margin:0}
  body{font-size:13px;line-height:1.4}
  .stage{position:relative;overflow:hidden;background:#000;border-radius:var(--theorem-radius);aspect-ratio:16/9}
  canvas{display:block;width:100%;height:100%;touch-action:none;cursor:crosshair}
  .err{position:absolute;inset:0;display:none;place-items:center;padding:24px;text-align:center;color:#c9d1dc}
  .ctl{display:grid;grid-template-columns:1fr auto;align-items:baseline;gap:2px 8px;min-width:0}
  .ctl .name{color:var(--theorem-ink-muted)}
  .ctl output{font-variant-numeric:tabular-nums;color:var(--theorem-ink)}
  .ctl input{grid-column:1/-1;width:100%;margin:0;height:20px}
  button.primary{background:var(--theorem-accent);border-color:transparent;color:var(--theorem-on-accent)}
  button.primary:hover:not(:disabled){background:var(--theorem-accent-hover)}
  #presets button{border-radius:999px;padding:2px 10px;color:var(--theorem-ink-muted)}
  #presets button.on{color:var(--theorem-ink);border-color:var(--theorem-border-control);background:var(--theorem-selected)}
  @media (max-width:520px){.stage{aspect-ratio:1}}`

const LAYOUTS: Record<GrayScottDirection, { css: string; body: string }> = {
  // A: the picture, a one-line caption, then one compact strip of controls.
  strip: {
    css: `
  .gs{display:flex;flex-direction:column;gap:10px}
  .caption{margin:0;color:var(--theorem-ink-muted);font-size:12px}
  .controls{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 20px}
  .actions{display:flex;align-items:center;gap:6px;min-width:0}
  #presets{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;min-width:0;padding-left:6px;
    mask-image:linear-gradient(to right,#000 90%,transparent)}
  #presets button{flex:none}
  @media (max-width:520px){.controls{grid-template-columns:repeat(2,minmax(0,1fr))}
    .actions{flex-wrap:wrap}#presets{flex-basis:100%;padding-left:0}}`,
    body: `
<div class="gs">
  ${STAGE}
  <p class="caption">Gray–Scott reaction–diffusion · drag to seed, space to pause</p>
  <div class="controls">${SLIDERS}</div>
  <div class="actions">
    <button id="pause" class="primary">Pause</button>
    <button id="sprinkle">Sprinkle</button>
    <button id="reset">Reset</button>
    <button id="clear">Clear</button>
    <div id="presets" role="group" aria-label="Presets"></div>
  </div>
</div>`,
  },
  // B: the picture with an inspector column beside it; below it when narrow.
  inspector: {
    css: `
  .gs{display:grid;grid-template-columns:minmax(0,1fr) 216px;gap:16px;align-items:start}
  .stage{aspect-ratio:4/3}
  aside{display:flex;flex-direction:column;gap:14px}
  .btns{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .group{display:flex;flex-direction:column;gap:6px}
  .group > .label{color:var(--theorem-ink-faint);font-size:11px;letter-spacing:.02em}
  #presets{display:flex;flex-wrap:wrap;gap:4px}
  @media (max-width:560px){.gs{grid-template-columns:1fr}}`,
    body: `
<div class="gs">
  ${STAGE}
  <aside aria-label="Simulation controls">
    <div class="btns">
      <button id="pause" class="primary">Pause</button>
      <button id="reset">Reset</button>
      <button id="sprinkle">Sprinkle</button>
      <button id="clear">Clear</button>
    </div>
    ${SLIDERS}
    <div class="group"><span class="label">Presets</span><div id="presets" role="group" aria-label="Presets"></div></div>
  </aside>
</div>`,
  },
  // C: the picture alone; its controls float over it and open on demand.
  overlay: {
    css: `
  .dock{position:absolute;left:10px;top:56px;bottom:10px;right:10px;display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-start;gap:8px;pointer-events:none}
  .panel{min-height:0;overflow:auto}
  .dock > *{pointer-events:auto}
  .bar{display:flex;gap:4px;padding:4px;border-radius:calc(var(--theorem-radius) + 4px);
    background:color-mix(in srgb,var(--theorem-surface) 82%,transparent);backdrop-filter:blur(10px)}
  .bar button{border-color:transparent}
  .panel{display:none;width:min(100%,520px);padding:12px;border-radius:calc(var(--theorem-radius) + 4px);
    background:color-mix(in srgb,var(--theorem-surface) 88%,transparent);backdrop-filter:blur(10px)}
  .dock.open .panel{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 18px}
  .panel .row{grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap}
  #presets{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px}
  @media (max-width:520px){.dock{top:104px}.dock.open .panel{grid-template-columns:1fr}}`,
    body: `
${STAGE}
<template id="dock-template">
  <div class="dock">
    <div class="panel" id="params" role="group" aria-label="Parameters">
      ${SLIDERS}
      <div class="row"><button id="sprinkle">Sprinkle</button><button id="clear">Clear</button></div>
      <div id="presets" role="group" aria-label="Presets"></div>
    </div>
    <div class="bar">
      <button id="pause" class="primary">Pause</button>
      <button id="reset">Reset</button>
      <button id="toggle-params" aria-expanded="false" aria-controls="params">Parameters</button>
    </div>
  </div>
</template>`,
  },
}

/** The fixture with its markup and style replaced, its script left as it is. */
export function grayScottDirection(direction: GrayScottDirection): string {
  const { css, body } = LAYOUTS[direction]
  const styled = GRAY_SCOTT.replace(/<style>[\s\S]*?<\/style>/, `<style>${BASE}${css}\n</style>`)
  const start = styled.indexOf('<body>') + '<body>'.length
  const end = styled.indexOf('<script>', start)
  const markup =
    direction === 'overlay'
      ? // The dock must be in the stage before the fixture's script reads its ids.
        `${body}\n<script>{const s=document.querySelector('.stage');s.append(document.getElementById('dock-template').content.cloneNode(true));
const d=s.querySelector('.dock'),t=document.getElementById('toggle-params');
t.addEventListener('click',()=>{const o=d.classList.toggle('open');t.setAttribute('aria-expanded',String(o))});}</script>\n`
      : `${body}\n`
  return styled.slice(0, start) + markup + styled.slice(end)
}
