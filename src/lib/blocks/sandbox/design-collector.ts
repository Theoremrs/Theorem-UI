// Source builds use the shared collector through this typed module. The sandbox
// source map in runtime-sources.ts serves that same .mjs source as ./design-collector,
// so the in-page bundler neither copies it nor resolves outside its module map.
export { collectDesignObservations } from '../../../../packages/design-feedback/collect.mjs'
