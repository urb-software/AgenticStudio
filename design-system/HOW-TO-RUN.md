# Run the design system locally

From the repository root (Node 24, no install needed — the server has zero dependencies):

```bash
pnpm design:serve                    # default port 4400
node design-system/serve.mjs 5000    # custom port
```

- Gallery: http://127.0.0.1:4400/gallery.html
- Prototype (all screens, clickable): http://127.0.0.1:4400/prototype/agent-studio-prototype.dc.html

The server binds to 127.0.0.1 only. Opening gallery.html directly from disk also works.

Both pages need internet access for React (unpkg) and the Inter / JetBrains Mono fonts (Google Fonts). The button at the top right switches between dark and light.

## Prototype options

The prototype was authored for the design canvas; `prototype/support.js` is a local stand-in for the canvas runtime (React 18 renderer for the `{{binding}}` / `<sc-if>` / `<sc-for>` template). URL parameters:

- `?startSignedIn=true` skips the login screen
- `?startTheme=light` starts in light mode

Use **Demo controls** (bottom left) to load the sample workspace, start empty, or simulate API errors.

## Files

- tokens.css: generated from tokens.json, the CSS variables the components use.
- components/bundle.css and bundle.js: the reference components (window.AgentStudio).
- code/globals.css: the theme for your Next.js + shadcn app.
- serve.mjs: zero-dependency static server for this folder.
