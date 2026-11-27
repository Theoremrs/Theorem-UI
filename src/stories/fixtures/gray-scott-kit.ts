// SOURCING: none: the Gray–Scott kit App as an App document holds it, its
// files carried as source scripts (lib/blocks/app-source.ts), which the host
// builds in the same pipeline as any App the agent writes.
import LOOK from './gray-scott-kit/look.css?raw'
import MAIN from './gray-scott-kit/main.tsx?raw'
import PRESET_MAP from './gray-scott-kit/preset-map.tsx?raw'
import SIMULATION from './gray-scott-kit/simulation.ts?raw'

const FILES: Record<string, string> = {
  'main.tsx': MAIN,
  'preset-map.tsx': PRESET_MAP,
  'simulation.ts': SIMULATION,
  'look.css': LOOK,
}

export const GRAY_SCOTT_KIT = `<!doctype html>
<html lang="en"><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gray-Scott Reaction-Diffusion</title>
</head><body>
<div id="root"></div>
${Object.entries(FILES)
  .map(([path, source]) => `<script type="text/theorem-source" data-path="${path}">${source}</script>`)
  .join('\n')}
</body></html>
`
