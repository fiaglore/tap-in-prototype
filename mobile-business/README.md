# Tap In for Business: Android app

A thin native shell (Capacitor 8) around the Tap In for Business web app, a sibling of the consumer app in [`../mobile/`](../mobile/).
It installs next to the consumer app: its own app id (`world.tapin.business`), name ("Tap In Business") and App Links.

The shell opens `https://business.tap-in.world/offices/?source=bizapp` full screen, so the app is always the same code as the
website and updates the moment the Worker is deployed. The `source=bizapp` marker makes `js/native.js` add `is-biz` to the page,
and `js/appnav.js` then shows the Business tabs instead of the event tabs.

| Tab | Page | What is in it |
|---|---|---|
| Office | `/offices/` | Sign in, your offices, people and access groups, departments, visitors, who is on site, incidents, team access, entry log |
| Scan | `/gate/` | The gate scanner for staff and visitor passes (camera permission is in the manifest) |

Tapping the Tap In logo goes to Office. Sign-in is the console's own (phone or email); the session is host-only to
`business.tap-in.world`, so people sign in once in this app.

## Build it
Node 22, JDK 21 and the Android SDK (or Android Studio).

```bash
cd mobile-business
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug     # android/app/build/outputs/apk/debug/app-debug.apk
```

`.github/workflows/mobile-business.yml` builds the debug APK on every change under `mobile-business/`; download it from the run's Artifacts.

## Before the first Play Store release
1. Decide the app id (`world.tapin.business`): it cannot change after publishing.
2. Create an upload key and turn on Play App Signing.
3. Serve `deeplinks/assetlinks.json.template` (filled in with the Play signing key's SHA-256) at `/.well-known/assetlinks.json` on
   `business.tap-in.world`. Until then links open in the browser; the app still works. Note: the consumer app's file must list both packages if both are served from one host (they are on different hosts, so each host serves its own).
4. Store listing: privacy policy (`/privacy/`), screenshots, data-safety form.
5. **Icon.** It reuses the Tap In icon from `assets/`. Replace `assets/icon-*.png` with a Business variant and run `npm run assets` if you want the two apps told apart on the home screen.
