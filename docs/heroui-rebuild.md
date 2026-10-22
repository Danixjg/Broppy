# HeroUI rebuild of the Broppy web UI

Branch: `feat/heroui-ui` (from `main` after WP-C #79 and WP-D #81 landed).
Status: foundation in progress.

## Why

The workspace UI is two systems fighting: a React 19 + Tailwind v4 + shadcn shell (`apps/web/src/shell.tsx`) and a
1863-line imperative controller (`apps/web/app.js`) that rebuilds DOM by hand into static markup. The imperative half
owns the behaviour, so identity changes, focus, and the write path all leak races (the invisible-drawer bug and the
polling focus loop in WP-D were both symptoms). HeroUI v3 is installed and the user wants the workspace rebuilt on it
with the theme from the HeroUI theme builder: template `finances`, hue `149.32371632910446`, base `0.0074`, Inter,
medium radius, large form radius.

## The theme

The builder's knobs are reproducible, so the theme is generated, not hand-copied:

- `tools/heroui-theme.mjs` reads `node_modules/@heroui/styles/dist/themes/default/variables.css`, applies the builder's
  rule (neutrals take the base chroma at the theme hue, the accent takes the builder's accent color, status hues and
  radius stay), and writes `apps/web/src/theme/heroui-theme.css`.
- `pnpm theme:heroui` regenerates it. The knobs live in one place in the script, with the builder link next to them.
- The accent is `oklch(0.6204 0.195 149.32371632910446)`; neutrals are `oklch(L 0.0074 149.32371632910446)`.

## The shape of the rebuild

React owns the page. The legacy controller is removed surface by surface, never left half-migrated:

1. **Foundation** (this branch): dependencies in `apps/web`, the generated theme, HeroUI styles imported once,
   a theme proof page.
2. **Shell**: topbar, project switch, search, identity picker, and the view nav in React with HeroUI components.
   The ids the journeys and Slack deep links rely on (`#search`, `#user`, `#projectSelect`, `[data-view=...]`) stay.
3. **Tasks view**: filters, list, board, drawer, personal widget, and the WP-C write path (edit, transitions,
   receipts) as React components on HeroUI.
4. **Workspace view**: activity panel, document panel, conclusions, chat, audit panel.
5. **Admin, compliance, operations views.**
6. **Connectors, people and setup pages** (`connectors.html`, `people.html`, `setup.html`).
7. **Next app pages**: landing, sign-in, sign-up, invited, support, privacy, legal.
8. **Cleanup**: `apps/web/app.js`, `connectors.js`, `people.js`, `setup.js` and the hand-written CSS go away; the
   pure helpers move to `apps/web/src/lib` as `.js` so `node --test` still covers them.

Rules that hold for every unit:

- The API does not change. The browser journeys in `tools/check-workspace.mjs` are the contract and must stay green.
- Pure logic stays pure and testable. Helpers stay `.js` so the paired `*.nodecheck.js` files keep running under
  `node --test`; the root test glob widens to `apps/web/**/*.nodecheck.js`.
- No narrator comments. The assertion or the prop name carries the meaning.
- Each unit ends green: `pnpm test`, `pnpm typecheck`, `pnpm --filter @brain/web build:workspace`, and the browser
  check.
