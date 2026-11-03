// Web Worker wrapper around AnimEncoder. Messages are handled strictly one at a
// time: encoding is async (WebP) and frames must stay in order.
import { AnimEncoder } from './lib/encoders.js';

const enc = new AnimEncoder();
let queue = Promise.resolve();

self.onmessage = (e) => {
  queue = queue.then(async () => {
    const { id, op, args } = e.data;
    try {
      let result;
      if (op === 'init') await enc.init(args.cfg);
      else if (op === 'sample') enc.addSample(new Uint8ClampedArray(args.buf));
      else if (op === 'palette') await enc.buildPalette();
      else if (op === 'frame') await enc.addFrame(new Uint8ClampedArray(args.buf), args.delay);
      else if (op === 'finish') result = await enc.finish();
      self.postMessage({ id, ok: true, result });
    } catch (err) {
      self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
    }
  });
};
