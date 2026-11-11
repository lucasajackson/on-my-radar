# The phone suite

`packages/phone` drives the real app at a genuine iPhone viewport — 390x844, dpr
3, touch, an iOS user agent — in headless Chrome, and asserts on what the layout
actually does.

Every assertion in it is a defect the product owner saw on a real phone. They exist because
three of them had already been fixed once, and nothing would have caught them
coming back: the `verify` job runs `pnpm -r test`, and no unit test can tell you
that a button is underneath the keyboard.

## Running it

```bash
pnpm phone
```

That is the whole thing. It builds the workspace, drops and recreates its own
database, starts the real server, seeds a realistic account through the real API,
sweeps the phone viewport, and prints a verdict. It exits non-zero if anything
fails.

You need a Postgres it can reach and a Chrome it can drive.

| Variable                 | Default                                             | What it does                                            |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------- |
| `OMR_PHONE_DATABASE_URL` | `DATABASE_URL`, else `…@127.0.0.1:5432/on-my-radar` | Which **server** to use. The database name is replaced. |
| `OMR_PHONE_DB`           | `omr_phone`                                         | The scratch database, dropped and recreated each run.   |
| `OMR_CHROME`             | found automatically                                 | Path to a Chrome or Chromium executable.                |
| `OMR_PHONE_OUT`          | `packages/phone/.out`                               | Where screenshots and `report.json` are written.        |

**It always uses a scratch database of its own**, and refuses outright to touch
one named `on-my-radar`, `onmyradar`, `postgres` or `template1`. Two earlier runs
shared a database and silently corrupted each other's results, which is worse
than either of them failing.

If it cannot find a browser it says so and stops. It never downloads one — a
suite that quietly pulls 170MB the first time you run it looks like a suite that
has hung.

```bash
# If you have no Chrome for it to find:
pnpm dlx @puppeteer/browsers install chrome@stable
```

The port is picked free at runtime, so it does not collide with `pnpm dev` or
with another agent's session.

## In CI

The `phone:` job in `.gitlab-ci.yml` runs in the `verify` stage with `needs: []`,
so it starts alongside `verify` and the pipeline pays `max()` rather than the
sum. `build` waits on both.

The browser is Debian's `chromium`, installed into `mirror.gcr.io/library/node:22-bookworm`
— official upstream, pulled through the mirror, glibc rather than musl. Measured
clean-room, the whole job is about **65 seconds**: ~15s of apt, 4s install, 11s
build, ~34s for the suite itself. Beside a `verify` job that also typechecks,
lints, tests, migrates twice and audits, that is free in wall-clock terms.

If the apt ever stops being cheap, the answer is a node+chromium image baked into
Harbor — not trimming what the suite covers.

Screenshots and `report.json` are kept as artifacts whether the job passes or
fails. They are evidence to read when an assertion fails. **Nothing is ever
compared against a reference image.**

## What it covers

373 assertions on the current template set, and the number grows with the
templates because most of them run per radar. The number here is prose and
nothing asserts it, so read it as an order of magnitude rather than a
guarantee — `pnpm phone` prints the real one. All of them are geometry or
computed style — never pixels.

**The frame**

- The layout viewport is 390, not a 980px desktop layout scaled down to fit.
- The tab bar clears `env(safe-area-inset-bottom)` with room for Safari's chrome.
- No phone title bar stacked above the screen header — measured as "no full-width
  painted band above the screen's own heading", not by looking for a class name.
  It probed `.app-topbar` for a while, an element deleted on purpose, so it could
  only ever report `false` and pass; a bar coming back under any other name went
  unnoticed. It is asserted on every radar screen, where there is a heading to
  anchor on, and deliberately not on home, which has none.
- The desktop sidebar is not painted, and nothing fans out over the content. The
  scrim half of that is anchored on `.modal-scrim` and is paired with a positive
  assertion, with a real dialog open, that the same selector does find a scrim —
  a negative check whose positive twin is never made cannot tell a clean screen
  from a misspelt selector, which is what it had become.
- Nothing is painted past the right edge, on every screen and every template —
  ignoring anything inside an ancestor that scrolls **or clips** horizontally. A
  scroll container is allowed to hold content wider than itself, and something
  inside `overflow: hidden` is not painted past anything at all; the check is
  about what a person sees. The bearing strip is why the clipping half is there:
  its newest tick sits at `left: 100%` and lays out 1.5px past a strip that clips
  it away. The page-level version of the defect is still caught by the
  no-sideways-scroll check, which no ancestor can hide.
- No `h1`/`h2` box intersecting a control box. That is the exact shape of the
  Activity-header bug: a flex header that squeezed the heading instead of
  wrapping the buttons.

**Capture, with the keyboard up**

- The composer's submit **and** its field are inside the visual viewport with the
  keyboard raised. This is the one that reproduces the screenshot: iOS shrinks
  only the visual viewport, so a composer positioned against the layout viewport
  buries its own submit button and you cannot capture at all. When it fails it
  names the overshoot in pixels.

**Navigation**

- Radars is a link to a full screen, not an overlay trigger; the back gesture
  returns to the list; the tab bar never moves.
- Rows are full width and thumb sized.
- Sign out and the waitlist link survived the drawer being removed.
- **A radar and a topic can both be made from the radars screen**, and neither
  control is sliced at the edge. The rail is desktop-only, so this header is the
  only place either can be made on a phone — and topics shipped with no create
  control anywhere at all, which is what made a fully built feature invisible.

**Badges, checked against the API rather than the page**

- One badge per unread radar, and the unread total only on Activity.
- Each topic heading carries exactly the sum of the radars beneath it, and no
  topic with unread beneath it is missing its roll-up — grouping a radar must not
  hide the badge that was asking you to look at it.
- No badge painted anywhere else. Painted elements only: the desktop sidebar is
  `display: none` on a phone but is still in the DOM, carrying a second copy of
  every badge.

**Inside a dialog** (added 2026-08-27)

- **Every interactive element in an open dialog has a hit box of at least 44px in
  its smaller dimension.** A general gate, written against whatever dialog is
  open rather than a named one. The suite proved a dialog _fitted_ — scrim
  present, no sideways scroll, nothing past the right edge — and had never once
  asserted the size of anything you tap inside one; there was a single height
  assertion in the whole file and it covered nav rows. It failed on its first
  run: the modal close button measured 30px and every footer button 33px.
- Paired with a check that there was something in the dialog to measure, because
  the gate above is green on an empty one.
- The confirmation states its consequence in words and still asks for the radar's
  name. The type-the-name pattern was always right; only the container was wrong.

**The settings page** (added 2026-08-27)

- **The primary action is on screen without scrolling for it**, measured against
  the visible rectangle. It used to sit below 3.2 phone screens of scroll and
  nothing asserted you could reach it.
- **Nothing scrolls inside the page that already scrolls.** Measured as a
  property — elements that clip and have more content than height — not by
  probing a class name. Three nested scroll regions painting scrollbars at once
  was the mechanism behind the old dialog feeling like a mess.
- The template is one summary row at rest rather than a six-card grid.

**Desktop widths** (added 2026-08-27, `src/desktop.ts`)

The same browser and the same seed, resized to **1024×768, 1366×768, 1440×900
and 1920×1080** after the phone pass.

**1024 is in the list because it is the cruel one, not because it is anybody's
screen.** It is the exact pixel at which the sidebar appears, so the content pane
is narrower there than at 1023 with no sidebar at all — 712px against 912px.
Every width-sensitive decision in this app is at its worst at that one value and
nowhere else, which is how the discussion rail went unnoticed for a day:
defensible at 1366, 1440 and 1920, and leaving the prose 534px at 1024. Nothing gated a desktop viewport before, which
is exactly where the sidebar states and the kanban lane budget live — both had
been tuned from arithmetic in a CSS comment that turned out to be wrong.

It signs back in first: the phone pass deletes every cookie on purpose, for the
public-radar and invitation sections, so without that every desktop measurement
is taken against the sign-in screen. That is not hypothetical — it is what the
first run did, and it produced eleven confident failures with nothing to do with
layout.

- The sidebar is expanded and the phone tab bar is absent.
- **The chrome between a radar's header and its first blip is under 190px**,
  paired with checks that the capture box is still there and the filters are one
  row — so the budget cannot be met by deleting the thing it is protecting. It
  measured 258px before this landed and 162px after.
- The composer grows once there is something to capture, typed with real key
  events because a controlled input does not see a `value` assignment.
- The kanban board draws **five** lanes. Settled, not pending: `79c3f5d5`
  proposed a sixth and was closed without one.
- The lane widths are **recorded and not asserted**. Density is a judgement, and
  `report.json` carries the numbers for whoever makes it.
- **The board does not scroll sideways** at any of the four widths. That half of
  `23083131` was recorded and not asserted while the two consolidated reports
  pulled against each other; it is settled now, and a suite that should not take
  a side in a live argument should still hold a settled one.
- The settings page is a tab strip with one scroll region and a reachable Save.
- Every section on the topic page is spaced the same way, and the cascade switch
  is a normal-width control rather than a full-width call to action.
- **The thread spends its width on prose, not on chrome** — the reading column
  against the whole panel, at a floor of 0.78. Asserted on the reading column
  rather than on the rail because below 55rem of thread there is no rail: the
  chrome lays out on one line above the words and a rule about the rail's width
  has nothing to measure. The floor is 0.78 and not 0.75 because 534/712 is
  0.7500 exactly — the first version passed on the very defect it was written
  for, which is what reverting the fix and re-running it is for.
- **Crossing the sidebar breakpoint does not collapse the reading column**,
  measured at 1016 and 1032. Making the window wider must not make the prose
  narrower, and for one day it did: 912px of reading at 1023 and 534px at 1024.

**The phone idioms** (added 2026-08-27, `src/idiom.ts`)

Its own file, and it runs between the phone pass and the desktop pass. Separate
because `sweep.ts` ends by reading the public and invitation screens the way a
stranger reads them, which means deleting the session cookie; everything here
needs an account, so it signs back in the way `desktop.ts` does and stays at
390×844.

Gestures are driven through `Input.dispatchTouchEvent` over CDP rather than
`page.touchscreen.tap`, because what is being asserted is the **thresholds** — a
small push springs back, a large one commits, a vertical drag scrolls — and that
needs a finger held down and moved in steps.

_The board pager_

- One lane drawn, five chips offered, and the lane is more than 90% of the board
  with the card filling more than 85% of the lane. A lane that is a fifth of the
  board is a bar chart, and full width is the whole argument for a pager.
- **The next control actually pages** — not that a next control exists, that it
  moves you — and a chip is a direct jump rather than only a readout.
- **Board cards carry no swipe.** A row that pages horizontally and cards inside
  it that triage horizontally are two gestures competing for one axis, and no
  threshold resolves that. This is the check that keeps it that way when somebody
  later passes `swipe` from the board because the stream has it.

_The navigation stack_

- A tab root offers **no** back control. That is what keeps it a control rather
  than a title bar.
- Going into a radar sets `data-nav="push"`, the pane is genuinely animating —
  read from `getAnimations()` while it is still running — and a back control
  appears at 44px naming where it goes.
- Back pops, sets `data-nav="pop"`, and takes the control with the depth it
  described. Switching tabs is `switch`, neither of the two.
- **Reduced motion is asserted as absence**: no direction attribute at all and
  nothing running on the pane. Not a shorter duration — a 1ms animation is still
  an animation, and the setting exists for people for whom that is not a
  distinction.

_Swipe to triage_

- Every row is a swipe row and its surface computes `touch-action: pan-y`, which
  is what hands vertical panning back to the browser before the first move event
  exists.
- Nothing is painted behind a row nobody has touched.
- **Every gesture has a control**: the triage select is painted at rest, at 44px,
  inside its card and not clipped by the row's own overflow. A gesture is
  unreachable by keyboard, switch and screen reader, so the swipe is only allowed
  to exist where the same thing can be done without one.
- A push short of the threshold springs back and files nothing; a vertical drag
  scrolls the list and opens no row.
- The track names the action and lights up **before** release — you learn where
  the threshold is by crossing it, not by letting go and finding out.
- A full swipe triages the blip, says so, and the toast's undo puts it back. The
  toast clears the tab bar, because an undo underneath another control is not a
  control.
- The settle is measured **as a pair**: a real transition when motion is allowed,
  and `0s` with no settling class when it is refused. A negative assertion whose
  positive twin is never made cannot tell a working rule from a misspelt
  selector. This pair is what found the universal
  `transition-duration: 1ms !important` in `styles.css`, which had been silently
  outranking four specific `transition: none` rules since the day they were
  written.

**Every template**

- A phone screen for each, `log` and `discussion` included, with no chip sliced
  at the screen edge. The tag chips are checked inside `.filter-rail` and the
  absence of a separate `.chip-rail` band is asserted, since the tag row folded
  into the filter row on 2026-08-27. The chip check is
  anchored on `.filter-rail` and paired with a check that the rail is present at
  all, for the same reason the composer check below is: it spent a while pointed
  at `.chip-wrap`, which no component had rendered since the filter box folded
  the triage chips into the filter row, and it short-circuited on `null` — so it
  could not fail on any template, while this line said it was a guarantee.
- No `CMD + ENTER` hint in the **composer** on a touch device — scoped to the
  composer, anchored on `#composer` / `#quick-drop`, and paired with a check that
  the composer is present at all, so it cannot pass by there being nothing to
  check. An earlier document-wide version of this reported the composer as broken
  when what it had actually matched was empty-state prose.
- No **keyboard-shortcut prose** painted anywhere on a touch device. This is a
  separate check because it is a separate instance of the same defect: telling
  somebody to "hit cmd + enter" in body copy is the same bug as a hint, and it
  survived the first fix precisely because it reads as copy. The seed makes an
  empty radar deliberately, because the empty state is the only place that prose
  renders — without it the check could never fire.
- **A board draws exactly one lane**, never a rail, with the pager offering every
  lane and the board itself not scrolling sideways. On a desktop the lanes are
  budgeted and the ones that do not fit become rails; the two behaviours are one
  component, and a budget that leaked across the breakpoint would draw five 60px
  columns again. The card's action cluster is asserted to be inside its card at
  the same time — a phone lane is the narrowest one the app ever draws.
- Adding a template without giving it a phone screen is a **type error** before
  it is ever a test failure: the seed is a `Record<RadarTemplate, …>` keyed off
  the contract's own registry, so `pnpm -r typecheck` catches it. The suite
  asserts the same thing again at runtime.

**Universal search**

`/search` is a _screen_, not a template — so nothing here covers it by accident.
The self-maintaining half of this suite is `Record<RadarTemplate, …>` in the
seed, which is about templates and says nothing about routes: a new route can be
added and nothing will tell you it is uncovered. This block is deliberate, and a
future screen needs the same deliberate act.

- The entry point is a **link** on the Radars screen, not a button that opens
  something over the page — the same assertion the Radars tab carries, for the
  same reason. It lives there because the tab bar's five slots are all
  load-bearing and a sixth would shrink the rest for the thing reached for least.
- The box is present, and asserted present _before_ anything is asserted about
  what is on the screen — every other check here would pass perfectly on a screen
  that failed to render one.
- The grammar is shown while the box is empty. A filter grammar nobody can see is
  a grammar nobody uses.
- The seeded needle is found, the right number of times. The seed **places** that
  needle rather than borrowing a word out of the fixture prose, and throws if the
  count is wrong: an assertion against a word somebody may rewrite for unrelated
  reasons is an assertion that quietly stops meaning anything.
- **An unmatched filter returns zero where the words alone return two.** This is
  the one worth the most, and it is a product property rather than a layout one:
  a search that dropped a filter it could not resolve would return the whole
  corpus here and look entirely healthy. The screen must also name the filter
  that did it.
- Typing `in:` offers radars, and completing a name **with a space in it** comes
  back quoted — an unquoted value stops at the first space and half the name
  becomes a stray word. The first run of this check failed on ordering (`in:On`
  matched "Decisi-ON-s" ahead of "On My Radar"), which was a real defect in the
  completion ranking as well as an over-strict assertion.
- The box stays inside the visual viewport with the keyboard up. Same defect
  class as the composer, and it names the overshoot in pixels when it fails.

**The invitation screen, signed out**

`/invite/$token` is the one screen somebody can reach with **no account at all**,
which makes it the one screen where a broken phone layout costs a user rather
than annoying one. The sweep deletes its cookies before this part, because a
logged-in page redirects straight past it.

- The radar being handed over is named, the inviter is named, and the role is
  stated in words. The inviter check is deliberately case-insensitive:
  `.instrument` uppercases, and a case-sensitive version failed against a screen
  that was entirely correct.
- **An admin's invitation and an ordinary user's do not read the same.** One says
  you go straight in, the other says the account joins a waitlist, and a third
  assertion says those two strings must differ. That difference is the whole
  security boundary of the feature (DESIGN §19) and the only place a person ever
  sees it is here.
- The invited address is pre-filled, and the generic "New here?" line is replaced
  by something that makes sense to somebody who was invited.
- A dead link says the invitation is no longer open, names **no** radar, and
  still leaves a working sign-in form. The server answers every stale case
  identically — revoked, expired, accepted, deleted — so the screen behind it must
  not become a dead end.

The invited addresses are on `@outside.test` rather than `@example.test`, because
`AUTO_APPROVE_EMAILS=@example.test` would exempt them from the waitlist entirely
and the queue assertion would pass without the queue existing.

**The appearance picker**

Asserted as a _design_ rather than as a feature. Twenty-six accents and
forty-eight glyphs drawn flat is about eleven rows on this screen, which is the
clutter the picker exists to avoid — so what is checked is that the control is
one row at rest, that nothing is expanded until it is asked for, that exactly one
panel opens at a time, and that the open panel is bounded so Save stays
reachable. If a later change reverts to a flat list, the swatch count at rest
goes from zero to seventy-four and three of these fail.

**A published radar, signed out**

Two of them, on the same layout: one carrying the loudest theme in the vocabulary
and one carrying none. The pair is the point — "the theme is applied" only means
something beside a page where it demonstrably was not.

- A published microblog is drawn as a **timeline**, not as the ordinary stream.
  That was a real bug: the server was already ordering the blips by the
  template and the SPA threw the template away on arrival.
- A stranger is offered no way to write — no composer, no reply box, anywhere.
- The paper covers the screen, so a short radar does not end in a band of the
  application's own near-black under the footer.
- **The byline stays above 3:1 against its own ground**, measured through the
  real cascade. This is the load-bearing one. `theme.test.ts` holds every surface
  to a contrast floor in the abstract; this holds the rendered page to one. The
  claim that no theme can hide an author is what allows the whole page to be
  themed rather than only the posts (DESIGN §22), and below this floor the claim
  would be false.

## What it deliberately does not cover

**It verifies layout at a phone viewport. It is not a real device.** Headless
Chrome pretending to be an iPhone is a good approximation of the layout and no
approximation at all of the browser.

Specifically unverifiable here, and therefore still the product owner's job to check on the
actual phone:

- **The real iOS keyboard.** The suite shadows `visualViewport.height` and
  `offsetTop` with the values iOS would report and fires the resize event. That
  is the signal a correct layout must consult, so the assertion is real — but the
  occlusion is drawn, not felt. Nothing is actually covering anything.
- **The form accessory bar**, which iOS floats over the bottom of the visual
  viewport while you type. It is the reason the quick drop's submit lives in the
  header, and it does not exist in Chrome.
- **Real `env()` safe-area insets.** The suite asserts the tab bar reserves room
  for them; it cannot assert the reserved room is the right amount on a device
  with a home indicator.
- **Momentum scrolling, rubber-banding and scroll anchoring**, which are WebKit
  behaviours with no Chrome equivalent.
- **Font rendering and text metrics.** Deliberately never asserted. A suite that
  fails because a font rendered half a pixel differently gets disabled within a
  week, and is worse than nothing.
- **Anything about how it feels.** Tap latency, and whether iOS's own
  edge-swipe-to-go-back fights a row that swipes to triage. The suite proves the
  row's own thresholds and that `touch-action: pan-y` is declared; it cannot
  prove what WebKit does with a gesture that starts within 20px of the screen
  edge, which is the one place the two could collide.

This is why anything about _feel_ still wants a check on the real handset, even
with the suite green. What the suite buys is that the specific things already
found and fixed cannot come back silently — and, since the idiom sweep, that the
gestures and transitions are driven rather than described. What it still cannot
tell you is whether a swipe that starts at the very edge of the screen fights
iOS's own back gesture, or whether 260ms is the right length for a push.

## Notes for whoever changes it

- `packages/phone` has **no `test` script**, on purpose. `pnpm -r test` runs in
  the `verify` job, which has no browser. The suite gets its own job instead.
- `tsx` transpiles through esbuild with `keepNames`, which rewrites named inner
  functions to `__name(fn, "…")`. Puppeteer serialises an `evaluate` callback and
  runs it in the **browser**, where that helper does not exist, so any callback
  containing a named inner function dies on `ReferenceError: __name is not
defined`. `harness.ts` installs an identity `__name` as a raw string — written
  as a function it would itself be transpiled and would need the helper it is
  defining.
- The app is served the way it ships: one process, the built SPA through
  `UI_DIST_DIR`. Not a Vite dev server behind a proxy. That is both more honest
  and one fewer thing to race against.
- The server's environment is built from nothing rather than inherited. An
  ambient `RESEND_API_KEY` would stop `devCode` being returned and the seed could
  not sign in — a failure that would look like an auth bug.
- **Wait on the frame, not on a clock.** A fixed delay was intermittently losing
  `.tab-capture` and the `/api/radars` fetch on a loaded machine. Under CI load
  that is the shape of flake that gets a suite switched off rather than fixed.
