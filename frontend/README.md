# GHAT ISHARA frontend

A cinematic, responsive landing page for the GHAT ISHARA landslide susceptibility hackathon project. Built with React, TypeScript, Vite, Tailwind CSS, React Router, Motion and Lucide React.

## Start locally

Use Node.js 22.12+ and npm (the Supabase SDK requires Node 22+). From the repository root:

```bash
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite, normally **http://127.0.0.1:5173**. All fonts and the background photograph are served locally.

## Check and build

```bash
npm run typecheck
npm run build
npm run preview
```

`build` also runs TypeScript checks, then writes the production site to `dist/`. Preview normally runs at **http://127.0.0.1:4173**.

## Routes

The invitation-only official portal is documented in [OFFICIAL_PORTAL.md](./OFFICIAL_PORTAL.md), including configuration, migrations, first-admin bootstrap, security boundaries and the test plan. It remains visibly unconfigured until you supply a Supabase project; there is no demo authentication or public registration.

| Route | First milestone |
| --- | --- |
| `/` | Full-screen hero, navigation and calls to action; no sections below it |
| `/map` | Map Explorer placeholder |
| `/districts` | Districts placeholder |
| `/methodology` | Methodology placeholder |
| `/about` | Project introduction and photo credits |
| `/official/login` | Invitation-only password login |
| `/official/accept-invite` | Invitation verification and password setup |
| `/official/dashboard` | Protected district-scoped records |
| `/official/admin` | Protected system-administrator invitation, account and audit interface |
| Other paths | Friendly 404 with a home link |

Explore the Map and Get Started navigate to `/map` through React Router. Learn More navigates to `/about`. Route changes update the document title and move focus to the new main content. The mobile navigation supports Escape and restores focus to its toggle. Animations respect the operating system’s reduced-motion preference. At short heights or enlarged text, the hero can grow vertically so content remains readable and reachable.

These pages do not yet connect to the ML pipeline, serve predictions or load geospatial layers. No files outside `frontend/` were changed.

## Browser checks

With `npm run dev` running and Chromium installed:

```bash
npm run verify:browser
```

The script checks routes, direct reload, client-side CTA navigation, keyboard menu behavior, seven viewport sizes, reduced motion, asset errors and automated axe WCAG AA rules. Screenshots are saved to the ignored `qa-results/` directory. Automated checks do not replace a full manual accessibility audit.

Set `CHROMIUM_PATH` if Chromium is elsewhere. Set `QA_BASE_URL=http://127.0.0.1:4173` to test the production preview instead.

## Assets and hosting

See [ASSETS.md](./ASSETS.md) for the background photo source, license and font credits. The supplied design reference was used only as visual guidance.

For future static hosting, serve `dist/` and configure unknown application paths to return `index.html` so direct links such as `/map` work. No deployment, commit or push is part of this milestone.
