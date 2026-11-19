# Twenty UI (twenty-ui)

`chip.tsx`, `avatar.tsx`, `tag.tsx` and `checkbox.tsx` in this folder are ports
of primitives from Twenty's `packages/twenty-ui`, pinned at commit
`26fa97ebc8a5773e842ba0d2f01e0b24bed6e7d0` of https://github.com/twentyhq/twenty.
That package is licensed under the MIT license below. Only `twenty-ui` was
used; nothing was taken from the AGPL-licensed parts of that repository.

What was ported is each primitive's structure, props, variants and measurements
(spacing unit 4 px; Chip 20/24 px high, gap 4, padding 4, radius 4; Avatar
sizes 12/14/16/24/32/40; Tag 20 px high, padding 0 8; Checkbox box 12 px),
re-expressed with Tailwind classes and Theorem's CSS variables. Twenty's
colours, fonts, icons and stylesheets were not copied.

---

MIT License

Copyright (c) 2023-present Twenty.com, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
