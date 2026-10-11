import { createGpu, lib } from './gpu.js';

export function createScene() {
  const gpu = createGpu();
  const { gl, buffer, program, sprite } = gpu;
  const point = sprite({ position: [0, 0, 0.5] });
    const vs = `#version 300 es
    layout(location=0) in vec3 p;
    uniform mat4 vp;
    uniform float z;
    out vec3 worldPosition;
    void main() { worldPosition=vec3(p.xy,z); gl_Position=vp*vec4(worldPosition,1.0); }`;
    const fs = `#version 300 es
    precision highp float;
    in vec3 worldPosition;
    out vec4 color;
    ${lib.LIGHT_SPRITE_GLSL}
    void main(){color=vec4(lightSpriteLinearToSRGB(lightSpriteToneMap(lightSpriteShade(vec3(0.5),worldPosition,vec3(0,0,1)))),1);}`;
    const litProgram = program(vs, fs);
    const solidProgram = program(vs, `#version 300 es
    precision highp float; out vec4 color; void main(){color=vec4(0,1,0,1);}`);
    const vao = gpu.vao();
    gl.bindVertexArray(vao);
    const vertices = buffer(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0]));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const vp = lib.multiplyMatrices(lib.perspectiveMatrix(Math.PI / 3, 1, 0.1, 10), lib.lookAtMatrix([0, 0, 2], [0, 0, 0]));
    gl.viewport(0, 0, 96, 96);
    const drawSurface = (target: WebGLProgram, z: number) => {
      gl.useProgram(target);
      gl.uniformMatrix4fv(gl.getUniformLocation(target, 'vp'), false, vp);
      gl.uniform1f(gl.getUniformLocation(target, 'z'), z);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
  gl.clearColor(0, 0, 0, 1);
  gl.enable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  return { ...gpu, point, litProgram, solidProgram, vertices, vp, vs, fs, drawSurface };
}
