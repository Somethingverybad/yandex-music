'use strict';
/**
 * Стеклянная линза виджета на WebGL.
 *
 * Математика оптики портирована из shaders/glass.frag расширения
 * «Liquid Glass for GNOME Shell» (github.com/ryohsuke1231/liquid-glass,
 * MIT, © Ryosuke Watanabe): SDF скруглённого прямоугольника,
 * суперэллиптический профиль высоты, нормаль через конечные разности,
 * преломление по Снеллиусу с заданным IOR, хроматическая аберрация,
 * подсветка кромки и блик. Оригинал написан под Cogl-пайплайн GNOME,
 * здесь то же самое сделано на обычном WebGL.
 *
 * Конвейер кадра:
 *   1) фон (обои под окном либо обложка трека) рисуется в текстуру;
 *   2) две проходки гауссова размытия дают «замутнённый» слой;
 *   3) финальный проход преломляет оба слоя и добавляет кромку с бликом.
 */

const VERTEX_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** Фон: вырезаем участок картинки, попавший под окно. */
const BACKGROUND_SRC = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_image;
uniform vec2 u_scale;    // размер окна / размер источника
uniform vec2 u_offset;   // положение окна в источнике, в долях
void main() {
  vec2 uv = u_offset + v_uv * u_scale;
  gl_FragColor = texture2D(u_image, clamp(uv, 0.0, 1.0));
}`;

const BLUR_SRC = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_image;
uniform vec2 u_direction;   // (1/w, 0) либо (0, 1/h), умноженное на радиус
void main() {
  vec4 sum = texture2D(u_image, v_uv) * 0.2270270270;
  sum += texture2D(u_image, v_uv + u_direction * 1.3846153846) * 0.3162162162;
  sum += texture2D(u_image, v_uv - u_direction * 1.3846153846) * 0.3162162162;
  sum += texture2D(u_image, v_uv + u_direction * 3.2307692308) * 0.0702702703;
  sum += texture2D(u_image, v_uv - u_direction * 3.2307692308) * 0.0702702703;
  gl_FragColor = sum;
}`;

const GLASS_SRC = `
precision highp float;
varying vec2 v_uv;

uniform sampler2D u_sharp;
uniform sampler2D u_blur;
uniform vec2  u_res;
uniform float u_radius;        // радиус скругления, px
uniform float u_thickness;     // высота профиля стекла
uniform float u_profileN;      // степень суперэллипса
uniform float u_ior;           // показатель преломления
uniform float u_displacement;  // сила смещения
uniform float u_chroma;        // хроматическая аберрация
uniform float u_blurStrength;  // сколько подмешивать размытый слой
uniform float u_tint;
uniform vec3  u_tintColor;
uniform float u_rimWidth;
uniform float u_rimIntensity;
uniform float u_specular;
uniform float u_shininess;
uniform vec2  u_pointer;       // курсор в пикселях окна (для блика)

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + vec2(r);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
}

float profileHeight(float t) {
  float n = max(u_profileN, 1.01);
  float invT = clamp(1.0 - t, 0.0, 1.0);
  float inner = max(1.0 - pow(invT, n), 0.0);
  return pow(inner, 1.0 / n) * u_thickness;
}

float heightAt(vec2 p, vec2 b) {
  float d = sdRoundRect(p, b, u_radius);
  float smoothZone = 1.5;
  if (d > smoothZone) return 0.0;
  float t = clamp(max(-d, 0.0) / max(u_radius, 1.0), 0.0, 1.0);
  return profileHeight(t) * (1.0 - smoothstep(-smoothZone, smoothZone, d));
}

void main() {
  vec2 pixel = v_uv * u_res;
  vec2 local = pixel - u_res * 0.5;
  vec2 half_size = u_res * 0.5;

  float d = sdRoundRect(local, half_size, u_radius);

  // нормаль поверхности из градиента высоты
  float e = 1.0;
  float hR = heightAt(local + vec2(e, 0.0), half_size);
  float hL = heightAt(local - vec2(e, 0.0), half_size);
  float hB = heightAt(local + vec2(0.0, e), half_size);
  float hT = heightAt(local - vec2(0.0, e), half_size);
  vec2 grad = vec2(hR - hL, hB - hT) / (2.0 * e);
  vec3 normal = normalize(vec3(-grad.x, -grad.y, 1.0));

  // преломление по Снеллиусу
  vec2 displacement = vec2(0.0);
  if (d <= 0.0) {
    vec3 refracted = refract(vec3(0.0, 0.0, -1.0), normal, 1.0 / max(u_ior, 1.001));
    if (length(refracted) > 0.0001) {
      float safeZ = max(-refracted.z, 0.15);
      displacement = (refracted.xy / safeZ) * (u_displacement / max(min(u_res.x, u_res.y), 1.0));
      if (length(displacement) > 0.30) displacement = normalize(displacement) * 0.30;
    }
  }

  // хроматическая аберрация: каналы смещаются чуть по-разному
  vec2 uvR = clamp(v_uv + displacement * (1.0 + u_chroma), vec2(0.002), vec2(0.998));
  vec2 uvG = clamp(v_uv + displacement, vec2(0.002), vec2(0.998));
  vec2 uvB = clamp(v_uv + displacement * (1.0 - u_chroma), vec2(0.002), vec2(0.998));

  vec3 sharp = vec3(texture2D(u_sharp, uvR).r, texture2D(u_sharp, uvG).g, texture2D(u_sharp, uvB).b);
  vec3 blurred = vec3(texture2D(u_blur, uvR).r, texture2D(u_blur, uvG).g, texture2D(u_blur, uvB).b);
  vec3 color = mix(sharp, blurred, clamp(u_blurStrength, 0.0, 1.0));

  color = mix(color, u_tintColor, u_tint);

  // кромка: узкая полоса у края, куда «стекает» свет
  float rim = 1.0 - smoothstep(-u_rimWidth, 0.0, d);
  rim *= smoothstep(-u_rimWidth - 2.0, -u_rimWidth * 0.5, d);
  color += vec3(rim * u_rimIntensity);

  // блик: направленный свет сверху-слева плюс подсветка под курсором
  vec3 lightDir = normalize(vec3(-0.45, -0.75, 0.85));
  vec3 halfVec = normalize(lightDir + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(normal, halfVec), 0.0), max(u_shininess, 1.0));
  float pointerFalloff = 1.0 - smoothstep(0.0, max(u_res.x, 1.0) * 0.55, distance(pixel, u_pointer));
  color += vec3(spec * u_specular * (0.65 + 0.35 * pointerFalloff));

  // мягкая обрезка по форме панели
  float mask = 1.0 - smoothstep(-1.0, 0.5, d);
  gl_FragColor = vec4(color * mask, mask);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('шейдер не собрался: ' + log);
  }
  return shader;
}

function createProgram(gl, fragmentSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SRC));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('программа не слинковалась: ' + gl.getProgramInfoLog(program));
  }
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i += 1) {
    const name = gl.getActiveUniform(program, i).name;
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

function createTarget(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, framebuffer, width, height };
}

class GlassLens {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: true,   // позволяет снять содержимое линзы для отладки
    });
    if (!this.gl) throw new Error('WebGL недоступен');

    const gl = this.gl;
    this.programs = {
      background: createProgram(gl, BACKGROUND_SRC),
      blur: createProgram(gl, BLUR_SRC),
      glass: createProgram(gl, GLASS_SRC),
    };

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.sourceTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.targets = null;
    this.hasSource = false;
    this.pointer = [0, 0];
    this.crop = { offset: [0, 0], scale: [1, 1] };

    this.options = {
      radius: 16,
      thickness: 26,
      profileN: 2.6,
      ior: 1.42,
      displacement: 52,
      chroma: 0.14,
      blurStrength: 0.92,
      tint: 0.24,
      tintColor: [0.09, 0.09, 0.12],
      rimWidth: 6,
      rimIntensity: 0.34,
      specular: 0.62,
      shininess: 22,
    };
  }

  setOptions(patch) {
    Object.assign(this.options, patch || {});
  }

  /** Источник фона: обои или обложка. */
  setSource(image) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.hasSource = true;
  }

  /**
   * Какой участок источника лежит под окном.
   * @param {{x:number,y:number,width:number,height:number}} window — окно на экране
   * @param {{width:number,height:number}} source — размер источника в тех же единицах
   */
  setCrop(win, source) {
    const sw = source.width || 1;
    const sh = source.height || 1;
    this.crop = {
      offset: [win.x / sw, 1 - (win.y + win.height) / sh],
      scale: [win.width / sw, win.height / sh],
    };
  }

  /**
   * Кадрирование «по большей стороне»: источник вписывается в окно без
   * искажения пропорций, лишнее обрезается симметрично.
   */
  setCoverCrop(source, target, zoom = 1.15) {
    const srcAspect = source.width / Math.max(source.height, 1);
    const dstAspect = target.width / Math.max(target.height, 1);
    let cropW;
    let cropH;
    if (dstAspect > srcAspect) {
      cropW = source.width;
      cropH = source.width / dstAspect;
    } else {
      cropH = source.height;
      cropW = source.height * dstAspect;
    }
    cropW /= zoom;
    cropH /= zoom;
    const x = (source.width - cropW) / 2;
    const y = (source.height - cropH) / 2;
    this.crop = {
      offset: [x / source.width, 1 - (y + cropH) / source.height],
      scale: [cropW / source.width, cropH / source.height],
    };
  }

  setPointer(x, y) {
    this.pointer = [x, this.canvas.height / this.dpr - y];
  }

  resize(width, height) {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.targets) return;

    this.canvas.width = w;
    this.canvas.height = h;

    const gl = this.gl;
    if (this.targets) {
      for (const target of this.targets) {
        gl.deleteTexture(target.texture);
        gl.deleteFramebuffer(target.framebuffer);
      }
    }
    // Размытие считаем в половинном разрешении — быстрее и мягче
    this.targets = [
      createTarget(gl, w, h),
      createTarget(gl, Math.max(1, w >> 1), Math.max(1, h >> 1)),
      createTarget(gl, Math.max(1, w >> 1), Math.max(1, h >> 1)),
    ];
  }

  _drawQuad({ program, uniforms }, setup, target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(0, 0,
      target ? target.width : this.canvas.width,
      target ? target.height : this.canvas.height);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const attribute = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    setup(uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render() {
    if (!this.hasSource || !this.targets) return;
    const gl = this.gl;
    const [sharp, blurA, blurB] = this.targets;
    const options = this.options;

    gl.disable(gl.BLEND);

    // 1. вырезаем участок фона
    this._drawQuad(this.programs.background, (u) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
      gl.uniform1i(u.u_image, 0);
      gl.uniform2f(u.u_offset, this.crop.offset[0], this.crop.offset[1]);
      gl.uniform2f(u.u_scale, this.crop.scale[0], this.crop.scale[1]);
    }, sharp);

    // 2. два прохода размытия
    const blurRadius = 2.2;
    this._drawQuad(this.programs.blur, (u) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sharp.texture);
      gl.uniform1i(u.u_image, 0);
      gl.uniform2f(u.u_direction, blurRadius / blurA.width, 0);
    }, blurA);

    this._drawQuad(this.programs.blur, (u) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, blurA.texture);
      gl.uniform1i(u.u_image, 0);
      gl.uniform2f(u.u_direction, 0, blurRadius / blurB.height);
    }, blurB);

    // 3. стекло
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this._drawQuad(this.programs.glass, (u) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sharp.texture);
      gl.uniform1i(u.u_sharp, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, blurB.texture);
      gl.uniform1i(u.u_blur, 1);

      gl.uniform2f(u.u_res, this.canvas.width, this.canvas.height);
      gl.uniform1f(u.u_radius, options.radius * this.dpr);
      gl.uniform1f(u.u_thickness, options.thickness * this.dpr);
      gl.uniform1f(u.u_profileN, options.profileN);
      gl.uniform1f(u.u_ior, options.ior);
      gl.uniform1f(u.u_displacement, options.displacement * this.dpr);
      gl.uniform1f(u.u_chroma, options.chroma);
      gl.uniform1f(u.u_blurStrength, options.blurStrength);
      gl.uniform1f(u.u_tint, options.tint);
      gl.uniform3fv(u.u_tintColor, options.tintColor);
      gl.uniform1f(u.u_rimWidth, options.rimWidth * this.dpr);
      gl.uniform1f(u.u_rimIntensity, options.rimIntensity);
      gl.uniform1f(u.u_specular, options.specular);
      gl.uniform1f(u.u_shininess, options.shininess);
      gl.uniform2f(u.u_pointer, this.pointer[0] * this.dpr, this.pointer[1] * this.dpr);
    }, null);
  }
}

window.GlassLens = GlassLens;
