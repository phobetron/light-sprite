import type { Page } from 'playwright';

export async function readScene(page: Page) {
  return page.evaluate(async () => {
    // The host's redraw callback and the readback run in the same animation frame.
    window.dispatchEvent(new Event('resize'));
    return new Promise<{ luminance: number; red: number; white: number; checksum: number; width: number; height: number; error: number }>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for a scene frame')), 5000);
      requestAnimationFrame(() => {
        const target = document.querySelector<HTMLCanvasElement>('#scene');
        if (!target) throw new Error('Scene canvas is unavailable');
        const gl = target.getContext('webgl2');
        if (!gl) throw new Error('WebGL 2 is unavailable');
        const data = new Uint8Array(target.width * target.height * 4);
        gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        let luminance = 0;
        let red = 0;
        let white = 0;
        let checksum = 0;
        for (let i = 0; i < data.length; i += 4) {
          luminance += data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
          if (data[i] > data[i + 1] * 2 && data[i] > data[i + 2] * 2 && data[i] > 60) red++;
          if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) white++;
          checksum = (checksum + data[i] * ((i / 4) % 251 + 1) + data[i + 1] * 3 + data[i + 2] * 7) % 2147483647;
        }
        clearTimeout(timeout);
        resolveReady({ luminance, red, white, checksum, width: target.width, height: target.height, error: gl.getError() });
      });
    });
  });
}

export const setRange = (page: Page, label: string, value: string) => page.getByLabel(label, { exact: true }).evaluate((input, next) => {
  if (!(input instanceof HTMLInputElement)) throw new Error('Range control is not an input');
  input.value = next;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
