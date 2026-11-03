# Simple Screen Recorder

Record your screen (or open a video, GIF or animated WebP), edit it frame by frame, and export a **GIF** or **animated WebP**. It's a static site: everything runs in your browser and nothing is uploaded. No build step, no dependencies to install.

## Features

**Get frames in**
- **Record** a screen, window or tab. Frames are captured as individual images, so every one is editable. Options: frame rate, max width, start delay, and "skip identical frames" (a static screen costs almost no memory).
- **Open** a video (MP4, WebM, MOV where the browser can play it) with a chosen frame rate, width and start/end range.
- **Open** an existing GIF or animated WebP to re-edit it (Chromium browsers).
- Drag and drop a file anywhere on the page.

**Edit**
- Timeline with scrub, range selection (click, drag, shift-click), per-frame delay shown.
- Trim before/after, keep or delete a selection, duplicate, reverse, ping-pong loop.
- Speed up or slow down a range, set an exact frame delay, halve the frame rate (timing preserved).
- Merge duplicate frames (identical / near-identical / similar).
- Crop (drag on the preview, type numbers, or pick an aspect ratio) and resize.
- Annotations that each appear on any range of frames: text, arrows, boxes, click-highlight spots, and pixelate-to-hide areas. Select, move and resize them on the preview.
- Undo/redo for everything.

**Export**
- GIF: 16 to 256 colours, optional dithering, one shared palette or one per frame.
- Animated WebP: lossy with a quality slider, or lossless.
- "Only store what changes" (on by default) stores just the region that changed between frames. For screen recordings this is usually the biggest size win.
- Render both and compare sizes side by side before downloading. Share button on phones.

## Deploy to GitHub Pages

1. Repo **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
2. Wait a minute, then open https://adambeltz2.github.io/Simple-Screen-Recorder/.

To host your own copy, fork or copy the files to the **root** of a repo, push to `main`, and enable Pages the same way. The site will be at `https://<username>.github.io/<repo-name>/`.

All paths are relative, so it works under a project subpath. HTTPS (which Pages provides) is required for screen capture.

To run it locally: `python3 -m http.server 8000` in this folder, then open `http://localhost:8000`. Opening `index.html` straight from disk won't work (ES modules and workers need a server).

## Using it on a phone

Install it from the browser menu ("Add to Home screen" / "Install app"); it then works offline. Android browsers can't capture the screen from a web page, so record with your phone's own screen recorder and open that video here. Once installed, you can also use **Share → Simple Screen Recorder** from your gallery or files app to send a video straight in.

## Browser support

| | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| Record screen | yes | yes | yes (desktop) |
| Open video | yes | yes | yes |
| Open GIF/WebP | yes | no | no |
| Export GIF | yes | yes | yes |
| Export WebP | yes | yes | **no** (can't encode WebP) |

Recording keeps running while you work in another window or tab. Chrome and Edge use a method that isn't throttled in the background; Firefox falls back to a slower path.

## Tips for small files

- Lower the **width** first (50% is a quarter of the pixels), then the **max frame rate** (10 to 15 fps is plenty for UI demos).
- Leave **Only store what changes** on. Use **Light** or **Medium** if the recording has compression noise.
- **Crop** away anything that isn't the point.
- For GIFs, try 128 or 64 colours with no dithering for flat UI; keep dithering for photos and gradients.
- WebP is typically much smaller than GIF at the same quality.

## Memory

Frames are held uncompressed in memory (width × height × 4 bytes each). The status bar shows the running total, and recording stops automatically at about 1.2 GB. A 960×540 recording is roughly 2 MB per frame, so lower the frame rate or width for long captures.

## Project layout

```
index.html            page
style.css
js/main.js            UI wiring (stage, timeline, panels, dialogs)
js/state.js           project state, undo/redo
js/render.js          drawing frames and annotations (shared by preview and export)
js/ops.js             frame operations (trim, speed, reverse, merge…)
js/ingest.js          screen recording, video and GIF/WebP import
js/exporter.js        export pipeline
encoder-worker.js     runs the encoders off the main thread
lib/encoders.js       GIF + WebP encoders with changed-region storage
lib/webpmux.js        animated-WebP muxer (browsers can't encode animations natively)
lib/gifenc/           vendored GIF encoder (see below)
sw.js, manifest.webmanifest, icons/   offline + install + share target
```

## Third-party code

`lib/gifenc/` is [gifenc](https://github.com/mattdesl/gifenc) by Matt DesLauriers (MIT, license included). It has one local patch: `left`/`top` options on `writeFrame` so frames can be stored as sub-rectangles.

## Known limits

- Screen capture always goes through the browser's own picker; the page can't choose a source for you.
- Click and keystroke overlays aren't possible (browsers don't expose that), but the **Spot** annotation can mark clicks by hand.
- GIF can't go below 20 ms per frame, so very fast recordings are capped at about 50 fps.
