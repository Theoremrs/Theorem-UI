// SOURCING: adapted from ybouane/liquidglass (MIT, src/shaders.ts): the rounded-rect SDF, the half-circle bevel height field and its finite-difference normal, the separable 9-tap Gaussian, and Blinn-Phong light from that normal. Changed here: the panel samples a scene in CSS pixels with a margin, so refraction near the edge reads real pixels; the body and the rim mix blur, smoke and clarity separately (the library blurs the centre fully and the rim 85%); the bevel can run past chosen sides (a pane attached to the window edge); a pane can join a surface past its right side through concave fillets, with the exact distance to the arcs (the rail's tab into the navigation panel); one directional reflection, with a dimmer counterpart at the far corner, replaces four lights, swept across the pane's box or a box it shares with the pane it continues; shadow, chromatic aberration, micro-distortion and fresnel whitening are left out (elevation is CSS, on the element); the body can be clearer toward the bottom (u_bodyLow below u_split); the body can thin (u_show) over the element's own CSS backdrop blur, so the conversation shows through softened. WebGL 1 / GLSL ES 1.0.

/** A quad over the whole viewport, with UVs from its bottom-left corner. */
export const VS_QUAD = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

/** Copies a texture, resampling it to the target's size. */
export const FS_COPY = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}`

/** One direction of a 9-tap Gaussian (sigma about 1.7 taps). */
export const FS_BLUR = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_dir;
varying vec2 v_uv;
void main() {
  vec4 s = texture2D(u_tex, v_uv) * 0.227027;
  s += texture2D(u_tex, v_uv + u_dir) * 0.194594;
  s += texture2D(u_tex, v_uv - u_dir) * 0.194594;
  s += texture2D(u_tex, v_uv + u_dir * 2.0) * 0.121622;
  s += texture2D(u_tex, v_uv - u_dir * 2.0) * 0.121622;
  s += texture2D(u_tex, v_uv + u_dir * 3.0) * 0.054054;
  s += texture2D(u_tex, v_uv - u_dir * 3.0) * 0.054054;
  s += texture2D(u_tex, v_uv + u_dir * 4.0) * 0.016216;
  s += texture2D(u_tex, v_uv - u_dir * 4.0) * 0.016216;
  gl_FragColor = s;
}`

/**
 * The pane. Distances are CSS pixels, y down, from the pane's centre.
 *
 * The body is where you read and type: the blurred scene, pulled toward the
 * pane's tone by u_body, so bright and dark behind it settle near one value.
 * The rim is where it reads as glass: across u_bevel the surface curves,
 * the scene from just past the edge bends in by up to u_refract, the sharp scene shows through
 * by up to u_clarity, and the tone pull eases to u_rimBody. Light comes from
 * the top left: a narrow reflection where the curve faces it, strongest at the near corner, with a dimmer one at the far corner (u_light), a
 * broad sheen over the same curve (u_sheen), and a hairline contour that is
 * lit on that side (u_stroke) and shaded on the other (u_shade).
 *
 * Across the body the pane thins by u_show, so the browser's own blur of
 * what lies behind, conversation included, shows through it.
 */
export const FS_GLASS = `
precision highp float;

uniform sampler2D u_scene;
uniform sampler2D u_blur;
uniform vec2 u_size;
uniform vec2 u_sceneSize;
uniform float u_margin;
uniform float u_radius;
uniform vec4 u_extend;
// The box the light sweeps across: centre offset and half size, CSS pixels.
uniform vec4 u_lightBox;
// Concave fillets above and below the right side, where the pane joins a
// surface that runs on past it (0 where there is none).
uniform vec2 u_fillet;
uniform float u_px;

uniform float u_bevel;
uniform float u_refract;
uniform float u_clarity;
uniform vec3 u_tone;
uniform float u_body;
uniform float u_bodyLow;
uniform float u_split;
uniform float u_rimBody;
uniform float u_lift;
uniform float u_saturate;
uniform float u_light;
uniform float u_sheen;
uniform float u_stroke;
uniform float u_shade;
uniform float u_show;

varying vec2 v_uv;

float rrSDF(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + vec2(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

// A half-circle profile: flat across the body, steepest at the very edge.
float bevelHeight(float d, float z) {
  if (d <= 0.0) return 0.0;
  if (d >= z) return z;
  return sqrt(d * (2.0 * z - d));
}

// Distance from a fillet's arc (centre o, radius f, a quarter turning from
// the pane's edge, below o, round to the joined surface's side, right of o),
// or from its end on that side, for a point past where it begins.
float arcDistance(vec2 p, vec2 o, float f, float side) {
  bool facing = side < 0.0 ? p.y >= o.y : p.y <= o.y;
  return facing ? abs(length(p - o) - f) : length(p - vec2(o.x + f, o.y));
}

// The pane's outline: x is how far inside it a point is (negative outside),
// y is 1 where its nearest edge is a fillet. Without fillets it is the
// rounded rect, carried past the sides left out. With them (the rail's tab
// joining the navigation panel) the fillets lie inside the pane's box, so
// the rect is inset by them; its top and bottom edges stop where they begin,
// and the joined surface's side, past the pane's right edge, is no edge.
vec2 outline(vec2 local, vec2 half_) {
  vec2 inner = half_ - vec2(0.0, 0.5 * (u_fillet.x + u_fillet.y));
  vec2 lo = -inner - u_extend.xy;
  vec2 hi = inner + u_extend.zw;
  vec2 c = (lo + hi) * 0.5 + vec2(0.0, 0.5 * (u_fillet.x - u_fillet.y));
  vec2 b = (hi - lo) * 0.5;
  float r = min(u_radius, min(inner.x, inner.y));
  float own = -rrSDF(local - c, b, r);
  if (u_fillet.x <= 0.0 && u_fillet.y <= 0.0) return vec2(own, 0.0);

  float top = -half_.y + u_fillet.x;
  float bottom = half_.y - u_fillet.y;
  float d = abs(own);
  float arc = 0.0;
  bool shape = own > 0.0 && local.x <= half_.x;
  // Past where a fillet begins, its edge of the rect is gone.
  float edgeTop = abs(local.y - top);
  float edgeBottom = abs(local.y - bottom);
  float start = half_.x - max(u_fillet.x, u_fillet.y);
  if (local.x > start) {
    if (u_fillet.x > 0.0 && local.x > half_.x - u_fillet.x) {
      float f = u_fillet.x;
      vec2 o = vec2(half_.x - f, top - f);
      edgeTop = arcDistance(local, o, f, -1.0);
      shape = shape || (local.y >= o.y && local.y < top && local.x <= half_.x && length(local - o) > f);
    }
    if (u_fillet.y > 0.0 && local.x > half_.x - u_fillet.y) {
      float f = u_fillet.y;
      vec2 o = vec2(half_.x - f, bottom + f);
      edgeBottom = arcDistance(local, o, f, 1.0);
      shape = shape || (local.y <= o.y && local.y > bottom && local.x <= half_.x && length(local - o) > f);
    }
    d = min(edgeTop, edgeBottom);
    bool nearTop = edgeTop <= edgeBottom;
    arc = (nearTop ? u_fillet.x : u_fillet.y) > 0.0 ? 1.0 : 0.0;
  }
  return vec2(shape ? d : -d, arc);
}

void main() {
  vec2 half_ = u_size * 0.5;
  vec2 local = vec2(v_uv.x - 0.5, 0.5 - v_uv.y) * u_size;

  vec2 shape = outline(local, half_);
  float inside = shape.x;
  float mask = clamp(inside / u_px + 0.5, 0.0, 1.0);

  float e = 1.0;
  // A joined pane runs on into the surface past its right side, so a
  // neighbour sampled past that side reads the pane's own last column
  // instead of the outside, which would bend and dim that column.
  float joinedRight = u_fillet.x > 0.0 || u_fillet.y > 0.0 ? half_.x : 1e9;
  float dR = outline(vec2(min(local.x + e, joinedRight), local.y), half_).x;
  float dL = outline(local - vec2(e, 0.0), half_).x;
  float dD = outline(local + vec2(0.0, e), half_).x;
  float dU = outline(local - vec2(0.0, e), half_).x;
  float z = max(u_bevel, 1.0);
  vec2 slope = vec2(
    bevelHeight(dR, z) - bevelHeight(dL, z),
    bevelHeight(dD, z) - bevelHeight(dU, z)
  ) / (2.0 * e);
  // Outward and up: the surface's normal, tilting out toward the edge.
  vec3 N = normalize(vec3(-slope, 1.0));
  vec2 outward = normalize(vec2(dL - dR, dU - dD) + vec2(1e-5));

  // 1 at the edge, 0 where the body begins.
  float t = clamp(inside / z, 0.0, 1.0);
  float rim = (1.0 - t) * (1.0 - t);

  // What lies behind, bent where the surface curves: the rim gathers in
  // what lies just past the edge, as a convex edge does.
  vec2 at = local + N.xy * u_refract;
  vec2 uv = (at + half_ + u_margin) / u_sceneSize;
  uv.y = 1.0 - uv.y;
  vec3 sharp = texture2D(u_scene, uv).rgb;
  vec3 soft = texture2D(u_blur, uv).rgb;
  vec3 col = mix(soft, sharp, rim * u_clarity);

  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, u_saturate);
  // The body can be clearer low on the pane: it eases from u_body to
  // u_bodyLow across a band around u_split (0 top, 1 bottom).
  float down = clamp((local.y + half_.y) / u_size.y, 0.0, 1.0);
  float body = mix(u_body, u_bodyLow, smoothstep(u_split - 0.1, u_split + 0.1, down));
  col = mix(col, u_tone, mix(body, u_rimBody, rim));
  col += u_lift;

  vec3 L = normalize(vec3(-0.42, -0.78, 0.62));
  vec2 toward = normalize(L.xy);
  // Where on the pane the light falls: 1 at the corner facing it, -1 at
  // the far corner. A straight edge has one normal along its length, so
  // without this the reflection would run the whole edge evenly.
  vec2 q = clamp((local - u_lightBox.xy) / u_lightBox.zw, -1.0, 1.0);
  float sweep = dot(q, toward) / (abs(toward.x) + abs(toward.y));
  float near = clamp(sweep, 0.0, 1.0);
  float far = clamp(-sweep, 0.0, 1.0);

  float lit = dot(outward, toward);

  // The reflection rides the steep outer part of the curve where it faces
  // the light, brightest toward the near corner; a dimmer return where the
  // light leaves through the far side. The broad sheen lifts the whole
  // curve on the lit side.
  float steep = rim * rim * rim;
  col += u_light * steep * smoothstep(0.0, 1.0, lit) * (0.2 + 0.8 * near * near);
  col += u_light * 0.35 * steep * smoothstep(0.0, 1.0, -lit) * far * far;
  col += max(dot(N, L) - L.z, 0.0) * u_sheen;

  float contour = 1.0 - smoothstep(0.0, 1.0 + u_px, inside);
  col += contour * u_stroke * (0.3 + 0.7 * smoothstep(-0.2, 1.0, lit));
  col *= 1.0 - contour * u_shade * smoothstep(-0.1, 1.0, -lit);

  // Across the body the pane thins by u_show, so what the browser's own
  // backdrop blur sees, the conversation with the field, comes through
  // softened; toward the edge it closes, and the rim is all the pane's.
  // A fillet's bevel and lines fade as it turns up into the surface it
  // joins, whose side is no edge, so the two meet as one surface.
  float join = shape.y * smoothstep(
    half_.x - max(u_fillet.x, u_fillet.y), half_.x, local.x
  );
  if (join > 0.0) {
    vec2 plain = (local + half_ + u_margin) / u_sceneSize;
    plain.y = 1.0 - plain.y;
    vec3 flat_ = texture2D(u_blur, plain).rgb;
    flat_ = mix(vec3(dot(flat_, vec3(0.2126, 0.7152, 0.0722))), flat_, u_saturate);
    flat_ = mix(flat_, u_tone, body) + u_lift;
    col = mix(col, flat_, join);
  }

  float alpha = mask * (1.0 - u_show * (1.0 - rim) * (1.0 - contour));
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), alpha);
}`
