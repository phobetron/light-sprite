import assert from 'node:assert/strict';
import { test } from '../support/browser-fixture';
import { readScene, setRange } from '../support/demo';

test('Demo illumination and shadow controls change pixels while preserving the marker', async ({ demoPage: page }) => {
  assert.equal(await page.title(), 'Light Sprite — a point of light');
  const lit = await readScene(page);
  assert.equal(lit.error, 0, 'Host rendering is free of WebGL errors');
  assert.ok(lit.red > 500, 'A vibrant red consumer cylinder is rendered');
  assert.ok(lit.white > 4, 'The small white sphere is visible');
  await page.getByLabel('Shadows', { exact: true }).uncheck();
  const withoutShadows = await readScene(page);
  assert.ok(withoutShadows.luminance > lit.luminance * 1.005, 'Cylinder shadows measurably reduce illumination on consumer surfaces');
  assert.equal(withoutShadows.white, lit.white, 'Shadow comparison leaves the marker unchanged');
  await page.getByLabel('Shadows', { exact: true }).check();
  await page.getByLabel('Marker light', { exact: true }).uncheck();
  const unlit = await readScene(page);
  assert.ok(lit.luminance > unlit.luminance * 1.15, 'The source measurably illuminates consumer surfaces');
  assert.ok(unlit.white > 4, 'Disabling illumination leaves the marker visible');
  await page.getByLabel('Marker light', { exact: true }).check();
});

test('Mouse orbit and reset restore the original scene', async ({ demoPage: page }) => {
  const canvas = page.locator('#scene');
  const lit = await readScene(page);
  const box = await canvas.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 130, box.y + box.height / 2 - 35, { steps: 8 });
  await page.mouse.up();
  const orbited = await readScene(page);
  assert.notEqual(orbited.checksum, lit.checksum, 'Mouse dragging rotates the view');
  await page.getByRole('button', { name: 'Reset view', exact: true }).click();

  assert.equal((await readScene(page)).checksum, lit.checksum, 'Reset restores the original view');
});

test('Keyboard arrows orbit the focused canvas', async ({ demoPage: page }) => {
  const canvas = page.locator('#scene');
  const lit = await readScene(page);
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  assert.notEqual((await readScene(page)).checksum, lit.checksum, 'Keyboard orbit works');
  await page.getByRole('button', { name: 'Reset view', exact: true }).click();
});

test('Touch dragging orbits the scene', async ({ demoPage: page }) => {
  const canvas = page.locator('#scene');
  const lit = await readScene(page);
  const box = await canvas.boundingBox();
  assert.ok(box);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const touch = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touch.x - 100, y: touch.y + 25 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.notEqual((await readScene(page)).checksum, lit.checksum, 'A real touch drag rotates the view');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.detach();
  await page.getByRole('button', { name: 'Reset view', exact: true }).click();
});

test('Demo rendering recovers after context loss', async ({ demoPage: page }) => {
  const lit = await readScene(page);
  await page.evaluate(async () => {
    const target = document.querySelector<HTMLCanvasElement>('#scene');
    if (!target) throw new Error('Scene canvas is unavailable');
      const gl = target.getContext('webgl2');
      if (!gl) throw new Error('WebGL 2 is unavailable');
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Context loss test extension is unavailable');
    const waitForEvent = (name: string) => new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 5000);
      target.addEventListener(name, () => { clearTimeout(timeout); done(); }, { once: true });
    });
    const lost = waitForEvent('webglcontextlost');
    extension.loseContext();
    await lost;
    await new Promise<void>(done => setTimeout(done, 100));
    const restored = waitForEvent('webglcontextrestored');
    extension.restoreContext();
    await restored;
  });
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === '');
  assert.equal((await readScene(page)).checksum, lit.checksum, 'Host and marker recover after context loss');
});

test('Movement, glow, and flicker controls update rendering and schedule frames', async ({ demoPage: page }) => {
  const lit = await readScene(page);
  await page.getByLabel('Glow', { exact: true }).uncheck();
  const noGlow = await readScene(page);
  assert.ok(noGlow.luminance < lit.luminance, 'Glow toggle removes halo light from the image');
  await page.getByLabel('Glow', { exact: true }).check();
  await page.getByText('Effect settings', { exact: true }).click();
  await page.getByLabel('Movement', { exact: true }).check();
  await setRange(page, 'Movement pace', '2');
  await setRange(page, 'Speed variation (%)', '30');
  await setRange(page, 'Stop chance (%)', '50');
  assert.equal(await page.locator('#movement-speed-value').textContent(), '2.00×', 'Movement UI uses a relative pace');
  assert.equal(await page.locator('#movement-variation-value').textContent(), '30%', 'Speed variation UI updates');
  assert.equal(await page.locator('#movement-stops-value').textContent(), '50%', 'Stop chance UI updates');
  const beforeMovement = await readScene(page);
  await page.waitForTimeout(300);
  assert.notEqual((await readScene(page)).checksum, beforeMovement.checksum, 'The host schedules movement frames and updates illumination');
  await page.getByLabel('Movement', { exact: true }).uncheck();
  assert.equal(await page.getByLabel('Movement pace', { exact: true }).isDisabled(), true, 'Paused motion disables pace controls');
  await page.getByRole('button', { name: 'Reset marker', exact: true }).click();
  assert.equal((await readScene(page)).checksum, lit.checksum, 'Pausing and resetting the marker restores the initial scene');
  await setRange(page, 'Glow radius (cm)', '50');
  assert.ok((await readScene(page)).luminance > lit.luminance, 'Glow radius control changes the rendered halo');
  await setRange(page, 'Glow radius (cm)', '25');
  await page.getByLabel('Flicker', { exact: true }).check();
  await setRange(page, 'Flicker strength (%)', '80');
  await setRange(page, 'Flicker speed (changes/s)', '4');
  const animated = await readScene(page);
  let varied = false;
  for (let sample = 0; sample < 12; sample++) {
    await page.waitForTimeout(100);
    if ((await readScene(page)).checksum !== animated.checksum) { varied = true; break; }
  }
  assert.ok(varied, 'The host schedules continuing frames for flicker');
  await page.getByLabel('Flicker', { exact: true }).uncheck();
  assert.equal((await readScene(page)).checksum, lit.checksum, 'Disabling flicker restores steady lighting, marker, and halo');
});

test('The scene redraws at a narrow viewport', async ({ demoPage: page }) => {
  const lit = await readScene(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await readScene(page);
  assert.ok(narrow.width > 0 && narrow.width < lit.width && narrow.white > 0, 'Responsive canvas redraws at a narrow viewport');
});

