# Agent Studio

The design system for **Agent Studio**: a private, self-hosted workspace where one developer (the operator) runs coding agents through the Claude Code and Codex CLIs, reviews what they change, and merges it into `dev`. It is a power tool in the family of Linear, Vercel, GitHub and Raycast: calm, dense but airy, keyboard-first, dark by default.

Built from the clickable prototype (“AI Agent Studio — clickable prototype”). Target stack: **Next.js App Router + React + TypeScript + Tailwind + shadcn/ui** (Radix primitives, lucide icons). `code/globals.css` in this system is a drop-in shadcn theme with every token mapped.

## Principles

1. **The operator is in control.** Nothing reaches `dev` without an explicit approval. UI that commits, merges, stops or deletes always confirms, and says exactly what it will touch.
2. **State is the only colour.** The interface is neutral zinc plus one violet. Colour otherwise means run state (queued, running, awaiting, succeeded, failed, cancelled), and each state has exactly one token.
3. **Amber means “you”.** `run-awaiting` is reserved for things waiting on the operator: approvals, warnings, rate limits. If everything is amber, nothing is.
4. **Show the machine.** Branch names, run IDs, commands, SHAs and paths are shown in mono, verbatim. Don't paraphrase what the agent did; link to the log line.
5. **Keyboard first.** Every screen is reachable from ⌘K; focus is always visible; dialogs trap focus and close on Esc.

## Voice

Plain, technical and short. The reader is a senior developer.

- Sentence case everywhere: “Approve & merge to dev”, “Connect repository”.
- Buttons are verb + object. Results are past tense: “Merged to dev · Preview rebuilding”, “Project created”.
- Errors say what failed and what to do: “Use an SSH (git@…) or HTTPS URL”, “Connect a repository to acme-shop first.” Server errors show the problem+json **title** in bold, then the detail.
- Name real things: `dev`, `agent/claude-add-pagination-1043`, `r-1043`, `pnpm vitest run`. No “Oops”, no exclamation marks, no emoji.
- Numbers are exact (“1 of 12 tests failed”, “↑4 ↓0 vs dev”). Times are relative in lists (“3h ago”) and durations are `4m 12s`.

## Colour

Two themes, **dark first** (it is the fallback); light is a full peer, not an afterthought. Every text token is AA (4.5:1) on the neutral surfaces of its own theme.

**Neutrals** build the layers: `bg` (app) → `bg-subtle` (sidebar, table headers, inputs, wells) → `surface` (cards, popovers, dialogs) → `surface-raised` (chips, segmented track). `hover` is the one hover fill. `border` draws hairlines; `border-strong` draws control edges (3:1). Text is `text` → `text-muted` → `text-dim`; `text-dim` is for metadata only, never for something the operator must act on.

**Accent**: `accent-solid` (#7c3aed) is the fill for the one primary button per view, the selected tab underline, active switches and the logo tile, always with `on-accent` text. `accent` is the violet for text and icons: links, the active nav icon, the focus ring. `accent-soft` marks selection (nav item, picker card, palette row).

**Run states**: each has a text/icon token and a `-soft` fill. Pills put the strong token on its soft fill. `run-cancelled` is deliberately an outline, not a fill.

| State | Token | Used for |
|---|---|---|
| Queued | `run-queued` | waiting for a worker |
| Running | `run-running` | CLI working, Preview building, current step, info |
| Awaiting approval | `run-awaiting` | approval gates, warnings, lockouts |
| Succeeded | `run-succeeded` | merged, healthy, passing tests, additions |
| Failed | `run-failed` | errors, unhealthy, failing tests, deletions |
| Cancelled | `run-cancelled` | cancelled, rejected, stopped |

Health dots (`dot-green`, `dot-blue`, `dot-amber`, `dot-red`) are 8px and always sit beside a label. `danger-solid` appears only on the confirm button of a destructive dialog.

## Typography

**Inter** for the interface, **JetBrains Mono** for code, logs, branch names, IDs, models and paths. Both are Google-hosted: load them with `next/font/google` and expose them as `--font-sans` / `--font-mono`.

The scale is small and dense: `page-title` 24/30 semibold, `section-title` 16/22 (dialogs, empty states), `card-title` 14/20 semibold, `body` 14/20, `label` 13.5/20 medium (buttons, tabs, nav), `small` 13/18, `caption` 12/16 medium (pills, headers) and `overline` 11.5/16 uppercase for group headers. Code is `code` 12.5/20: 20px rows keep log and diff gutters aligned.

Use tabular numbers (`font-variant-numeric: tabular-nums`) for durations, counts and timers.

## Space, radius, elevation

- 4px base: `space-1` … `space-12`. Cards pad `space-4`; dialogs `space-5`; pages `space-8` horizontally at desktop, `space-4` on tablet.
- Radius: `radius-md` 8px is the default (buttons, inputs); `radius-lg` 10px for cards, tables and popovers; `radius-xl` 12px for dialogs and the review bar; `radius-full` for pills, chips and dots.
- **Borders, not shadows.** Cards are flat with a hairline. `shadow-float` lifts only what floats: popovers, dialogs, toasts, the palette, the sticky review bar. `shadow-xs` is the segmented-control thumb.
- Controls: `control-sm` 30, `control-md` 36 (inputs 38), `control-lg` 44.

## Layout

- **Shell**: sidebar (`sidebar-width` 240px, collapsible to a 64px icon rail) + main column. The top bar (`topbar-height` 56px, sticky) holds breadcrumbs, the ⌘K trigger, the global run indicator (“2 running · 1 awaiting approval”), notifications, theme toggle and the operator menu.
- Page content is capped at `content-max` 1280px. Desktop (1440) is primary; at tablet width the sidebar collapses, toolbars wrap and wide tables scroll horizontally inside their own box.
- Detail screens: header (title, status pill, mono meta line, actions on the right) → tabs → content. A sticky review bar sits at the bottom of a run awaiting approval.
- z-order: `z-sticky` < `z-topbar` < `z-popover` < `z-overlay` < `z-toast`.

## Motion

Short and functional: 120–150ms ease-out for hover, popovers and dialogs (a 6–8px slide-in), 200–250ms for width changes like the preview device toggle. Running dots pulse at 1.4s; skeletons shimmer at 1.3s; spinners turn at 0.7s. Everything honours `prefers-reduced-motion`. Nothing bounces.

## Iconography

lucide, 24px grid, 2px stroke, round joins, `currentColor`. 16px in UI, 14px in chips and rows, 20px in empty states and error cards. Icons are paired with a label or carry an `aria-label`. The ones the app relies on: Folder (projects), Bot (agents), Sparkles (skills), Workflow, Activity (executions), Server (MCP), SlidersHorizontal (settings), GitBranch, GitMerge, ShieldCheck (approval gates), FlaskConical (tests), Terminal (logs), Globe (Preview URL), Lock (secrets). See the `Icon` component.

Logo: the hexagon mark in a violet `accent-solid` tile (assets › Logos).

## Patterns

- **Status everywhere**: any run, in any list, shows a `StatusPill`. Infrastructure shows a `StatusDot` with a label.
- **Every list has five states**: loading (`Skeleton` shaped like rows), empty (`EmptyState` with one primary action), filtered-empty (“Clear filters”), error (`EmptyState tone="error"` with the request in mono and Retry), and data.
- **Filters live in the URL**: filter chips (pill buttons; the selected one inverts to `text` on `bg`) and a mono URL chip showing `/executions?status=failed&project=acme-shop`.
- **Destructive = confirm**: `danger` outlined trigger → `Dialog destructive` → `destructive` confirm button. The body says what is kept (“The worktree and branch are kept”).
- **Approval dialog**: lists the files changed with +/− counts, the test result as a pill, and `agent/… → dev`.
- **Immutable snapshots**: anything that runs shows its snapshot (`claude-implementer@v3`, skills, MCP) in a mono block before it starts.
- **Secrets**: masked (`••••••••`), write-only, “Stored outside Git” helper text, redacted in logs as `••••••[redacted]`.
- **Workflows** are linear: a vertical pipeline of step cards on a dotted `bg-subtle` canvas; approval gates use `run-awaiting-soft` with a ShieldCheck icon.

## Accessibility

AA contrast in both themes (text 4.5:1, control borders and icons 3:1). Visible focus: 2px `accent` outline, 2px offset. Real `button`, `a`, `label` + `input`; icon-only buttons have `aria-label`. Tabs, switches and segmented controls expose `aria-selected` / `aria-checked` / `aria-pressed`. The log stream is `role="log"`. Run state never relies on colour alone: there is always a word.

## Using it in the Next.js app

1. Copy `code/globals.css` over `app/globals.css` (Tailwind v4 + shadcn/ui). It defines every token as a CSS variable for `:root` (light) and `.dark`, maps them onto shadcn's names (`--background`, `--primary`, `--ring`…) and exposes them to Tailwind via `@theme inline`, so `bg-surface`, `text-text-muted`, `bg-run-awaiting-soft`, `rounded-lg` all work. Because shadcn already uses `--accent` for hover, the brand tokens are renamed there: `accent` → `--brand` (`text-brand`), `accent-solid` → `--brand-solid`, `accent-soft` → `--brand-soft`, and `border` → `--border-hairline` behind shadcn's `--border`.
2. Make dark the default: `<html className="dark">` with `next-themes` (`defaultTheme="dark"`, `attribute="class"`).
3. Load fonts with `next/font/google` (`Inter`, `JetBrains_Mono`) into `--font-sans` / `--font-mono`.
4. shadcn components pick up the theme as-is. Match these: `Button` variants → default=primary, secondary, ghost, outline+destructive text for `danger`, `destructive`; `Badge`/pills → use the run-state classes from the `StatusPill` guidelines; `Dialog`, `Tabs`, `Switch`, `Command` (⌘K), `Sonner` (toasts, bottom-right).
5. The `components/` here are a reference implementation (`window.AgentStudio`, React 18) for previews and prototypes; in the app, build them on shadcn primitives with the same props and class recipes.

| Token | shadcn variable |
|---|---|
| `bg` | `--background` |
| `text` | `--foreground` |
| `surface` | `--card`, `--popover` |
| `surface-raised` | `--muted`, `--secondary` |
| `text-muted` | `--muted-foreground` |
| `hover` | `--accent` (shadcn's hover) |
| `accent-solid` / `on-accent` | `--primary` / `--primary-foreground` |
| `danger-solid` | `--destructive` |
| `border` / `border-strong` | `--border` / `--input` |
| `accent` | `--ring` |
| `bg-subtle` | `--sidebar` |
| `radius-md` | `--radius` (0.5rem) |
