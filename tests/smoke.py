#!/usr/bin/env python3
"""End-to-end smoke test. Drives the real app in headless Chrome.

    python3 tests/smoke.py            # serves the repo itself on a free port
    python3 tests/smoke.py --only crop,export

Needs: playwright (python), system Chrome at /usr/bin/google-chrome, ffmpeg, Pillow.
Each check prints PASS/FAIL; the exit code is non-zero if any failed.
"""
import argparse, asyncio, http.server, io, os, socketserver, subprocess, sys, tempfile, threading
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
FAILS = []


def check(name, cond, extra=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''))
    if not cond:
        FAILS.append(name)


def serve():
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(ROOT), **k)

        def log_message(self, *a):
            pass

    srv = socketserver.TCPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}/index.html'


def make_video(d, secs=3, w=640, h=360, name='test.mp4'):
    p = Path(d) / name
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', f'testsrc=size={w}x{h}:rate=30:duration={secs}',
                    '-pix_fmt', 'yuv420p', str(p)], check=True)
    return str(p)


class Ctx:
    pass


async def new_page(b, url, **kw):
    ctx = await b.new_context(viewport=kw.pop('viewport', {'width': 1360, 'height': 860}), **kw)
    pg = await ctx.new_page()
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
    await pg.goto(url)
    return ctx, pg, errs


async def import_video(pg, path, fps='10', width=None):
    await pg.set_input_files('#fileInput', path)
    await pg.wait_for_selector('#impDlg[open]')
    await pg.select_option('#impFps', fps)
    if width:
        await pg.select_option('#impW', str(width))
    await pg.click('#impGo')
    await pg.wait_for_function('window.__app.S.frames.length>0 && !document.querySelector("#impDlg[open]")', timeout=90000)


async def canvas_size(pg):
    return await pg.evaluate('[document.getElementById("view").width, document.getElementById("view").height]')


async def blob_of(pg, selector):
    """Bytes of the result <a download> link matching selector."""
    b64 = await pg.evaluate('''async (sel) => {
      const a = document.querySelector(sel); const buf = await (await fetch(a.href)).arrayBuffer();
      let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s); }''', selector)
    import base64
    return base64.b64decode(b64)


# --------------------------------------------------------------------------- tests

async def t_core(b, url, tmp):
    ctx, pg, errs = await new_page(b, url)
    vid = make_video(tmp)
    await import_video(pg, vid)
    n = await pg.evaluate('__app.S.frames.length')
    check('import: ~30 frames at 10fps over 3s', 28 <= n <= 31, n)
    check('import: canvas matches video', await canvas_size(pg) == [640, 360])

    # selection + delete + undo
    await pg.click('#opSelAll')
    await pg.evaluate('__app.S.sel = {a: 2, b: 5}')
    await pg.click('#opDelete')
    check('delete 4 frames', await pg.evaluate('__app.S.frames.length') == n - 4)
    await pg.click('#btnUndo')
    check('undo restores', await pg.evaluate('__app.S.frames.length') == n)

    # ops
    await pg.evaluate('__app.S.sel = {a: 0, b: 9}')
    await pg.click('#opReverse')
    await pg.click('#opPing')
    check('ping-pong adds frames', await pg.evaluate('__app.S.frames.length') > n)
    await pg.click('#btnUndo'); await pg.click('#btnUndo')
    check('undo x2 back to original', await pg.evaluate('__app.S.frames.length') == n)

    # crop apply
    await pg.click('[data-tool=crop]')
    r = await pg.evaluate('(()=>{const r=document.getElementById("view").getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()')
    await pg.mouse.move(r[0] + r[2] * .25, r[1] + r[3] * .25); await pg.mouse.down()
    await pg.mouse.move(r[0] + r[2] * .75, r[1] + r[3] * .75, steps=6); await pg.mouse.up()
    await pg.click('#cropApply')
    check('crop apply shrinks the preview', await canvas_size(pg) == [320, 180], await canvas_size(pg))

    # annotation lands in source coords
    await pg.click('[data-tool=text]')
    r = await pg.evaluate('(()=>{const r=document.getElementById("view").getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()')
    await pg.mouse.click(r[0] + r[2] / 2, r[1] + r[3] / 2)
    a = await pg.evaluate('__app.S.annos[0]')
    check('text annotation placed in source space', abs(a['x1'] - 320) < 3 and abs(a['y1'] - 180) < 3, a)

    check('no console errors', not errs, errs[:3])
    await ctx.close()


async def t_export(b, url, tmp):
    from PIL import Image
    ctx, pg, errs = await new_page(b, url)
    await import_video(pg, make_video(tmp), width=480)
    await pg.click('[data-tab=export]')
    await pg.click('#btnRenderGif')
    await pg.wait_for_selector('#results .res a[download*=".gif"]', timeout=90000)
    gif = await blob_of(pg, '#results a[download*=".gif"]')
    im = Image.open(io.BytesIO(gif))
    check('gif decodes with many frames', im.n_frames >= 25, im.n_frames)
    await pg.click('#btnRenderWebp')
    await pg.wait_for_selector('#results .res a[download*=".webp"]', timeout=90000)
    webp = await blob_of(pg, '#results a[download*=".webp"]')
    im2 = Image.open(io.BytesIO(webp))
    check('webp decodes with many frames', im2.n_frames >= 25, im2.n_frames)
    check('webp smaller than gif', len(webp) < len(gif), (len(webp), len(gif)))
    check('no console errors', not errs, errs[:3])
    await ctx.close()


TESTS = {'core': t_core, 'export': t_export}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    args = ap.parse_args()
    names = [n for n in args.only.split(',') if n] or list(TESTS)
    srv, url = serve()
    with tempfile.TemporaryDirectory() as tmp:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
            for n in names:
                print(f'--- {n}')
                try:
                    await TESTS[n](b, url, tmp)
                except Exception as e:  # a crash is a failure, but keep running the rest
                    import traceback; traceback.print_exc()
                    check(f'{n} ran without exception', False, repr(e))
            await b.close()
    srv.shutdown()
    print(f'\n{len(FAILS)} failed' if FAILS else '\nall passed')
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    asyncio.run(main())
