# Packaging

How Regatta becomes a macOS app, what comes out, and how to open it.

## Build

```
npm run dist
```

That runs `electron-vite build` (which bundles the renderer, preload and main, and every
`devDependency` they use, into `out/`) and then `electron-builder --mac --arm64 --publish never`.
The config lives in `electron-builder.yml`. `--publish never` means electron-builder never uploads
anything; there is no update feed and no account to upload to.

You need `node_modules` installed first (`npm install`), which also downloads the Electron binary.

## What comes out

Everything lands in `dist/` (gitignored):

- `dist/mac-arm64/Regatta.app`: the app bundle for Apple silicon.
- `dist/Regatta-0.1.0-arm64.dmg`: the disk image to hand to someone. It has the app and an
  Applications link.
- `dist/Regatta-0.1.0-arm64.zip`: the same app zipped, for drag and drop or an updater.

The app is the same code that `npm run start` runs. The only packaging differences are:

- The native terminal library (`@lydell/node-pty`) and its `pty.node` binary are unpacked from the
  asar so macOS can load them (`asarUnpack` in `electron-builder.yml`). `npmRebuild` is off because
  the package ships prebuilt N-API binaries.
- `resources/video` is copied to `Regatta.app/Contents/Resources/video` (`extraResources`). The main
  process reads `process.resourcesPath/video` when packaged, and `resources/video` when in
  development (see `src/main/index.ts`).

## Signing and Gatekeeper

The app is **ad-hoc signed** (`codesign` with the `-` identity), not signed with an Apple Developer
ID, and **not notarized**. The project has no paid Apple developer account, so it cannot sign with a
real identity or submit to Apple for notarization. Ad-hoc signing is the minimum that lets an arm64
binary launch on this Mac.

What that means in practice:

- An app you just built on your own Mac opens normally: `open dist/mac-arm64/Regatta.app`, or run
  the packaged e2e check below.
- A copy someone **downloaded** carries the quarantine flag, so Gatekeeper blocks a plain double
  click. To open it the first time: right click the app and choose Open, then click Open in the
  dialog. If that is not enough, go to System Settings > Privacy & Security and click Open Anyway.
- If macOS says the app "is damaged and can't be opened", that is the quarantine flag plus the
  missing notarization. Clear the flag and it opens:

  ```
  xattr -dr com.apple.quarantine /Applications/Regatta.app
  ```

To confirm the bundle is ad-hoc signed:

```
codesign -dv dist/mac-arm64/Regatta.app
```

You should see `Signature=adhoc` and no TeamIdentifier.

## The icon

`build/icon.png` (1024 by 1024, transparent outside the rounded square) is the source electron-builder
turns into the `.icns`. It is drawn from the app `Logo` in `src/renderer/src/components/marks.tsx`
(same gradient, sails and wave) on the macOS icon grid. To regenerate it:

```
node scripts/icon/render.mjs
```

That renders `scripts/icon/icon-page.html` in Electron (already installed, so no extra browser
download) and screenshots it to `build/icon.png`.

## The packaged check

`scripts/e2e/packaged.test.mjs` launches the built bundle and checks it works. It only runs when
`REGATTA_PACKAGED_APP` points at the app, so the normal `npm run e2e` suite is unchanged. Run it
after `npm run dist`:

```
REGATTA_PACKAGED_APP=dist/mac-arm64/Regatta.app env -u ELECTRON_RUN_AS_NODE node scripts/e2e/run.mjs packaged
```

It checks: the window opens on the home screen, `app:info` reports version 0.1.0, the main process
finds `process.resourcesPath/video/regatta-video.js`, a Terminal pane starts and prints output
(proving node-pty loads from the unpacked binary), and Settings > About opens.
