/** GLSL ES 3.00 sources. All geometry is supplied in world metres and mapped
 *  to clip space by the shared uCenter / uScale uniforms. */

export const COMMON_HEADER = `#version 300 es
precision highp float;
`;

const PROJECT = `
uniform vec2 uCenter;   // world position at the centre of the viewport
uniform vec2 uScale;    // clip units per world metre, per axis
uniform float uFlipY;   // +1 draws the modelled half, -1 its mirror image
vec2 project(vec2 world) {
  return (vec2(world.x, world.y * uFlipY) - uCenter) * uScale;
}
`;

/* ------------------------------------------------------------------ background */

export const BG_VS = `${COMMON_HEADER}
out vec2 vNdc;
void main() {
  // fullscreen triangle
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

export const BG_FS = `${COMMON_HEADER}
uniform vec2 uCenter;
uniform vec2 uScale;
in vec2 vNdc;
out vec4 fragColor;
uniform float uGrid;      // fine grid pitch [m]
uniform float uPxPerM;    // world metres covered by one device pixel
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uGridAlpha;

float gridLine(vec2 w, float pitch, float px) {
  vec2 g = abs(fract(w / pitch - 0.5) - 0.5) * pitch;
  vec2 f = g / px;
  return 1.0 - smoothstep(0.5, 1.5, min(f.x, f.y));
}

void main() {
  vec2 world = uCenter + vNdc / uScale;
  float t = clamp(vNdc.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uBottom, uTop, t);
  // gentle vignette
  col *= 1.0 - 0.35 * dot(vNdc, vNdc) * 0.25;

  float fine = gridLine(world, uGrid, uPxPerM);
  float coarse = gridLine(world, uGrid * 5.0, uPxPerM);
  col += uGridAlpha * (0.10 * fine + 0.20 * coarse) * vec3(0.34, 0.52, 0.74);
  fragColor = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------------ field mesh */

export const MESH_VS = `${COMMON_HEADER}
${PROJECT}
layout(location = 0) in vec2 aPos;
layout(location = 1) in float aVal;
layout(location = 2) in vec2 aRef;   // reference theta, reference radius
out float vT;
out float vTheta;
out float vRadN;
uniform vec2 uRange;
uniform vec2 uRadii;                 // inner, outer reference radius
void main() {
  vT = clamp((aVal - uRange.x) / max(uRange.y - uRange.x, 1e-12), 0.0, 1.0);
  vTheta = aRef.x;
  vRadN = (aRef.y - uRadii.x) / max(uRadii.y - uRadii.x, 1e-9);
  gl_Position = vec4(project(aPos), 0.0, 1.0);
}`;

export const MESH_FS = `${COMMON_HEADER}
in float vT;
in float vTheta;
in float vRadN;
out vec4 fragColor;
uniform sampler2D uLut;
uniform float uMarks;      // number of painted reference stripes, 0 = off
uniform float uMarkAmount;
uniform float uShade;
uniform float uPhase;      // roll rotation, so the stripes actually turn
uniform vec3 uNeutral;     // steel tint used when the field does not apply
uniform float uUseField;

void main() {
  vec3 col = mix(uNeutral, texture(uLut, vec2(vT, 0.5)).rgb, uUseField);

  // depth shading: darker towards the bonded core, slight sheen at the surface
  col *= mix(1.0 - uShade, 1.0, smoothstep(0.0, 1.0, vRadN));
  col += uShade * 0.18 * smoothstep(0.75, 1.0, vRadN);

  // Reference shading painted on the running surface, so the rotation reads
  // without drawing the eye. A hard-edged stripe strobes past at rolling speed;
  // a smooth cosine of the same frequency conveys the same motion calmly, and
  // it is confined to the outer skin so the barrel itself stays still.
  if (uMarks > 0.5 && uMarkAmount > 0.001) {
    float band = 0.5 - 0.5 * cos((vTheta - uPhase) * uMarks);
    col *= 1.0 - uMarkAmount * band * smoothstep(0.62, 1.0, vRadN);
  }
  fragColor = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------------ flat lines */

export const LINE_VS = `${COMMON_HEADER}
${PROJECT}
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(project(aPos), 0.0, 1.0); }`;

export const LINE_FS = `${COMMON_HEADER}
out vec4 fragColor;
uniform vec4 uColor;
void main() { fragColor = uColor; }`;

/* --------------------------------------------------------- thick polyline / fill */

export const RIBBON_VS = `${COMMON_HEADER}
${PROJECT}
layout(location = 0) in vec2 aPos;
layout(location = 1) in float aSide;   // -1 .. +1 across the ribbon
out float vSide;
void main() { vSide = aSide; gl_Position = vec4(project(aPos), 0.0, 1.0); }`;

export const RIBBON_FS = `${COMMON_HEADER}
in float vSide;
out vec4 fragColor;
uniform vec4 uColor;
uniform float uSoft;    // 0 = hard edge, 1 = full falloff (glow)
void main() {
  float a = mix(1.0, 1.0 - abs(vSide), uSoft);
  a = pow(clamp(a, 0.0, 1.0), mix(1.0, 2.2, uSoft));
  fragColor = vec4(uColor.rgb, uColor.a * a);
}`;

/* ------------------------------------------------------------------ rigid parts */

export const CORE_VS = `${COMMON_HEADER}
${PROJECT}
layout(location = 0) in vec2 aLocal;   // unit disc coordinates
out vec2 vLocal;
uniform vec2 uOrigin;
uniform float uRadius;
uniform float uAngle;
void main() {
  float c = cos(uAngle), s = sin(uAngle);
  vec2 r = vec2(c * aLocal.x - s * aLocal.y, s * aLocal.x + c * aLocal.y);
  vLocal = aLocal;
  gl_Position = vec4(project(uOrigin + r * uRadius), 0.0, 1.0);
}`;

export const CORE_FS = `${COMMON_HEADER}
in vec2 vLocal;
out vec4 fragColor;
uniform vec3 uTint;
void main() {
  float r = length(vLocal);
  float ang = atan(vLocal.y, vLocal.x);
  // brushed steel: radial falloff plus six machined spokes and a hub boss
  float lambert = 0.55 + 0.45 * clamp(dot(normalize(vec2(-0.5, 0.8)), vLocal), -1.0, 1.0);
  float spoke = smoothstep(0.35, 0.42, abs(fract(ang * 6.0 / 6.2831853 + 0.5) - 0.5));
  float ring = 1.0 - 0.35 * smoothstep(0.62, 0.66, r) * (1.0 - smoothstep(0.66, 0.70, r));
  float boss = smoothstep(0.30, 0.26, r);
  vec3 col = uTint * (0.18 + 0.42 * lambert);
  col *= mix(0.62, 1.0, spoke * step(0.30, r));
  col *= ring;
  col = mix(col, uTint * 0.95, boss * 0.5);
  // machined concentric turning marks
  col *= 1.0 + 0.05 * sin(r * 190.0);
  col *= 1.0 - 0.45 * smoothstep(0.90, 1.0, r);
  col += 0.10 * smoothstep(0.86, 0.995, r) * (1.0 - smoothstep(0.995, 1.0, r));
  fragColor = vec4(col, 1.0);
}`;

export const PLATEN_VS = `${COMMON_HEADER}
${PROJECT}
layout(location = 0) in vec2 aPos;
out vec2 vWorld;
void main() { vWorld = aPos; gl_Position = vec4(project(aPos), 0.0, 1.0); }`;

export const PLATEN_FS = `${COMMON_HEADER}
in vec2 vWorld;
out vec4 fragColor;
uniform float uPhase;     // travelled distance of the web [m]
uniform float uTop;       // world y of the running surface
uniform float uPitch;
uniform vec3 uColor;
void main() {
  float depth = clamp((uTop - vWorld.y) / 0.05, 0.0, 1.0);
  vec3 col = uColor * mix(1.0, 0.25, depth);
  // travelling hatch so the web speed is visible even when it is uniform
  float s = fract((vWorld.x - uPhase + vWorld.y * 0.6) / uPitch);
  float hatch = smoothstep(0.44, 0.5, s) * (1.0 - smoothstep(0.5, 0.56, s));
  col += hatch * 0.16 * (1.0 - depth) * vec3(0.6, 0.78, 1.0);
  col += 0.5 * smoothstep(0.985, 1.0, 1.0 - depth) * vec3(0.35, 0.55, 0.8);
  fragColor = vec4(col, 1.0);
}`;
