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


PIXHASH = '''(i) => { const f = __app.S.frames[i]; const c = document.createElement('canvas'); c.width = f.bmp.width; c.height = f.bmp.height;
  const x = c.getContext('2d'); x.drawImage(f.bmp, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261; for (let k = 0; k < d.length; k += 7) { h ^= d[k]; h = Math.imul(h, 16777619) >>> 0; } return h; }'''


async def wait_saved(pg):
    await pg.evaluate('__app.saveNow()')
    await pg.wait_for_function('document.getElementById("saveInd").textContent === "Autosaved"', timeout=60000)


async def t_persist(b, url, tmp):
    ctx, pg, errs = await new_page(b, url)
    check('fresh profile: no restore prompt', await pg.evaluate('document.getElementById("restoreBox").hidden'))
    await import_video(pg, make_video(tmp, secs=2), fps='5', width=480)
    await pg.click('#opDup')  # duplicated frames share a bitmap
    await pg.evaluate('__app.S.sel = {a: 1, b: 1}')
    await pg.fill('#delayMs', '333'); await pg.click('#opDelay')
    await pg.evaluate("__app.S.crop = {x: 40, y: 30, w: 200, h: 120}")
    await pg.click('[data-tool=text]')
    r = await pg.evaluate('(()=>{const r=document.getElementById("view").getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()')
    await pg.mouse.click(r[0] + r[2] / 2, r[1] + r[3] / 2)
    await pg.evaluate("__app.S.annos[0].text = 'hello'; __app.S.version++")  # annotation edit
    await pg.evaluate("document.getElementById('expBg').value = '#112233'; document.getElementById('expBg').dispatchEvent(new Event('input'))")
    await wait_saved(pg)
    before = await pg.evaluate('({n: __app.S.frames.length, d: __app.S.frames.map(f => f.delay), q: __app.S.frames.map(f => f.seq), crop: __app.S.crop, annos: __app.S.annos, bg: __app.S.bg})')
    h_before = [await pg.evaluate(PIXHASH, i) for i in (0, 3, before['n'] - 1)]

    pg2 = await ctx.new_page()
    pg2.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
    errs2 = []
    pg2.on('pageerror', lambda e: errs2.append(str(e)))
    pg2.on('console', lambda m: errs2.append(m.text) if m.type == 'error' else None)
    await pg2.goto(url)
    await pg2.wait_for_selector('#restoreBox:not([hidden])', timeout=10000)
    info = await pg2.inner_text('#restoreInfo')
    check('restore prompt shows frame count', str(before['n']) in info, info)
    await pg2.click('#restoreGo')
    await pg2.wait_for_function('window.__app.S.frames.length>0', timeout=30000)
    after = await pg2.evaluate('({n: __app.S.frames.length, d: __app.S.frames.map(f => f.delay), q: __app.S.frames.map(f => f.seq), crop: __app.S.crop, annos: __app.S.annos, bg: __app.S.bg})')
    check('restore: same frame count', after['n'] == before['n'], (after['n'], before['n']))
    check('restore: same delays', after['d'] == before['d'])
    check('restore: same seq (annotation ranges survive)', after['q'] == before['q'])
    check('restore: crop kept', after['crop'] == before['crop'], after['crop'])
    check('restore: annotation kept', len(after['annos']) == 1 and after['annos'][0]['text'] == 'hello' and after['annos'][0]['from'] == before['annos'][0]['from'])
    check('restore: background kept', after['bg'] == '#112233', after['bg'])
    h_after = [await pg2.evaluate(PIXHASH, i) for i in (0, 3, after['n'] - 1)]
    check('restore: pixels identical', h_before == h_after, (h_before, h_after))
    # new annotations after a restore must not reuse ids
    await pg2.click('[data-tool=arrow]')
    r = await pg2.evaluate('(()=>{const r=document.getElementById("view").getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()')
    await pg2.mouse.move(r[0] + 20, r[1] + 20); await pg2.mouse.down(); await pg2.mouse.move(r[0] + 90, r[1] + 70, steps=4); await pg2.mouse.up()
    ids = await pg2.evaluate('__app.S.annos.map(a => a.id)')
    check('restore: new annotation id is unique', len(ids) == 2 and len(set(ids)) == 2, ids)

    # New wipes the saved copy
    await pg2.click('#btnNew')
    await pg2.wait_for_timeout(1200)
    pg3 = await ctx.new_page()
    await pg3.goto(url)
    await pg3.wait_for_timeout(800)
    check('New clears the autosave', await pg3.evaluate('document.getElementById("restoreBox").hidden'))

    # Discard path
    await import_video(pg3, make_video(tmp, secs=1, name='b.mp4'), fps='5', width=480)
    await wait_saved(pg3)
    pg4 = await ctx.new_page()
    await pg4.goto(url)
    await pg4.wait_for_selector('#restoreBox:not([hidden])', timeout=10000)
    await pg4.click('#restoreDrop')
    pg5 = await ctx.new_page()
    await pg5.goto(url)
    await pg5.wait_for_timeout(800)
    check('Discard clears the autosave', await pg5.evaluate('document.getElementById("restoreBox").hidden'))
    check('no console errors', not errs and not errs2, (errs + errs2)[:3])
    await ctx.close()


TESTS = {'core': t_core, 'export': t_export, 'persist': t_persist}


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
