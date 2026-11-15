# Converts raw.json (Playwright capture of the mounted app) into design-oracle observations.
import json, re, sys, subprocess
raw = json.load(open(sys.argv[1])); rev = sys.argv[2]
c, h = raw['cabinet'], raw['host']
px = lambda v: float(str(v).replace('px', '')) if v not in ('normal', None) else 0.0
hexc = lambda s: '#%02X%02X%02X' % tuple(int(x) for x in re.findall(r'\d+', s)[:3])
pairs = {k: v for k, v in c['pairs'].items()}
def pair(fg_rgb, bg_rgb='rgb(32, 39, 51)'):
    return {'kind': 'rendered_web', 'foreground': hexc(fg_rgb), 'background': hexc(bg_rgb), 'chars': pairs.get(f'{fg_rgb} on {bg_rgb}', 0)}
rows = c['rows']
ys = [r['y'] for r in rows]
pitch = min(b - a for a, b in zip(ys, ys[1:]) if b - a >= 10)
face = max(c['faces'], key=c['faces'].get)
# Header rhythm: title row, scope row, preference row, search box top, filter row, gallery top.
def y_of(pred):
    return next(r['y'] for r in rows if pred(r['text']))
title = y_of(lambda t: 'cabinet' in t.lower() or 'gallery' in t.lower())
scope = y_of(lambda t: 'session' in t)
pref = y_of(lambda t: 'Previews' in t)
search = y_of(lambda t: t.startswith('┌') and '01' not in t)
filt = y_of(lambda t: 'Recent' in t)
gal = y_of(lambda t: '01' in t and t.startswith('┌'))
gap = lambda a, b: b - a - pitch  # blank space between two single rows
obs = {
  'tab-vs-body': {'kind': 'rendered_web',
    'first': {'family': h['tab']['family'], 'font_size_px': px(h['tab']['size']), 'font_weight': int(h['tab']['weight'])},
    'second': {'family': c['family'], 'font_size_px': px(c['size']), 'font_weight': int(c['weight'])}},
  'mono-face': {'kind': 'rendered_web',
    'first': {'actual_face': face.split('-')[0], 'face_evidence': 'CDP CSS.getPlatformFontsForNode glyph counts: %s' % c['faces']},
    'second': {'actual_face': 'JetBrainsMono', 'face_evidence': 'policy: JetBrains Mono'}},
  'code-size': {'kind': 'rendered_web', 'numerator': px(c['size']), 'denominator': 13, 'note': 'spec code recipe is JetBrains Mono 13px/20px'},
  'line-pitch': {'kind': 'rendered_web', 'numerator': pitch, 'denominator': px(c['size']), 'note': 'measured row-to-row distance of the drawn grid, not CSS line-height (%s)' % c['lineHeight']},
  'ink': pair('rgb(200, 208, 216)'), 'heading': pair('rgb(228, 234, 238)'), 'muted': pair('rgb(143, 152, 160)'),
  'accent': pair('rgb(138, 168, 160)'), 'raised': pair('rgb(200, 208, 216)', 'rgb(39, 48, 66)'), 'lines': pair('rgb(58, 68, 88)'),
  'header-rhythm': {'kind': 'rendered_web',
    'values_px': [gap(title, scope), gap(scope, pref), gap(pref, search), gap(search + 2 * pitch, filt), gap(filt, gal)],
    'hierarchy_px': [gap(title, scope), gap(pref, search), gap(scope, pref)],
    'note': 'blank px between title→scope, scope→preference, preference→search, search→filters, filters→gallery; hierarchy = [within title group, between related controls (preference/search), between groups]'},
  'tab-track': {'kind': 'rendered_web', 'first': {'inline_start_px': h['tabText']['x'], 'inline_size_px': 0}, 'second': {'inline_start_px': h['cabX'] + rows[1]['x'], 'inline_size_px': 0}, 'note': 'tab label text start vs cabinet content text start'},
}
print(json.dumps({'source_revision': rev, 'environment': {'viewport_css_px': 1536, 'viewport_height_css_px': 1000, 'device_pixel_ratio': 1, 'zoom': 1, 'browser': 'Playwright Chromium (preinstalled)', 'route': '/projects/<seeded Headland survey>', 'preset': 'Calm light (default)', 'weights_by_chars': c['weights'], 'sizes_by_chars': c['sizes']}, 'observations': obs}, indent=1))
