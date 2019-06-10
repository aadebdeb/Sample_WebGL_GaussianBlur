(function() {

  const FILL_VIEWPORT_VERTEX_SHADER_SOURCE =
`#version 300 es

out vec2 v_uv;

const vec2[4] POSITIONS = vec2[](
  vec2(-1.0, -1.0),
  vec2(1.0, -1.0),
  vec2(-1.0, 1.0),
  vec2(1.0, 1.0)
);

const int[6] INDICES = int[](
  0, 1, 2,
  3, 2, 1
);

void main(void) {
  vec2 pos = POSITIONS[INDICES[gl_VertexID]];
  v_uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`

  const RENDER_FRAGMENT_SHADER_SOURCE =
`#version 300 es

precision highp float;

out vec4 o_color;

uniform vec2 u_resolution;

bool inCircle(vec2 st, float r) {
  return length(st) < r;
}

bool inRect(vec2 st, vec2 b) {
  return step(abs(st.x), b.x) * step(abs(st.y), b.y) > 0.5;
} 

void main(void) {
  vec2 st = (2.0 * gl_FragCoord.xy - u_resolution) / min(u_resolution.x, u_resolution.y);
  vec3 c = vec3(0.0);
  c += inCircle(st - vec2(0.4, 0.4), 0.3) ? vec3(0.0, 1.0, 0.0) : vec3(0.0);
  c += inRect(st - vec2(-0.4, -0.4), vec2(0.3, 0.3)) ? vec3(1.0, 0.0, 0.0) : vec3(0.0);
  o_color = vec4(c, 1.0);
}
`;

  const COPY_FRAGMENT_SHADER_SOURCE =
`#version 300 es

precision highp float;

in vec2 v_uv;

out vec4 o_color;

uniform sampler2D u_texture;

void main(void) {
  o_color = texture(u_texture, v_uv);
}
`;

  const BLUR_FRAGMENT_SHADER_SOURCE =
`#version 300 es

precision highp float;

out vec4 o_color;

uniform sampler2D u_texture;
uniform bool u_horizontal;
uniform int u_sampleStep;

const float[5] weights = float[](0.2270270, 0.1945945, 0.1216216, 0.0540540, 0.0162162);

ivec2 clampCoord(ivec2 coord, ivec2 size) {
  return max(min(coord, size - 1), 0);
}

void main(void) {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_texture, 0);
  vec3 sum = weights[0] * texelFetch(u_texture, coord, 0).rgb;
  for (int i = 1; i < 5; i++) {
    ivec2 offset = (u_horizontal ? ivec2(i, 0) : ivec2(0, i)) * u_sampleStep;
    sum += weights[i] * texelFetch(u_texture, clampCoord(coord + offset, size), 0).rgb;
    sum += weights[i] * texelFetch(u_texture, clampCoord(coord - offset, size), 0).rgb;
  }
  o_color = vec4(sum, 1.0);
}
`;

  const createFramebuffer = function(gl, width, height) {
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return {
      framebuffer: framebuffer,
      texture: texture,
      width: width,
      height: height
    };
  };

  const stats = new Stats();
  document.body.appendChild(stats.dom);

  const parameters = {
    'apply': true,
    'reduction rate': 1,
    'blur num': 1,
    'sample step': 1,
  };

  const gui = new dat.GUI();
  gui.add(parameters, 'apply');
  gui.add(parameters, 'reduction rate', 1, 16).step(1).onChange(_ => reset());
  gui.add(parameters, 'blur num', 1, 16).step(1);
  gui.add(parameters, 'sample step', 1, 4).step(1);

  const canvas = document.getElementById('canvas');
  const resizeCanvas = function() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resizeCanvas();

  const gl = canvas.getContext('webgl2');

  const renderProgram = createProgramFromSource(gl, FILL_VIEWPORT_VERTEX_SHADER_SOURCE, RENDER_FRAGMENT_SHADER_SOURCE);
  const copyProgram = createProgramFromSource(gl, FILL_VIEWPORT_VERTEX_SHADER_SOURCE, COPY_FRAGMENT_SHADER_SOURCE);
  const blurProgram = createProgramFromSource(gl, FILL_VIEWPORT_VERTEX_SHADER_SOURCE, BLUR_FRAGMENT_SHADER_SOURCE);

  const renderUniforms = getUniformLocations(gl, renderProgram, ['u_resolution']);
  const copyUniforms = getUniformLocations(gl, copyProgram, ['u_texture']);
  const blurUniforms = getUniformLocations(gl, blurProgram, ['u_texture', 'u_horizontal', 'u_sampleStep']);

  let requestId = null;
  const reset = function() {
    if (requestId !== null) {
      cancelAnimationFrame(requestId);
      requestId = null;
    }

    const reductionRate = parameters['reduction rate'];
    const blurWidth = Math.ceil(canvas.width / reductionRate);
    const blurHeight = Math.ceil(canvas.height / reductionRate);

    const renderFbObj = createFramebuffer(gl, canvas.width, canvas.height);
    let blurFbObjR = createFramebuffer(gl, blurWidth, blurHeight);
    let blurFbObjW = createFramebuffer(gl, blurWidth, blurHeight);
    const swapBlurFbObj = function() {
      const tmp = blurFbObjR;
      blurFbObjR = blurFbObjW;
      blurFbObjW = tmp;
    };

    const renderDirectly = function() {
      gl.viewport(0.0, 0.0, canvas.width, canvas.height);
      gl.useProgram(renderProgram);
      gl.uniform2fv(renderUniforms['u_resolution'], [canvas.width, canvas.height]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    const render = function() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, renderFbObj.framebuffer);
      gl.viewport(0.0, 0.0, renderFbObj.width, renderFbObj.height);
      gl.useProgram(renderProgram);
      gl.uniform2fv(renderUniforms['u_resolution'], [renderFbObj.width, renderFbObj.height]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
  
    const renderToReductionBuffer = function() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, blurFbObjW.framebuffer);
      gl.viewport(0.0, 0.0, blurFbObjW.width, blurFbObjW.height);
      gl.useProgram(copyProgram);
      setUniformTexture(gl, 0, renderFbObj.texture, copyUniforms['u_texture']);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      swapBlurFbObj();
    };

    const applyBlur = function() {
      gl.viewport(0.0, 0.0, blurFbObjW.width, blurFbObjW.height);
      gl.useProgram(blurProgram);

      const blurNum = parameters['blur num'];
      gl.uniform1i(blurUniforms['u_sampleStep'], parameters['sample step']);
      for (let i = 0; i < blurNum; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, blurFbObjW.framebuffer);
        setUniformTexture(gl, 0, blurFbObjR.texture, blurUniforms['u_texture']);
        gl.uniform1f(blurUniforms['u_horizontal'], true);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        swapBlurFbObj();

        gl.bindFramebuffer(gl.FRAMEBUFFER, blurFbObjW.framebuffer);
        setUniformTexture(gl, 0, blurFbObjR.texture, blurUniforms['u_texture']);
        gl.uniform1f(blurUniforms['u_horizontal'], false);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        swapBlurFbObj();
      }
      
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
  
    const copyToFramebuffer = function() {
      gl.viewport(0.0, 0.0, canvas.width, canvas.height);
      gl.useProgram(copyProgram);
      setUniformTexture(gl, 0, blurFbObjR.texture, copyUniforms['u_texture']);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  
    const loop = function() {
      stats.update();
  
      if (parameters['apply']) {
        render();
        renderToReductionBuffer();
        applyBlur();
        copyToFramebuffer();
      } else {
        renderDirectly();
      }

      requestId = requestAnimationFrame(loop);
    };
    loop();
  };

  addEventListener('resize', _ => {
    resizeCanvas();
    reset();
  });


  reset();
}());