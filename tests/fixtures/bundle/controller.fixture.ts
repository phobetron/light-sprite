import { createLightSprite } from 'light-sprite';

// Keep the consumer result observable so production optimizers retain the API.
const host = globalThis as typeof globalThis & { gl: WebGL2RenderingContext; sprite?: ReturnType<typeof createLightSprite> };
host.sprite = createLightSprite(host.gl);
