# Third-party notices

Code in this repository that was ported from another project, with the licence
it came under. Packages installed from a registry carry their own licences in
`node_modules` and are not listed here.

## Twenty UI (`twenty-ui`)

- Source: https://github.com/twentyhq/twenty, `packages/twenty-ui`, pinned at
  commit `26fa97ebc8a5773e842ba0d2f01e0b24bed6e7d0`
- Licence: MIT. Copyright (c) 2023-present Twenty.com, PBC
- Where: `src/components/crm/twenty/chip.tsx`, `avatar.tsx`, `tag.tsx` and
  `checkbox.tsx`. Each file's header says what it ported.
- What: the structure, props, variants and measurements of the Chip, Avatar,
  Tag and Checkbox primitives, re-expressed with Tailwind classes and Theorem's
  CSS variables. Twenty's colours, fonts, icons and stylesheets were not
  copied, and nothing was taken from the AGPL-licensed parts of that
  repository.
- Full licence text: `src/components/crm/twenty/LICENSE-twenty.md`
