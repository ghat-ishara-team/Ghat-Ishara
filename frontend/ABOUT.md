# About page

The public `/about` route replaces the former placeholder. `src/about/AboutPage.tsx` renders the page; `src/about/about.css` scopes its layout and colors. `src/App.tsx` uses an explicit route and removes the now-unused placeholder component. Navigation, route titles, focus handling, fonts, buttons, mobile menu and reduced-motion behavior reuse the existing site system.

## Sections and content

- Introduction and motivation: make landscape susceptibility information and its limitations understandable.
- Study area: four district-profile links from the shared `districtCatalog`, with landscape labels from the existing district content module. No duplicated district identifiers or raster statistics.
- Implemented capabilities: public MapLibre overlays, original Float32 inspection, district profiles, evidence-backed methodology, local map preferences, scoped official draft autosave and invitation-only protected access.
- Scientific responsibility: static, experimental, uncalibrated susceptibility; not event probabilities or real-time warnings. NoData, transparency and low scores do not establish safety. Rainfall/source provenance, independent validation and effective predictive resolution remain limited.
- Proposed future priorities: better provenance, independent validation and uncertainty communication. These are explicitly proposals, not released capabilities or a confirmed delivery roadmap.
- Official access: invitation-only, role/district scoped, with no public self-registration; the platform is not an operational government warning system. The existing login is linked without changing authentication.
- Public navigation: links to `/explore-map`, `/districts`, `/methodology` and each existing district profile.

The existing local `public/images/tamhini-valley.webp` is reused in a figure with descriptive alt text, scenic-context wording and photographer/license attribution. Credit and usage evidence remain in `ASSETS.md`. No new image, dependency, tracking, contact service or external data request is added. Attribution links open only on explicit user action and identify new-tab behavior to assistive technology.

The Project team section has been removed completely, with no replacement placeholder. The official-access card spans the content width so there is no empty grid column.

## Content confirmation

Confirm whether the proposed future research priorities reflect the team's intended scope before presenting them as commitments or adding dates. They are currently qualified proposals based on the unresolved scientific issues documented in `METHODOLOGY_RESEARCH.md` and the public Methodology page. No operational alerts, live monitoring or government deployment are promised.

## Verification

From `frontend/`:

```sh
npm run build
npm run test:about
npm run test:districts
npm run test:methodology
npm run test:map
npm run test:map-browser
npm run test:scores
npm run test:scores-browser
npm run test:persistence
npm run test:persistence-browser
```

The About suite builds an auth-disabled production preview and launches system Chromium (`CHROMIUM_PATH` may override `/usr/bin/chromium`). It checks direct route/reload, title and active navigation, scientific wording, proposed versus implemented content, absence of the team section and full-width official-access layout, official-access limits, licensed imagery, every main public CTA and district link, keyboard/menu behavior, reduced motion, storage denial, preference persistence and unknown child routes. Automated WCAG AA checks cover desktop/mobile, with overflow checks at 320, 390, 768, 1024 and 1440 px. Map navigation uses the existing offline basemap fixture. Screenshots and preview output go to ignored `qa-results/`.

Existing `verify:browser` and `test:portal-browser` require a running local server. To avoid using a configured developer environment, serve the suite's isolated auth-disabled build with `npm run preview -- --outDir qa-results/about-dist --port 18348` and set `QA_BASE_URL=http://127.0.0.1:18348` for those commands. Configured-session regression tests in `test:persistence-browser` mock Supabase transport; no live Auth/email/database mutations are needed.

Manual checks remain useful for screen-reader reading order, keyboard focus visibility, physical-device touch and photo cropping, and deployed SPA deep-link fallback. Live invitation delivery and official sessions require their own configured integration environment. Automated accessibility checks do not replace those reviews.
