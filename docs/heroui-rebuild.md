# HeroUI rebuild of the Broppy web UI

Branch: `feat/heroui-ui` (from `main` after WP-C #79 and WP-D #81 landed).
Status: foundation and shell in place; the Tasks, workspace, admin, compliance and operations views now run
on React and HeroUI, with the legacy controller out of those surfaces. The connectors, people and setup
pages are next.

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

## Where the rebuild stands

Done and green: the theme and its generator, the shell, the Tasks view, the workspace view, and the admin, compliance
and sync-health views. `apps/web/app.js` is down to 104 lines and holds only auth, the identity, the view switching and
the seams.

Still to do, in order:

1. The connectors, people and setup pages.
2. Browser journeys for the admin, compliance and sync-health views. The contract proves the shell, the workspace view
   and the Tasks view today; these three are not asserted yet, and the repo's rule is that a change to permissions
   covers the allowed and the denied case.
3. The Next app pages: landing, sign-in, sign-up, invited, support, privacy and legal. HeroUI's stylesheet needs
   Tailwind v4's PostCSS plugin inside Next, so that is the first task of the unit.
4. The cleanup, which is where the last of the old paint goes: delete the legacy stylesheet and the leftover legacy
   modules (`answer.js`, `permissions.js`, `links.js`), move what the React surfaces still import from the web app root
   into `src/lib`, and take the last 104 lines of `app.js` (auth, identity, view switching) into React so the legacy
   controller can go entirely.

The ported surfaces keep their legacy contract classes on purpose, so the browser journeys keep passing while the
legacy stylesheet still exists. When the stylesheet goes, those classes become plain names and the journeys must keep
reading them.
