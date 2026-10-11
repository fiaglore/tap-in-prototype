<p align="center">
  <img src="logo/tap-in-app-icon.svg" width="120" alt="Tap In logo">
</p>

# Tap In — prototype

**No bands. No paper. Just tap in.**

Tap In replaces attendance wristbands, paper tickets and access cards with the phone people already carry. One app covers festival gates, office doors, venue guest lists and campus halls. A pass stays asleep until you arrive, then you tap your phone on a reader and you're in.

This repo holds the clickable first-run prototype and the logo files. It's a design prototype: taps, pass lookups and passes are simulated with example data.

**Live prototype:** https://fiaglore.github.io/tap-in-prototype/ (once GitHub Pages is on, see below)

## The first-run flow

What a brand-new user sees, in order:

| # | Screen | What happens |
|---|--------|--------------|
| 01 | Launch | The animated TAP IN logo: the dot of the i presses, ripples go out, IN lights up. Plays twice, then moves on. Tap to skip. |
| 02 | Welcome | "No bands. No paper. Just tap in." Get started, or jump straight in with an invite code. |
| 03 | Where will you tap in? | Events & festivals, Workplace, Venues & clubs, Campus & residences. Pick any. |
| 04 | Find your passes | Look up passes sent to your phone number, email or invite code. Workplace and campus passes show as Pending until approved. |
| 05 | Lock passes to you | Tap to enter (required), face or fingerprint, and optional arrival awareness. Screenshots can't get anyone in. |
| 06 | Try one tap | A practice reader so the first real tap isn't in a queue. |
| 07 | Around me (Home) | You at the centre, passes orbiting by how soon you'll use them, and a countdown to your next event. |

The side panel beside the phone explains each screen: what the user sees, why it's built that way, and how the ambient ripple layer behaves.

## Dark and light mode

The app follows the phone's own dark or light setting. A sun/moon switch in the status bar of every screen overrides it, and the prototype remembers the choice in that browser. A link under the notes panel switches back to following the phone.

Light mode keeps the same plum family: a pale lilac-white ground, plum text and buttons, and a light launch screen with a plum TAP and lilac IN that flashes plum.

## Logo

All files are in [`logo/`](logo/) as SVG.

| File | Use |
|------|-----|
| `tap-in-app-icon.svg` | App icon: rounded plum tile |
| `tap-in-animated.svg` | Animated logo (2.4 s loop) for splash screens and readers |
| `tap-in-mark-on-plum.svg` | Square mark on plum, for social profile pictures |
| `tap-in-mark-one-colour.svg` | All-plum mark on white, for print and stamps |
| `tap-in-mark-reverse.svg` | Plum and white on lilac |
| `tap-in-wordmark.svg` | Horizontal TAP IN for headers and signage |

The letters are traced from the original Tap In wordmark image, so they're close but not pixel-exact to the source artwork.

## Colours

| Name | Hex | Used for |
|------|-----|----------|
| Plum | `#6C4A6C` | Logo tile, launch screen |
| Lilac | `#B5A0CC` | "IN", buttons, highlights, ripples |
| White | `#FFFFFF` | "TAP", text |
| Deep plum | `#2B1B2D` | App background (dark mode) |
| Mist | `#F7F2F8` | App background (light mode) |
| Deep lilac | `#80619A` / `#8C6FAB` | Primary button (dark mode) / IN in light mode |
| Success | `#7FE0B4` | Access granted |
| Pending | `#F2C96B` | Passes waiting for approval |

Type: Syne (headings), Manrope (body), JetBrains Mono (labels and IDs), all from Google Fonts.

## View it locally

It's a single static page with no build step. Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Turn on GitHub Pages

1. In the repo, go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*.
3. Choose branch **main** and folder **/ (root)**, then **Save**.

After a minute or two the prototype is live at `https://fiaglore.github.io/tap-in-prototype/`.

## Licence

Copyright © 2026 Tap In. All rights reserved. You can view this repository and the live prototype, but the code, name, logo and designs may not be copied, reused or adapted without written permission. See [LICENSE](LICENSE).
