# verification

Browser verification for applied design decisions. Assertions are the pass criteria; screenshots are evidence, not proof.

Use the commands, ports, accounts, and viewports discovered in Step 2. Do not assume a framework, router, or styling system.

## 1. Preconditions

- The app can start with the discovered install/dev commands.
- The backend or API proxy is reachable; if the scope needs data, the seed/test data exists.
- Test accounts for each role being verified are available. Get them from the project's documented env var names or ask the user. Never hardcode, print, or store credentials in reports, screenshots, logs, or console output.
- Playwright MCP is available. If it is not, or the browser cannot launch, stop and ask; `--no-verify` is a user decision recorded as `skipped`.
- The screenshot directory is gitignored. Check `git check-ignore -q .design/verify`; if it fails, ask before editing `.gitignore`.

## 2. Start the app

- Use the discovered dev command (for example `npm run dev`, `pnpm dev`, `python manage.py runserver`, `uvicorn ...`) in the background.
- Confirm the URL, port, and protocol with a request before opening the browser.
- Do not kill the user's browser or unrelated processes. If a browser is already running, use the MCP-managed browser; if launch fails, report and skip rather than force-closing.
- Note whether the app needs HTTPS, a proxy, or a specific host header.

## 3. Sign in and navigate

- Log in through the real UI; do not inject a token unless the project documents that as a test path.
- Discover the token/session storage key from the code; don't assume one.
- If the app has a URL router, deep links are fine; if views are state-based, click through the UI from the entry point.
- Reach each screen the way a user would: nav items, cards, menus, dialogs.
- Use `browser_snapshot` and accessible role/name selectors; avoid brittle nth-child CSS.
- Theme: use the real toggle when verifying theme behavior. If it is unreachable, set the documented persistence key and reload for screenshots, but don't claim the toggle was verified.

## 4. Assertions

Prefer computed styles and DOM measurements over pixel comparison. Read the expected values from `DESIGN.md` (and the scope's page file), not from memory.

Typical checks:

- **Color/theme:** computed `backgroundColor`, `color`, `borderColor`; compare with the token values after hex→rgb conversion. Check contrast for body text (≥ 4.5:1).
- **Typography:** computed `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`.
- **Density:** `getBoundingClientRect()` height/width for controls, rows, and spacing.
- **Shape/elevation:** `borderRadius`, `boxShadow`.
- **Navigation:** drawer/sidebar width, collapsed width, mobile overlay behavior, active item.
- **Icons:** rendered width/height and alignment.
- **Motion:** `transitionDuration`/`transitionTimingFunction`; hover/focus state via `browser_hover` or focus.
- **Layout:** bounding boxes and ratios for split panes; order of sections; no overflow at tested widths.
- **Content/states:** labels, empty/loading/error copy, dialog actions, snackbar text.

Helper pattern (adapt selectors to the detected stack):

```js
() => {
  const cs = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : null;
  };
  return {
    bodyBg: cs('body', 'backgroundColor'),
    bodyText: cs('body', 'color'),
    primaryBg: cs('[data-primary-button]', 'backgroundColor'),
    font: cs('body', 'fontFamily'),
  };
}
```

Use stable project attributes, roles, or text when available; use generated class names (CSS-in-JS, MUI, Tailwind output) only as a last resort.

## 5. Decision → assertion

Build the matrix from the current scope's decisions. For each decision, record at least one assertion:

| Decision | What to measure | Expected |
|---|---|---|
| color/theme | body/primary/surface computed colors | tokens from `DESIGN.md` |
| typography | family/size/weight/line-height | design values |
| density | control/row dimensions | design values |
| shape | radius/shadow | design values |
| navigation | width/collapse/mobile behavior | design values |
| icons | rendered size | design values |
| motion | duration/hover transform | design values |
| layout | bounding boxes/ratios/order | design description |
| content | visible copy/labels | design description |
| states | loading/empty/error/dialog/snackbar | design description |

Only assert the decisions in the current scope. For multi-scope runs, repeat per scope. A decision without an assertion is not verified.

## 6. Screenshot protocol

- Default viewports: a desktop width from the project's supported range (e.g. 1440×900) and a mobile width (e.g. 390×844). Use the project's documented breakpoints when they differ.
- Wait for `document.fonts.ready` and a stable DOM before capturing.
- Run motion assertions before disabling animation. Then disable animation only for the capture:

```js
() => {
  const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
  document.head.appendChild(s);
}
```

- Mask dynamic or personal data (emails, names, IDs, timestamps, avatars) with a placeholder before the capture. Never screenshot production data. Keep labels needed for assertions intact.
- Name files `<view>-<theme>-<width>x<height>.png`; write `manifest.json` with base commit, date, URL, scope, decisions, viewport, theme, assertion results, and screenshot names.
- Target directory: `.design/verify/<YYYYMMDD-HHmm>-<scope>/`. Pass a relative filename to `browser_take_screenshot`; if the MCP writes into its own output directory, move the files with Bash afterwards.
- Screenshots are never committed.

## 7. Pass / fail

Pass when:

- every decision in scope has at least one passing assertion;
- no new console errors;
- no visible clipping, overlap, or horizontal scroll at the tested viewports;
- required screenshots exist and show the asserted state.

Fail when any of the above fails, or a screen cannot be reached. Report the failing assertion and evidence; don't downgrade to "looks fine".

Skipped only with `--no-verify` or an explicit user decision after an environment problem. Record `skipped`; never record `pass` without assertions.

## 8. Cleanup

- Stop the dev server started for verification.
- Leave the user's own browser and servers alone.
- Keep `.design/verify/` artifacts for the report; they are gitignored.
