# Run the design system locally

From the repository root (Node 24, no install needed — the server has zero dependencies):

```bash
pnpm design:serve                    # default port 4400
node design-system/serve.mjs 5000    # custom port
```

- Gallery: http://127.0.0.1:4400/gallery.html (`/` redirects here)
- Prototype (all screens, clickable): http://127.0.0.1:4400/prototype/agent-studio-prototype.dc.html

The port comes from the argument, then the `PORT` variable, then 4400. An invalid port or a port already in use prints one line and exits non-zero. The server binds to 127.0.0.1 only, answers `GET` and `HEAD` only (`405` otherwise) and returns `404` for anything outside this folder. Opening gallery.html directly from disk also works.

`pnpm design:test` runs the server's tests (`serve.test.mjs`, `node:test`, no dependencies); CI runs them in the `quality:web` job.

Both pages need internet access for React (unpkg) and the Inter / JetBrains Mono fonts (Google Fonts). The button at the top right switches between dark and light.

## Prototype options

The prototype was authored for the design canvas; `prototype/support.js` is a local stand-in for the canvas runtime (React 18 renderer for the `{{binding}}` / `<sc-if>` / `<sc-for>` template). URL parameters:

- `?startSignedIn=true` skips the login screen
- `?startTheme=light` starts in light mode

Use **Demo controls** (bottom left) to load the sample workspace, start empty, or simulate API errors.

## Files

Exported from Claude Design, kept byte-identical so a re-export diffs cleanly (ignored by Prettier):

- tokens.css: generated from tokens.json, the CSS variables the components use.
- components/bundle.css and bundle.js: the reference components (window.AgentStudio).
- code/globals.css: the theme for your Next.js + shadcn app.
- gallery.html, the component previews, README.md, prototype/README.md and the prototype page.

Hand-written, formatted by Prettier (re-included in `.prettierignore`):

- serve.mjs: zero-dependency static server for this folder.
- serve.test.mjs: its tests.
- prototype/support.js: the local stand-in for the canvas runtime.
- HOW-TO-RUN.md: this file. It replaced the exported original, which described canvas-only usage.

## Accepted risks

- **React from unpkg without SRI.** The pages load React from unpkg at view time, pinned to an exact version (`react@18.3.1`, `react-dom@18.3.1`) but without Subresource Integrity. Accepted because the exported `gallery.html` does the same and stays byte-identical, and the viewer is a local developer tool that no app imports.
- **Hand-written HOW-TO-RUN.md.** This file is not part of the export; a re-export that brings back its own HOW-TO-RUN.md must not overwrite it.
