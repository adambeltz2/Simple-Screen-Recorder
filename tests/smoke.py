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
DEVICES = {}
SHOTS = os.environ.get('SHOTS_DIR', '')  # set to a folder to keep screenshots


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
    check('floating Apply bar shows while cropping', await pg.is_visible('#cropBar'))
    await pg.click('#cropBarApply')
    check('Apply bar hides after applying', not await pg.is_visible('#cropBar'))
    check('crop apply shrinks the preview', await canvas_size(pg) == [320, 180], await canvas_size(pg))

    # annotation lands in source coords
    await pg.click('[data-tool=text]')
    r = await pg.evaluate('(()=>{const r=document.getElementById("view").getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()')
    await pg.mouse.click(r[0] + r[2] / 2, r[1] + r[3] / 2)
    a = await pg.evaluate('__app.S.annos[0]')
    check('text annotation placed in source space', abs(a['x1'] - 320) < 3 and abs(a['y1'] - 180) < 3, a)

    ver = await pg.evaluate("document.getElementById('ver').textContent")
    check('footer shows a version', ver.startswith('v') and len(ver) > 3, ver)
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


async def view_rect(pg):
    return await pg.evaluate('(()=>{const r=document.getElementById("view").getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()')


async def t_edit(b, url, tmp):
    ctx, pg, errs = await new_page(b, url)
    await import_video(pg, make_video(tmp, secs=2), fps='5', width=640)
    n = await pg.evaluate('__app.S.frames.length')

    # ---- copy / paste / cut
    await pg.evaluate('__app.S.sel = {a: 2, b: 4}; __app.S.cur = 4')
    await pg.click('#opCopy')
    await pg.click('#opPaste')
    check('paste inserts 3 frames', await pg.evaluate('__app.S.frames.length') == n + 3)
    check('pasted frames are selected after the original range', await pg.evaluate('[__app.S.sel.a, __app.S.sel.b]') == [5, 7])
    check('paste copies share seq with the source', await pg.evaluate('__app.S.frames[5].seq === __app.S.frames[2].seq'))
    ids = await pg.evaluate('__app.S.frames.map(f => f.id)')
    check('pasted frames have unique ids', len(set(ids)) == len(ids))
    await pg.evaluate('__app.S.sel = {a: 0, b: 1}; __app.S.cur = 0')
    await pg.click('#opCut')
    check('cut removes frames', await pg.evaluate('__app.S.frames.length') == n + 1)
    await pg.evaluate('__app.S.sel = {a: 0, b: 0}')
    await pg.click('#opPaste')
    check('paste after cut restores them', await pg.evaluate('__app.S.frames.length') == n + 3)
    await pg.click('#btnUndo')
    check('paste is undoable', await pg.evaluate('__app.S.frames.length') == n + 1)

    # ---- delay dialog via double-click on a timeline frame
    box = await pg.evaluate('(()=>{const r=document.querySelector("#strip .fr").getBoundingClientRect();return [r.x+r.width/2, r.y+r.height/2]})()')
    await pg.mouse.dblclick(box[0], box[1])
    await pg.wait_for_selector('#delayDlg[open]')
    await pg.fill('#delayDlgMs', '777')
    await pg.click('#delayDlgOk')
    check('double-click sets a single frame delay', await pg.evaluate('[__app.S.frames[0].delay, __app.S.frames[1].delay]') == [777, 200], await pg.evaluate('[__app.S.frames[0].delay, __app.S.frames[1].delay]'))

    # ---- timeline zoom
    w0 = await pg.evaluate('getComputedStyle(document.getElementById("strip")).getPropertyValue("--fw")')
    await pg.click('#zoomIn')
    w1 = await pg.evaluate('getComputedStyle(document.getElementById("strip")).getPropertyValue("--fw")')
    check('zoom in makes thumbnails larger', int(w1.replace('px', '')) > int(w0.replace('px', '')), (w0, w1))
    await pg.click('#zoomOut'); await pg.click('#zoomOut'); await pg.click('#zoomOut')
    check('zoom out bottoms out and disables the button', await pg.evaluate('document.getElementById("zoomOut").disabled'))
    await pg.click('#zoomIn'); await pg.click('#zoomIn')

    # ---- text resize handle
    await pg.click('[data-tool=text]')
    r = await view_rect(pg)
    await pg.mouse.click(r[0] + r[2] * .2, r[1] + r[3] * .3)
    size0 = await pg.evaluate('__app.S.annos[0].size')
    h = await pg.evaluate("""(async () => { const m = await import('./js/render.js'); const a = __app.S.annos[0]; return m.annoHandles(a)[0]; })()""")
    k = r[2] / 640
    await pg.mouse.move(r[0] + h['x'] * k, r[1] + h['y'] * k); await pg.mouse.down()
    await pg.mouse.move(r[0] + h['x'] * k + 80, r[1] + h['y'] * k, steps=6); await pg.mouse.up()
    size1 = await pg.evaluate('__app.S.annos[0].size')
    check('dragging the text handle enlarges the text', size1 > size0 * 1.2, (size0, size1))

    # ---- fades: pixel opacity changes along the timeline
    await pg.evaluate("""() => { const S = __app.S; S.annos = [{ id: 900, type: 'rect', x1: 100, y1: 100, x2: 500, y2: 260, color: '#ff0000', width: 60, fill: false,
        text: '', size: 20, bg: false, block: 8, fin: 0, fout: 0, from: -1, to: 1e12 }]; S.selAnno = null; __app.touch(); }""")
    px = '(() => { const d = document.getElementById("view").getContext("2d").getImageData(100, 180, 1, 1).data; return [d[0], d[1], d[2]]; })()'
    last = n  # after the earlier edits the frame count differs; use the live value
    last = (await pg.evaluate('__app.S.frames.length')) - 1
    await pg.evaluate('__app.setCur(0)'); full0 = await pg.evaluate(px)
    await pg.evaluate('__app.S.annos[0].fin = 1500; __app.touch(); __app.setCur(0)')
    faded0 = await pg.evaluate(px)
    await pg.evaluate(f'__app.setCur({last})'); faded_end = await pg.evaluate(px)
    dist = lambda a, b: sum(abs(x - y) for x, y in zip(a, b))
    check('fade-in: first frame is mostly transparent', dist(full0, faded0) > 150, (full0, faded0))
    check('fade-in: later frame reaches full colour', dist(full0, faded_end) < 60 or faded_end[0] > 200, (full0, faded_end))
    check('no console errors', not errs, errs[:3])
    await ctx.close()


async def t_addclip(b, url, tmp):
    ctx, pg, errs = await new_page(b, url)
    await import_video(pg, make_video(tmp, secs=2), fps='5', width=640)
    n = await pg.evaluate('__app.S.frames.length')
    await pg.evaluate('__app.setCur(3)')
    other = make_video(tmp, secs=1, w=320, h=240, name='small.mp4')
    await pg.set_input_files('#fileInputAdd', other)
    await pg.wait_for_selector('#impDlg[open]')
    title = await pg.inner_text('#impTitle')
    check('add dialog is titled for adding', 'Add' in title, title)
    await pg.select_option('#impFps', '5')
    await pg.click('#impGo')
    await pg.wait_for_function(f'window.__app.S.frames.length > {n}', timeout=60000)
    n2 = await pg.evaluate('__app.S.frames.length')
    check('clip frames were added', n2 == n + 5, (n, n2))
    sizes = await pg.evaluate('[...new Set(__app.S.frames.map(f => f.bmp.width + "x" + f.bmp.height))]')
    check('all frames share the project size', sizes == ['640x360'], sizes)
    check('inserted after the current frame and selected', await pg.evaluate('[__app.S.sel.a, __app.S.sel.b, __app.S.cur]') == [4, 8, 4])
    await pg.click('#btnUndo')
    check('add clip is undoable', await pg.evaluate('__app.S.frames.length') == n)
    check('project was not replaced (no restore of old project size)', await canvas_size(pg) == [640, 360])
    check('no console errors', not errs, errs[:3])
    await ctx.close()


FAKE_SCREEN = """
navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 800; c.height = 450;
  const x = c.getContext('2d'); let t = 0;
  const draw = () => { t++; x.fillStyle = 'hsl(' + (t * 6 % 360) + ',70%,45%)'; x.fillRect(0, 0, 800, 450); x.fillStyle = '#fff'; x.font = '90px sans-serif'; x.fillText(String(t), 60, 240); };
  setInterval(draw, 16); draw();
  return c.captureStream(30);
};
"""
FAKE_PIP = """
Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: {
  requestWindow: async () => { const w = window.open('about:blank', '_blank', 'popup,width=300,height=76'); window.__pip = w; return w; } } });
"""


async def start_recording(pg, fps='10', width='480', pip=False):
    await pg.click('#btnRecord'); await pg.wait_for_selector('#recDlg[open]')
    await pg.select_option('#recDelay', '0'); await pg.select_option('#recFps', fps); await pg.select_option('#recW', width)
    await pg.uncheck('#recSkip')
    if not pip and await pg.evaluate('!document.getElementById("recPipRow").hidden'):
        await pg.uncheck('#recPip')
    await pg.click('#recStart')
    await pg.wait_for_function('document.getElementById("recMsg").textContent === "Recording"', timeout=10000)


async def t_record(b, url, tmp):
    ctx, pg, errs = await new_page(b, url)
    await pg.add_init_script(FAKE_SCREEN)
    await pg.reload()
    has_pip = await pg.evaluate('"documentPictureInPicture" in window')
    check('pip option is shown exactly when the browser supports it', (not await pg.evaluate('document.getElementById("recPipRow").hidden')) == has_pip)
    await start_recording(pg)
    await pg.wait_for_timeout(1200)
    await pg.click('#recPause')
    check('pause shows Paused / Resume', (await pg.inner_text('#recMsg')) == 'Paused' and (await pg.inner_text('#recPause')) == 'Resume')
    await pg.wait_for_timeout(500)  # let frames already in flight land
    c1 = await pg.inner_text('#recCount')
    await pg.wait_for_timeout(2000)
    c2 = await pg.inner_text('#recCount')
    check('no frames captured while paused', c1 == c2, (c1, c2))
    t_paused = await pg.inner_text('#recTime')
    check('timer is frozen while paused', t_paused in ('0:01', '0:02'), t_paused)
    await pg.click('#recPause')
    await pg.wait_for_timeout(1200)
    await pg.click('#recStop')
    await pg.wait_for_function('window.__app.S.frames.length > 0', timeout=10000)
    total = await pg.evaluate('__app.S.frames.reduce((a, f) => a + f.delay, 0)')
    n = await pg.evaluate('__app.S.frames.length')
    check('paused time is cut from the recording', 1800 <= total <= 3300, total)
    check('plausible frame count', 15 <= n <= 30, n)
    check('no console errors', not errs, errs[:3])
    await ctx.close()

    # ---- stub of Document Picture-in-Picture: buttons live in a second window
    ctx, pg, errs = await new_page(b, url)
    await pg.add_init_script(FAKE_SCREEN + FAKE_PIP)
    await pg.reload()
    check('pip row shown when supported', not await pg.evaluate('document.getElementById("recPipRow").hidden'))
    await start_recording(pg, pip=True)
    await pg.wait_for_function('window.__pip && window.__pip.document.querySelector("button.stop")', timeout=10000)
    await pg.wait_for_timeout(600)
    await pg.evaluate('__pip.document.querySelectorAll("button")[0].click()')  # Pause in the floating window
    check('floating Pause pauses the recording', (await pg.inner_text('#recMsg')) == 'Paused')
    await pg.evaluate('__pip.document.querySelectorAll("button")[0].click()')  # Resume
    await pg.wait_for_timeout(500)
    await pg.evaluate('__pip.document.querySelector("button.stop").click()')
    await pg.wait_for_function('window.__app.S.frames.length > 0', timeout=10000)
    check('floating window closes when recording ends', await pg.evaluate('window.__pip.closed'))
    check('no console errors (pip)', not errs, errs[:3])
    await ctx.close()


def ffprobe(path):
    import json
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


async def t_export2(b, url, tmp):
    from PIL import Image
    ctx, pg, errs = await new_page(b, url)
    await import_video(pg, make_video(tmp, secs=4, w=1280, h=720), fps='12', width=1280)
    await pg.click('[data-tab=export]')

    # ---- baseline size, then fit under a limit
    await pg.select_option('#expTarget', '0')
    await pg.click('#btnRenderGif')
    await pg.wait_for_selector('#results a[download*=".gif"]', timeout=120000)
    base = len(await blob_of(pg, '#results a[download*=".gif"]'))
    print(f'     baseline GIF: {base/1e6:.2f} MB')
    check('baseline is larger than the 1 MB target (so the ladder has work to do)', base > 1.0e6, base)
    await pg.select_option('#expTarget', '1')
    tgt = 1
    await pg.click('#btnRenderGif')
    await pg.wait_for_function('document.querySelector("#results .okfit, #results .missfit")', timeout=240000)
    fit_txt = await pg.inner_text('#results .res .okfit, #results .res .missfit')
    gif = await blob_of(pg, '#results a[download*=".gif"]')
    print(f'     fitted GIF: {len(gif)/1e6:.2f} MB  ({fit_txt})')
    check('fit: result is under the limit', len(gif) <= tgt * 1e6, (len(gif), tgt))
    check('fit: says it fits', 'Fits' in fit_txt, fit_txt)
    check('fit: needed more than the first try', 'try ' in fit_txt and 'your settings' not in fit_txt, fit_txt)
    im = Image.open(io.BytesIO(gif)); check('fit: GIF still valid', im.n_frames > 10, im.n_frames)

    # an impossible limit reports the closest result instead of failing
    await pg.select_option('#expTarget', '1')
    await pg.select_option('#expFps', '0')
    # (tiny limit vs a long clip is hard to build with testsrc; just make sure the path is exercised without errors)
    check('no console errors (fit)', not errs, errs[:3])

    # ---- video
    sup = await pg.evaluate('!document.getElementById("vidRow").hidden')
    check('video export offered in this browser', sup)
    if sup:
        await pg.select_option('#expTarget', '0')
        for fmt in ('mp4', 'webm'):
            disabled = await pg.evaluate(f'document.querySelector("#vidFormat option[value={fmt}]").disabled')
            if disabled:
                print(f'     ({fmt} not encodable in this Chrome, skipping)'); continue
            await pg.select_option('#vidFormat', fmt)
            await pg.click('#btnRenderVideo')
            await pg.wait_for_selector(f'#results a[download$=".{fmt}"]', timeout=120000)
            data = await blob_of(pg, f'#results a[download$=".{fmt}"]')
            path = Path(tmp) / f'out.{fmt}'; path.write_bytes(data)
            info = ffprobe(str(path)); v = [x for x in info['streams'] if x['codec_type'] == 'video'][0]
            dur = float(info['format']['duration'])
            print(f'     {fmt}: {len(data)/1e3:.0f} KB, {v["codec_name"]} {v["width"]}x{v["height"]}, {dur:.2f}s')
            check(f'{fmt}: duration matches the clip', 3.4 <= dur <= 4.6, dur)
            check(f'{fmt}: even dimensions', v['width'] % 2 == 0 and v['height'] % 2 == 0)
            check(f'{fmt}: far smaller than the GIF', len(data) < base, (len(data), base))
            png = Path(tmp) / f'{fmt}.png'
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '1.0', '-i', str(path), '-frames:v', '1', str(png)], check=True)
            px = Image.open(png).convert('RGB').resize((8, 8))
            check(f'{fmt}: decoded frame has real content', len(px.getcolors(64) or []) > 4)
        # video fitted to a size
        ext = 'mp4' if not await pg.evaluate('document.querySelector("#vidFormat option[value=mp4]").disabled') else 'webm'
        await pg.select_option('#vidFormat', ext)
        await pg.select_option('#expTarget', '1')
        await pg.click('#btnRenderVideo')
        await pg.wait_for_function('document.getElementById("progress").hidden', timeout=120000)
        await pg.wait_for_selector(f'#results a[download$=".{ext}"]')
        data = await blob_of(pg, f'#results a[download$=".{ext}"]')
        print(f'     video fitted to 1 MB: {len(data)/1e6:.2f} MB')
        check('video: lands near/under the size target', len(data) <= 1.1e6, len(data))

    # ---- fades are honoured by the export too
    await pg.select_option('#expTarget', '0')
    await pg.evaluate("""() => { const S = __app.S; S.annos = [{ id: 901, type: 'rect', x1: 100, y1: 100, x2: 700, y2: 350, color: '#ff0000', width: 80, fill: false,
        text: '', size: 20, bg: false, block: 8, fin: 1500, fout: 0, from: -1, to: 1e12 }]; __app.touch(); }""")
    await pg.select_option('#expFps', '0')
    await pg.select_option('#gifPalette', 'global'); await pg.select_option('#gifColors', '256'); await pg.select_option('#expDiff', 'light')
    await pg.evaluate("document.getElementById('expW').value = 640; document.getElementById('expW').dispatchEvent(new Event('input'))")
    await pg.click('#btnRenderGif')
    await pg.wait_for_function('document.querySelectorAll("#results a[download$=\'.gif\']").length === 1 && !document.querySelector("#progress:not([hidden])")', timeout=120000)
    gif = await blob_of(pg, '#results a[download$=".gif"]')
    im = Image.open(io.BytesIO(gif)); im.seek(0); f0 = im.convert('RGB').getpixel((50, 110)); im.seek(im.n_frames - 1); f1 = im.convert('RGB').getpixel((50, 110))
    check('export: annotation fades in (first frame faint, last frame red)', f1[0] > 200 and f1[1] < 80 and not (f0[0] > 200 and f0[1] < 80), (f0, f1))

    # ---- cancel
    await pg.evaluate("__app.S.annos = []; __app.touch()")
    await pg.select_option('#gifPalette', 'local'); await pg.select_option('#expDiff', 'off'); await pg.select_option('#gifDither', 'full')
    await pg.click('#btnRenderGif')
    await pg.wait_for_selector('#progress:not([hidden])')
    await pg.click('#btnCancel')
    await pg.wait_for_function('document.getElementById("progress").hidden', timeout=30000)
    toast_txt = await pg.inner_text('#toast')
    check('cancel stops the export', 'cancelled' in toast_txt.lower(), toast_txt)
    check('no console errors', not [e for e in errs if 'Cancelled' not in e], errs[:3])
    await ctx.close()


async def touch_drag(cdp, x0, y0, x1, y1, steps=8):
    send = lambda t, pts: cdp.send('Input.dispatchTouchEvent', {'type': t, 'touchPoints': pts})
    await send('touchStart', [{'x': x0, 'y': y0}])
    for i in range(1, steps + 1):
        await send('touchMove', [{'x': x0 + (x1 - x0) * i / steps, 'y': y0 + (y1 - y0) * i / steps}])
        await asyncio.sleep(0.01)
    await send('touchEnd', [])


async def shot(pg, name):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        await pg.screenshot(path=str(Path(SHOTS) / f'{name}.png'))


async def t_phone(b, url, tmp):
    ctx, pg, errs = await new_page(b, url, **DEVICES['Pixel 7'])
    overflow = '() => document.documentElement.scrollWidth - window.innerWidth'
    check('empty screen: no sideways overflow', await pg.evaluate(overflow) <= 0, await pg.evaluate(overflow))
    await shot(pg, 'phone-1-empty')
    await import_video(pg, make_video(tmp, secs=2), fps='8', width=640)
    await shot(pg, 'phone-2-edit')

    for tab in ('edit', 'annotate', 'export'):
        await pg.click(f'[data-tab={tab}]')
        ov = await pg.evaluate(overflow)
        check(f'{tab} tab: no sideways overflow', ov <= 0, ov)
        small = await pg.evaluate("""() => [...document.querySelectorAll('.pane:not([hidden]) .btn, .pane:not([hidden]) select, .pane:not([hidden]) input[type=number], .tool, .tabs button, #btnPlay')]
          .filter(e => e.offsetParent && !e.closest('[hidden]')).map(e => [e.id || e.className || e.tagName, Math.round(e.getBoundingClientRect().height)]).filter(x => x[1] < 38)""")
        check(f'{tab} tab: tap targets are at least 38px tall', not small, small[:5])
        fonts = await pg.evaluate("""() => [...document.querySelectorAll('.pane:not([hidden]) select, .pane:not([hidden]) input[type=number], .pane:not([hidden]) textarea')]
          .filter(e => e.offsetParent).map(e => parseFloat(getComputedStyle(e).fontSize)).filter(f => f < 16)""")
        check(f'{tab} tab: inputs are 16px+ (no iOS zoom-on-focus)', not fonts, fonts[:3])
    await pg.click('[data-tab=edit]')

    # sticky preview while scrolling the controls
    await pg.evaluate('window.scrollTo(0, 500)')
    top = await pg.evaluate('document.querySelector(".stage-col").getBoundingClientRect().top')
    check('preview stays pinned while scrolling', abs(top) <= 1, top)
    await pg.evaluate('window.scrollTo(0, 0)')

    # finger drags on the preview
    cdp = await ctx.new_cdp_session(pg)
    await pg.click('[data-tool=crop]')
    r = await view_rect(pg)
    await touch_drag(cdp, r[0] + r[2] * .25, r[1] + r[3] * .25, r[0] + r[2] * .70, r[1] + r[3] * .70)
    c1 = await pg.evaluate('__app.S.crop')
    check('touch: dragging draws a crop', c1 is not None and c1['w'] > 150, c1)
    # grab the SE corner a few px off the exact handle, as a fingertip would
    sx = r[0] + (c1['x'] + c1['w']) * r[2] / 640 + 9
    sy = r[1] + (c1['y'] + c1['h']) * r[3] / 360 + 9
    await touch_drag(cdp, sx, sy, sx + 40, sy + 25)
    c2 = await pg.evaluate('__app.S.crop')
    check('touch: an imprecise grab still resizes the crop handle', c2['w'] > c1['w'] and c2['x'] == c1['x'], (c1, c2))
    await shot(pg, 'phone-3-crop')
    await pg.click('#cropApply')

    # tap + double-tap on the timeline (clicking Apply scrolled the page; the timeline sits under the pinned preview until we scroll back)
    await pg.evaluate('window.scrollTo(0, 0)')
    box = await pg.evaluate('(()=>{const r=document.querySelectorAll("#strip .fr")[3].getBoundingClientRect();return [r.x+r.width/2, r.y+r.height/2]})()')
    await pg.touchscreen.tap(box[0], box[1])
    check('touch: tapping a frame selects it', await pg.evaluate('__app.S.cur') == 3)
    await pg.touchscreen.tap(box[0], box[1])
    try:
        await pg.wait_for_selector('#delayDlg[open]', timeout=3000)
        opened = True
    except Exception:
        opened = False
    check('touch: double-tap opens the delay dialog', opened)
    if opened:
        await shot(pg, 'phone-4-delay')
        await pg.click('#delayDlgCancel')

    # add text by tapping, then resize with the handle by finger
    await pg.click('[data-tab=annotate]')
    await pg.click('[data-tool=text]')
    r = await view_rect(pg)
    await pg.touchscreen.tap(r[0] + r[2] * .3, r[1] + r[3] * .35)
    check('touch: tap places text', await pg.evaluate('__app.S.annos.length') == 1)
    await shot(pg, 'phone-5-annotate')
    await pg.click('[data-tab=export]')
    await shot(pg, 'phone-6-export')
    hh = await pg.evaluate('document.querySelector(".top").getBoundingClientRect().height')
    check('header fits on one row', hh < 66, hh)
    check('no console errors', not errs, errs[:3])
    await ctx.close()

    # landscape phone: usable, no overflow
    ctx, pg, errs = await new_page(b, url, **DEVICES['Pixel 7 landscape'])
    await import_video(pg, make_video(tmp, secs=1, name='l.mp4'), fps='8', width=640)
    check('landscape: no sideways overflow', await pg.evaluate(overflow) <= 0, await pg.evaluate(overflow))
    await shot(pg, 'phone-7-landscape')
    await ctx.close()


def sw_assets():
    import re
    src = (ROOT / 'sw.js').read_text()
    block = src[src.index('const ASSETS = ['):src.index('];', src.index('const ASSETS = ['))]
    return [a for a in re.findall(r"'([^']+)'", block)]


async def t_assets(b, url, tmp):
    import re
    assets = sw_assets()
    missing = [a for a in assets if a != './' and not (ROOT / a).exists()]
    check('every file in the offline list exists', not missing, missing)
    listed = {a for a in assets}
    # every module the app can load must be cached, or it will break offline
    loaded = set()
    for f in list((ROOT / 'js').glob('*.js')) + [ROOT / 'encoder-worker.js', ROOT / 'lib' / 'encoders.js', ROOT / 'lib' / 'webpmux.js']:
        for m in re.finditer(r"(?:from\s+|import\()\s*['\"](\.[^'\"]+)['\"]", f.read_text()):
            loaded.add(os.path.relpath((f.parent / m.group(1)).resolve(), ROOT))
    for f in (ROOT / 'lib' / 'gifenc').glob('*.js'):
        loaded.add(os.path.relpath(f, ROOT))
    uncached = sorted(x for x in loaded if x not in listed)
    check('every imported module is in the offline list', not uncached, uncached)
    # every named import resolves to a real export (lint alone cannot see this)
    bad = []
    for f in (ROOT / 'js').glob('*.js'):
        for m in re.finditer(r"import\s*\{([^}]*)\}\s*from\s*['\"](\.[^'\"]+)['\"]", f.read_text()):
            target = (f.parent / m.group(2)).resolve()
            if not target.exists() or 'muxers' in str(target):
                continue
            exports = target.read_text()
            for name in [n.strip().split(' as ')[0].strip() for n in m.group(1).split(',') if n.strip()]:
                if not re.search(r"export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+" + re.escape(name) + r"(?![\w$])|export\s*\{[^}]*(?<![\w$])" + re.escape(name) + r"(?![\w$])", exports):
                    bad.append(f'{f.name}: {name} from {m.group(2)}')
    check('every named import exists in its module', not bad, bad)


async def t_offline(b, url, tmp):
    """Install the service worker, cut the network, reload: the app must still run."""
    ctx, pg, errs = await new_page(b, url, service_workers='allow')
    await pg.evaluate('navigator.serviceWorker.ready.then(() => true)')
    await pg.wait_for_function('navigator.serviceWorker.controller !== null || true')
    await pg.reload()  # now controlled by the worker
    await pg.wait_for_function('navigator.serviceWorker.controller !== null', timeout=15000)
    cached = await pg.evaluate('caches.open("ssr-app-v1").then(c => c.keys()).then(k => k.length)')
    check('service worker cached the app', cached >= len(sw_assets()) - 1, (cached, len(sw_assets())))
    await ctx.set_offline(True)
    await pg.reload()
    await pg.wait_for_selector('#emptyOpen')
    await import_video(pg, make_video(tmp, secs=1), fps='5', width=480)
    check('offline: can open a video and edit', await pg.evaluate('__app.S.frames.length') >= 4)
    await pg.click('[data-tab=export]')
    await pg.click('#btnRenderGif')
    await pg.wait_for_selector('#results a[download$=".gif"]', timeout=60000)
    check('offline: can export a GIF', True)
    await pg.click('#btnRenderVideo') if await pg.evaluate('!document.getElementById("vidRow").hidden') else None
    if await pg.evaluate('!document.getElementById("vidRow").hidden'):
        await pg.wait_for_selector('#results a[download$=".mp4"], #results a[download$=".webm"]', timeout=60000)
        check('offline: can export video (lazy-loaded muxer is cached)', True)
    check('no console errors', not errs, errs[:3])
    await ctx.close()


async def t_theme(b, url, tmp):
    base = url.rsplit('/', 1)[0]
    # follows the system preference when nothing is saved
    for scheme, want_light in (('dark', False), ('light', True)):
        ctx, pg, errs = await new_page(b, url, color_scheme=scheme)
        bg = await pg.evaluate('getComputedStyle(document.body).backgroundColor')
        is_light = sum(int(x) for x in bg[bg.index('(') + 1:-1].split(',')[:3]) > 450
        check(f'auto theme follows the system ({scheme})', is_light == want_light, bg)
        await ctx.close()
    ctx, pg, errs = await new_page(b, url, color_scheme='dark')
    await import_video(pg, make_video(tmp, secs=1), fps='5', width=480)
    seen = []
    for _ in range(3):
        await pg.click('#btnTheme')
        seen.append(await pg.evaluate('document.documentElement.getAttribute("data-theme")'))
        if len(seen) == 1:
            await shot(pg, 'theme-light')
    check('toggle cycles auto -> light -> dark -> auto', seen == ['light', 'dark', None], seen)
    await pg.click('#btnTheme')  # light again
    light_bg = await pg.evaluate('getComputedStyle(document.body).backgroundColor')
    await pg.reload()
    check('forced theme survives a reload', await pg.evaluate('document.documentElement.getAttribute("data-theme")') == 'light')
    check('no flash: theme is set before scripts run', await pg.evaluate('getComputedStyle(document.body).backgroundColor') == light_bg)
    check('theme-color follows the forced theme', await pg.evaluate('[...document.querySelectorAll("meta[name=theme-color]")].every(m => m.content === "#ffffff")'))
    # contrast: text on the panel, muted text, accent text
    def lum(c):
        r = [int(x) / 255 for x in c[c.index('(') + 1:-1].split(',')[:3]]
        r = [v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4 for v in r]
        return 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2]
    async def ratio(sel_fg, sel_bg, prop='color'):
        fg = await pg.evaluate(f'getComputedStyle(document.querySelector("{sel_fg}")).{prop}')
        bgc = await pg.evaluate(f'getComputedStyle(document.querySelector("{sel_bg}")).backgroundColor')
        a, b2 = sorted([lum(fg), lum(bgc)], reverse=True)
        return (a + 0.05) / (b2 + 0.05)
    for theme in ('light', 'dark'):
        await pg.evaluate(f'document.documentElement.setAttribute("data-theme", "{theme}")')
        r1 = await ratio('.panel .hint', '.panel')
        r2 = await ratio('.tabs button.on', '.panel')
        r3 = await ratio('#btnExportTop', '#btnExportTop')
        check(f'{theme}: muted text contrast >= 4.5', r1 >= 4.5, round(r1, 2))
        check(f'{theme}: active tab contrast >= 3', r2 >= 3, round(r2, 2))
        check(f'{theme}: primary button text contrast >= 4.5', r3 >= 4.5, round(r3, 2))
        await shot(pg, f'theme-{theme}-2')
    # favicon + icon files are really served
    import urllib.request
    for path in ('favicon.ico', 'icons/icon.svg', 'icons/icon-32.png', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'):
        try:
            code = urllib.request.urlopen(f'{base}/{path}').status
        except Exception as e:
            code = str(e)
        check(f'{path} is served', code == 200, code)
    from PIL import Image
    ico = Image.open(ROOT / 'favicon.ico'); check('favicon.ico holds 16/32/48', {(16, 16), (32, 32), (48, 48)} <= set(ico.info.get('sizes', ico.ico.sizes() if hasattr(ico, 'ico') else [])), ico.info)
    check('apple-touch-icon is 180x180 and opaque', Image.open(ROOT / 'icons/apple-touch-icon.png').size == (180, 180) and Image.open(ROOT / 'icons/apple-touch-icon.png').mode == 'RGB')
    check('no console errors', not errs, errs[:3])
    await ctx.close()


TESTS = {'core': t_core, 'export': t_export, 'persist': t_persist, 'edit': t_edit, 'addclip': t_addclip, 'record': t_record, 'export2': t_export2, 'phone': t_phone, 'assets': t_assets, 'offline': t_offline, 'theme': t_theme}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    args = ap.parse_args()
    names = [n for n in args.only.split(',') if n] or list(TESTS)
    srv, url = serve()
    with tempfile.TemporaryDirectory() as tmp:
        async with async_playwright() as p:
            DEVICES.update(p.devices)
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
