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
| `index.html`, `style.css` | Page and styles (dark theme, amber accent, CSS variables at top of the stylesheet) |
| `js/main.js` | All UI wiring: stage pointer handling, timeline strip, panels, dialogs, recording/import/export flows, keyboard |
| `js/state.js` | The single mutable project object `S`, change events, undo/redo |
| `js/render.js` | Draws a frame + its annotations. Used by BOTH the preview and the export, so they match |
| `js/ops.js` | Pure frame-list operations (trim, speed, reverse, ping-pong, merge duplicates…) |
| `js/ingest.js` | `Recorder` (screen capture), video import by seeking, GIF/WebP import via `ImageDecoder` |
| `js/exporter.js` | Renders frames, feeds an encoder (worker, or main-thread fallback), returns a Blob |
| `encoder-worker.js` | Thin worker wrapper; serialises messages |
| `lib/encoders.js` | `AnimEncoder`: GIF and WebP encoding with changed-region storage |
| `lib/webpmux.js` | Hand-written animated-WebP (RIFF/ANMF) muxer |
| `lib/gifenc/` | Vendored gifenc (MIT), **locally patched** (see below) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline, install, and Android share-target |

## Design decisions to preserve

- **Frames are immutable objects** `{id, seq, bmp, delay, thumb}`. Edits create new frame objects that share the same `ImageBitmap`. That is what makes undo a cheap array copy. Never mutate a frame in place after it is in `S.frames`.
- **`seq` is a frame's original identity.** Annotations store `from`/`to` in `seq` space, so they keep their place when frames are deleted, reversed or duplicated. Copies share their source's `seq`. "To the end" is `1e12`.
- **Undo model:** `commit(key, mutate, {soft})` = checkpoint + mutate + notify. For drags: `checkpoint()` on pointer down, mutate during, `touch()` on pointer up, `discardCheckpoint()` if nothing moved. `emit('view')` is for cursor/selection/tool changes only; `emit('change')` (via `touch`) bumps `S.version`, which invalidates rendered export results.
- **Crop and resize are non-destructive**, applied only at export. Frames always keep full size.
- **Delays are milliseconds** everywhere in app state. GIF rounds to centiseconds inside the encoder, carrying the rounding error forward and clamping to a 20 ms minimum.
- **Recording uses `MediaStreamTrackProcessor`** (not timers or rAF) because the capturing tab is in the background while recording, and background timers are throttled to 1 Hz. Firefox uses a video-element fallback.

## Gotchas learned the hard way

- **gifenc patch:** upstream `writeFrame` can't place a frame at an offset. `lib/gifenc/index.js` has `left`/`top` options added. If gifenc is ever re-vendored, re-apply that patch or the changed-region GIF optimisation silently breaks. Also: gifenc's `delay` option is in **ms** (it divides by 10 itself), and per-frame palettes are only written when you pass `palette` on non-first frames.
- **Transparent index:** with changed-region storage the palette gets one extra slot appended for transparency. Quantise to `colors - 1`, and map pixels against the palette *without* that slot, or black pixels will turn transparent.
- **WebP frame offsets must be even** (the container stores x/2, y/2). `_diff(..., align=true)` snaps the region origin down.
- **Worker messages must be processed one at a time** (`encoder-worker.js` chains a promise). WebP frames are async; without the queue they interleave.
- **Layout:** `body` needs `grid-template-columns: minmax(0, 1fr)`. The timeline strip is thousands of pixels wide and an implicit `auto` column grows to fit it, pushing the preview and panel off screen.
- **Safari can't encode WebP** (canvas returns PNG). `webpSupported()` gates the button. Android browsers have no `getDisplayMedia`, so phone users import a screen recording instead; the empty state says so.
- `confirm()` is used before replacing a project. Playwright auto-dismisses dialogs, so tests must accept them.

## Testing

There is no test framework. Verify by running it in a real browser:

```bash
python3 -m http.server 8765          # serve the repo root
```

then drive it with Playwright using system Chrome (`executable_path='/usr/bin/google-chrome'`, `--no-sandbox`). `window.__app` exposes `{ S, openFile, loadProject }` for assertions.

Useful recipes:
- **Import:** `ffmpeg -f lavfi -i testsrc=size=640x360:rate=30:duration=3 -pix_fmt yuv420p test.mp4`, `set_input_files('#fileInput', ...)`, pick fps in `#impFps`, click `#impGo`, wait for `__app.S.frames.length`.
- **Check outputs:** read the result `<a download>` blobs back with `fetch(a.href)`, then decode with PIL (`Image.open(...).n_frames`, per-frame durations, pixel error against the source). Parse the WebP container directly if PIL's duration readout is `None` (it can be).
- **Recording:** headless Chrome can't complete the real screen picker. Test the pipeline by overriding `navigator.mediaDevices.getDisplayMedia` via `add_init_script` to return `canvas.captureStream()`.
- GIF/WebP encoders can be unit-tested directly: the GIF path in plain Node (`import { AnimEncoder } from './lib/encoders.js'`), the WebP path inside Chrome (it needs `OffscreenCanvas`).

## Not yet verified on a real device

The actual screen-picker flow, the Android share target (`share_target` in the manifest + `sw.js`), and install/offline behaviour on a phone. Check these first when Pages is live.

## Ideas not built yet

Per-region quality, text-box resizing handles, adding frames from a second clip, OPFS-backed frame storage for very long recordings, a Document Picture-in-Picture stop button for recording.
