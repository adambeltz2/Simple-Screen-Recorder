# CLAUDE.md

Simple Screen Recorder: a gifcap-style tool that records the screen (or opens a video/GIF/WebP), edits it frame by frame, and exports GIF or animated WebP. Static site, no build step, hosted on GitHub Pages at https://adambeltz2.github.io/Simple-Screen-Recorder/.

The owner (Adam) wants hobby apps **phone-first, self-contained and offline**. Keep it that way.

## Ground rules

- **No build step, no bundler, no npm runtime dependencies.** Plain ES modules served as-is. Third-party code is vendored under `lib/`.
- **All paths are relative** (no leading `/`). The site lives under a project subpath on Pages.
- Everything runs client-side. Never add a server call, analytics, or CDN script.
- Publishing straight to `main` is fine (single contributor).
- When you add, rename or delete a file the app loads, update the `ASSETS` list in `sw.js` or offline mode breaks. Stale-while-revalidate means users get a new deploy on their next visit after the one that fetched it; bump `CACHE` in `sw.js` only if you need to force-evict.

## Layout

| Path | Role |
|---|---|
| `index.html`, `style.css` | Page and styles (amber accent; all colours are CSS variables at the top of the stylesheet, with a dark default, `:root[data-theme=light]`, and a `prefers-color-scheme: light` block for auto; `pointer: coarse` block makes touch targets bigger) |
| `js/main.js` | Entry point only: imports every module, keyboard shortcuts, service worker registration, share-target intake |
| `js/ui.js` | `$`, `$$`, `clamp`, formatters, `toast`, `touchScale()`, theme toggle (`initTheme`), and the small `ui` flag object |
| `js/version.js` | `VERSION` / `BUILT`, shown in the footer (`#ver`). Bump on each release |
| `js/state.js` | The single mutable project object `S`, change events, undo/redo |
| `js/stage.js` | Preview canvas: drawing, crop/select/annotation pointer tools |
| `js/timeline.js` | Virtualised thumbnail strip, zoom, tap/double-tap |
| `js/transport.js` | Play/pause, seek |
| `js/panels.js` | Tabs, status bar, and `refresh()` (the one place that re-renders on state change) |
| `js/editpanel.js` | Edit tab: selection, timing, crop numbers, clipboard, delay dialog |
| `js/annopanel.js` | Annotate tab: layer list and properties |
| `js/recording.js` | Record dialog, status bar, pause/resume, floating Stop window (Document PiP) |
| `js/importer.js` | Open / add-a-clip dialog and drag-drop |
| `js/exportpanel.js` | Export tab: settings, target size, results cards |
| `js/project.js` | Undo/redo/New buttons, `loadProject`, restore prompt |
| `js/persist.js` | Autosave to IndexedDB (see below) |
| `js/render.js` | Draws a frame + its annotations (incl. fades). Used by BOTH the preview and the export, so they match |
| `js/ops.js` | Pure frame-list operations (trim, speed, reverse, ping-pong, merge duplicates, insert…) |
| `js/ingest.js` | `Recorder` (screen capture, pause), video import by seeking, GIF/WebP import via `ImageDecoder`, `fitFrames` |
| `js/exporter.js` | Renders frames, feeds an encoder (worker, or main-thread fallback); `renderFit` size-limit ladder |
| `js/video.js` | MP4/WebM export with WebCodecs + the vendored muxers |
| `encoder-worker.js` | Thin worker wrapper; serialises messages |
| `lib/encoders.js` | `AnimEncoder`: GIF and WebP encoding with changed-region storage |
| `lib/webpmux.js` | Hand-written animated-WebP (RIFF/ANMF) muxer |
| `lib/gifenc/` | Vendored gifenc (MIT), **locally patched** (see below) |
| `lib/muxers/` | Vendored `mp4-muxer` 5.2.2 and `webm-muxer` 5.1.4 (MIT, unmodified; licences alongside) |
| `sw.js`, `manifest.webmanifest`, `icons/`, `favicon.ico` | Offline, install, and Android share-target |
| `tests/smoke.py` | End-to-end test suite (see Testing) |

## Design decisions to preserve

- **Frames are immutable objects** `{id, seq, bmp, delay, thumb}`. Edits create new frame objects that share the same `ImageBitmap`. That is what makes undo a cheap array copy. Never mutate a frame in place after it is in `S.frames`.
- **`seq` is a frame's original identity.** Annotations store `from`/`to` in `seq` space, so they keep their place when frames are deleted, reversed or duplicated. Copies share their source's `seq`. "To the end" is `1e12`.
- **Undo model:** `commit(key, mutate, {soft})` = checkpoint + mutate + notify. For drags: `checkpoint()` on pointer down, mutate during, `touch()` on pointer up, `discardCheckpoint()` if nothing moved. `emit('view')` is for cursor/selection/tool changes only; `emit('change')` (via `touch`) bumps `S.version`, which invalidates rendered export results.
- **Autosave** (`persist.js`): each *unique* `ImageBitmap` is PNG-encoded once (WeakMap bitmap→key, so duplicated frames and repeat saves cost nothing), then a `meta` record is written, then unused bitmaps are deleted. Order matters: a crash mid-save leaves the previous save intact. `seq` and annotation ids are preserved on restore (`restoreFrame`, `ensureIds`). An empty project only wipes the saved copy after the session has had frames, so opening the page never destroys a save. `hasUnsavedWork()` drives the leave-page warning.
- **Fades are measured in milliseconds, not frames** (`buildTiming` in `render.js`), computed over whatever list is being drawn (preview frames or the export's resampled list), so they survive deleting, speeding up or resampling. `buildTiming` returns `null` when nothing fades, which keeps the common case free.
- **Size-limit export** (`renderFit`): a ladder of progressively smaller settings; `renderExport` aborts an attempt early (`OverBudget`) once ≥25% of frames are in and the projection is >1.5× the budget. Video skips the ladder and sets the bitrate from the target (one retry).
- **Recorder pause**: frames keep arriving but are dropped; `offset` removes the paused span from the timeline so delays stay right.
- **Apply crop** is available in three places: the floating bar on the preview (`#cropBar`, shown while the Crop tool has a crop), the Crop group at the top of the Edit tab, and Enter.
- **Crop and resize are non-destructive**, applied only at export. Frames always keep full size. "Apply crop" (button, Enter, or switching tool) is a view change only: when `S.crop` is set and the tool isn't `crop`, the preview canvas shows just the crop region (`viewRect()` in `stage.js`; `drawOverlay` takes an offset). Pointer coords go through `toSrc`, which maps back to full-frame pixels, so annotations stay in source space. Timeline thumbnails still show full frames.
- **Delays are milliseconds** everywhere in app state. GIF rounds to centiseconds inside the encoder, carrying the rounding error forward and clamping to a 20 ms minimum.
- **Recording uses `MediaStreamTrackProcessor`** (not timers or rAF) because the capturing tab is in the background while recording, and background timers are throttled to 1 Hz. Firefox uses a video-element fallback.

- **Theme:** auto / light / dark, cycled by `#btnTheme`, stored in localStorage `ssr.theme.v1`. An inline script in `<head>` applies it before first paint. Never hard-code colours in CSS or canvas chrome; add a variable and define it for both themes. Icons: `favicon.ico` (16/32/48), `icons/icon-32.png`, `icons/apple-touch-icon.png` (180), plus the SVG and PWA icons; all are in `sw.js` `ASSETS`.

## Gotchas learned the hard way

- **gifenc patch:** upstream `writeFrame` can't place a frame at an offset. `lib/gifenc/index.js` has `left`/`top` options added. If gifenc is ever re-vendored, re-apply that patch or the changed-region GIF optimisation silently breaks. Also: gifenc's `delay` option is in **ms** (it divides by 10 itself), and per-frame palettes are only written when you pass `palette` on non-first frames.
- **Transparent index:** with changed-region storage the palette gets one extra slot appended for transparency. Quantise to `colors - 1`, and map pixels against the palette *without* that slot, or black pixels will turn transparent.
- **WebP frame offsets must be even** (the container stores x/2, y/2). `_diff(..., align=true)` snaps the region origin down.
- **Worker messages must be processed one at a time** (`encoder-worker.js` chains a promise). WebP frames are async; without the queue they interleave.
- **Layout:** `body` needs `grid-template-columns: minmax(0, 1fr)`. The timeline strip is thousands of pixels wide and an implicit `auto` column grows to fit it, pushing the preview and panel off screen.
- **Safari can't encode WebP** (canvas returns PNG). `webpSupported()` gates the button. Android browsers have no `getDisplayMedia`, so phone users import a screen recording instead; the empty state says so.
- `confirm()` is used before replacing a project. Playwright auto-dismisses dialogs, so tests must accept them.

## Testing

```bash
python3 tests/smoke.py                 # whole suite (~4 min)
python3 tests/smoke.py --only core,persist
SHOTS_DIR=/tmp/shots python3 tests/smoke.py --only phone   # keep phone screenshots
```

It serves the repo itself and drives real Chrome (`/usr/bin/google-chrome`, `--no-sandbox`) with Playwright. Needs `ffmpeg`/`ffprobe` and Pillow. Suites: `core`, `export`, `export2` (size limit, MP4/WebM verified with ffprobe, fades, cancel), `persist`, `edit`, `addclip`, `record`, `phone` (Pixel 7 touch emulation: overflow, tap-target size, 16px inputs, sticky preview, finger drags), `assets` (every imported module is in `sw.js` `ASSETS`; every named import exists), `offline` (real service worker, network cut), `theme` (toggle, persistence, contrast, icons).

Run the full suite before pushing anything that touches more than one module. `eslint` with `no-undef` is a good extra check for missing imports, but it can't see a *missing export*; the `assets` suite does.

Gotchas for writing tests:
- `window.__app` exposes `{ S, openFile, loadProject, saveNow, setCur, touch }`.
- Dialogs must be accepted (`confirm()` is used before replacing a project); the test helper does it.
- Headless can't complete the real screen picker: override `navigator.mediaDevices.getDisplayMedia` with a `canvas.captureStream()` (see `FAKE_SCREEN`). Document PiP is stubbed with a popup (`FAKE_PIP`).
- On the phone profile, clicking a control in the panel scrolls the page; the timeline then sits under the pinned preview. `scrollTo(0,0)` before tapping it.
- Read result blobs back with `fetch(a.href)` and decode with PIL / ffprobe.

## Not yet verified on a real device

Everything above passes in headless desktop Chrome, including a Pixel 7 touch emulation and a real service-worker offline run. Still untested on actual hardware: the real screen-picker flow, the Android share target (`share_target` in the manifest + `sw.js`), install-to-home-screen, Document PiP in a real window, H.264 encoding on a phone, and Safari/Firefox generally. Check these first on a real device.

## Ideas not built yet

Per-region quality, OPFS-backed frame storage for very long recordings (autosave already uses IndexedDB, but frames are still held in memory), range selection by long-press on touch, audio, an APNG export.
