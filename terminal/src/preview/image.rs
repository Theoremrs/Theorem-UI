//! The bounded raster path: an already decoded, oriented sRGB RGBA image to
//! a fitted indexed raster (procedural-pixel-previews.md §5).
//!
//! Decoding, EXIF orientation and ICC conversion to sRGB happen before this,
//! at the browser's decode boundary (`createImageBitmap` with
//! `imageOrientation: 'from-image'` and `colorSpaceConversion: 'default'`).
//! Here: validate bounds, fit by contain with a declared rounding rule,
//! reduce with a triangle filter over linear-light premultiplied RGBA,
//! compose partial alpha over the reference matte in linear light, then map
//! each pixel to the nearest reference colour in Oklab. No dithering.

use super::palette::{self, ix};
use super::raster::Raster;
use super::{Limitation, PreviewError};

/// The worker defaults from preview-profiles.json.
pub const MAX_WIDTH: u32 = 4096;
pub const MAX_HEIGHT: u32 = 4096;
pub const MAX_PIXELS: u64 = 4_194_304;

/// Output size for a `w × h` source contained in `bw × bh`:
/// s = min(bw/W, bh/H), size = max(1, min(bound, round(W·s))), rounding half
/// away from zero (`f64::round`).
pub fn fit(w: u32, h: u32, bw: u32, bh: u32) -> (u32, u32) {
    let s = (f64::from(bw) / f64::from(w)).min(f64::from(bh) / f64::from(h));
    let rw = ((f64::from(w) * s).round() as u32).clamp(1, bw);
    let rh = ((f64::from(h) * s).round() as u32).clamp(1, bh);
    (rw, rh)
}

/// Checks an image's declared size before anything is allocated for it.
pub fn check_bounds(w: u32, h: u32, bytes: usize) -> Result<(), PreviewError> {
    if w == 0 || h == 0 {
        return Err(PreviewError::Malformed("image has no pixels".into()));
    }
    if w > MAX_WIDTH || h > MAX_HEIGHT || u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err(PreviewError::TooLarge(format!(
            "{w}×{h} is over the {MAX_WIDTH}×{MAX_HEIGHT} / {MAX_PIXELS}-pixel decode limit"
        )));
    }
    if bytes != w as usize * h as usize * 4 {
        return Err(PreviewError::Malformed(format!(
            "{bytes} bytes is not {w}×{h} RGBA"
        )));
    }
    Ok(())
}

/// Triangle-filter weights from `src` samples onto `dst` samples, the
/// footprint widened by the scale when reducing (as `image`'s resizer does).
fn weights(src: u32, dst: u32) -> Vec<(usize, Vec<f32>)> {
    let ratio = src as f32 / dst as f32;
    let scale = ratio.max(1.0);
    let support = scale; // triangle radius 1, scaled
    (0..dst)
        .map(|o| {
            let centre = (o as f32 + 0.5) * ratio;
            let left = ((centre - support).floor() as i64).max(0) as usize;
            let right = ((centre + support).ceil() as i64).min(src as i64) as usize;
            let mut ws: Vec<f32> = (left..right)
                .map(|i| {
                    let d = (i as f32 + 0.5 - centre) / scale;
                    (1.0 - d.abs()).max(0.0)
                })
                .collect();
            let sum: f32 = ws.iter().sum();
            if sum > 0.0 {
                for w in &mut ws {
                    *w /= sum;
                }
            } else {
                // A footprint between samples: take the nearest one.
                let n = (centre.floor() as usize).min(src as usize - 1);
                return (n, vec![1.0]);
            }
            (left, ws)
        })
        .collect()
}

/// Reduces `rgba` (`w × h`, sRGB, straight alpha) to `rw × rh` linear-light
/// premultiplied RGBA.
fn reduce(rgba: &[u8], w: u32, h: u32, rw: u32, rh: u32) -> Vec<[f32; 4]> {
    let lut = palette::linear_lut();
    let src: Vec<[f32; 4]> = rgba
        .chunks_exact(4)
        .map(|p| {
            let a = f32::from(p[3]) / 255.0;
            [
                lut[p[0] as usize] * a,
                lut[p[1] as usize] * a,
                lut[p[2] as usize] * a,
                a,
            ]
        })
        .collect();
    let wx = weights(w, rw);
    let mut horizontal = vec![[0.0f32; 4]; rw as usize * h as usize];
    for y in 0..h as usize {
        for (ox, (start, ws)) in wx.iter().enumerate() {
            let mut acc = [0.0f32; 4];
            for (k, wgt) in ws.iter().enumerate() {
                let p = src[y * w as usize + start + k];
                for c in 0..4 {
                    acc[c] += p[c] * wgt;
                }
            }
            horizontal[y * rw as usize + ox] = acc;
        }
    }
    let wy = weights(h, rh);
    let mut out = vec![[0.0f32; 4]; rw as usize * rh as usize];
    for (oy, (start, ws)) in wy.iter().enumerate() {
        for x in 0..rw as usize {
            let mut acc = [0.0f32; 4];
            for (k, wgt) in ws.iter().enumerate() {
                let p = horizontal[(start + k) * rw as usize + x];
                for c in 0..4 {
                    acc[c] += p[c] * wgt;
                }
            }
            out[oy * rw as usize + x] = acc;
        }
    }
    out
}

/// What the image recipe produced, before it is framed on the artboard.
pub struct Reduced {
    pub raster: Raster,
    pub limitation: Option<Limitation>,
}

/// The whole raster path for one image into a `bw × bh` content box.
/// Existing pixel art (`pixel_art`, from an exact provider/user hint only)
/// keeps its grid: nearest-neighbour sampling at an integer factor.
pub fn convert(
    rgba: &[u8],
    w: u32,
    h: u32,
    bw: u32,
    bh: u32,
    pixel_art: bool,
) -> Result<Reduced, PreviewError> {
    check_bounds(w, h, rgba.len())?;
    let lab = palette::reference_oklab();
    let lut = palette::linear_lut();
    let matte = palette::REFERENCE[ix::BLACK as usize].1;
    let matte = [
        lut[matte[0] as usize],
        lut[matte[1] as usize],
        lut[matte[2] as usize],
    ];
    if pixel_art {
        // The largest integer step that fits; never upsampled past 1:1.
        let step = w.div_ceil(bw).max(h.div_ceil(bh)).max(1);
        let (rw, rh) = (w / step, h / step);
        let mut raster = Raster::new(rw.max(1) as u16, rh.max(1) as u16, ix::BLACK);
        for y in 0..rh {
            for x in 0..rw {
                let i = ((y * step) * w + x * step) as usize * 4;
                let a = f32::from(rgba[i + 3]) / 255.0;
                let c = [
                    lut[rgba[i] as usize] * a + matte[0] * (1.0 - a),
                    lut[rgba[i + 1] as usize] * a + matte[1] * (1.0 - a),
                    lut[rgba[i + 2] as usize] * a + matte[2] * (1.0 - a),
                ];
                raster.set(x as i32, y as i32, palette::nearest(palette::oklab(c), &lab));
            }
        }
        return Ok(Reduced { raster, limitation: None });
    }
    let (rw, rh) = fit(w, h, bw, bh);
    let reduced = reduce(rgba, w, h, rw, rh);
    let mut raster = Raster::new(rw as u16, rh as u16, ix::BLACK);
    for (i, p) in reduced.iter().enumerate() {
        // Premultiplied colour over the matte: c + matte·(1 − a).
        let a = p[3].clamp(0.0, 1.0);
        let c = [
            p[0] + matte[0] * (1.0 - a),
            p[1] + matte[1] * (1.0 - a),
            p[2] + matte[2] * (1.0 - a),
        ];
        let x = (i % rw as usize) as i32;
        let y = (i / rw as usize) as i32;
        raster.set(x, y, palette::nearest(palette::oklab(c), &lab));
    }
    let limitation = (raster.colours() <= 2).then(|| Limitation {
        code: "low_palette_coverage".into(),
        detail: "The image reduced to one or two reference colours; open the original for its detail.".into(),
    });
    Ok(Reduced { raster, limitation })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_contains_without_stretch() {
        assert_eq!(fit(1000, 625, 96, 60), (96, 60));
        assert_eq!(fit(600, 900, 96, 60), (40, 60)); // portrait, not cropped
        assert_eq!(fit(4000, 500, 96, 60), (96, 12)); // panorama
        assert_eq!(fit(1, 1, 96, 60), (60, 60));
        assert_eq!(fit(10_000, 1, 96, 60), (96, 1));
    }

    #[test]
    fn rejects_before_allocating() {
        assert!(matches!(check_bounds(5000, 10, 200_000), Err(PreviewError::TooLarge(_))));
        assert!(matches!(check_bounds(3000, 3000, 36_000_000), Err(PreviewError::TooLarge(_))));
        assert!(matches!(check_bounds(4, 4, 10), Err(PreviewError::Malformed(_))));
        assert!(matches!(check_bounds(0, 4, 0), Err(PreviewError::Malformed(_))));
    }

    #[test]
    fn transparent_pixels_take_the_matte_without_halo() {
        // A white square on fully transparent red: hidden red must not bleed.
        let (w, h) = (32u32, 32u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                if (8..24).contains(&x) && (8..24).contains(&y) {
                    rgba[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
                } else {
                    rgba[i..i + 4].copy_from_slice(&[255, 0, 0, 0]);
                }
            }
        }
        let out = convert(&rgba, w, h, 16, 16, false).unwrap().raster;
        let reds = [ix::RED_200, ix::RED, ix::RED_700, ix::MAGENTA, ix::ORANGE];
        assert!(out.indices.iter().all(|i| !reds.contains(i)), "{:?}", out.indices);
        assert_eq!(out.get(0, 0), Some(ix::BLACK));
        assert_eq!(out.get(8, 8), Some(ix::PAPER));
    }

    #[test]
    fn deterministic() {
        let rgba: Vec<u8> = (0..(64 * 40 * 4)).map(|i| ((i * 37) % 251) as u8).collect();
        let a = convert(&rgba, 64, 40, 96, 60, false).unwrap().raster;
        let b = convert(&rgba, 64, 40, 96, 60, false).unwrap().raster;
        assert_eq!(a, b);
    }

    #[test]
    fn pixel_art_keeps_its_grid() {
        // A 4×2 checker repeated, 16×8 source: stays 16×8, colours exact.
        let mut rgba = Vec::new();
        for y in 0..8 {
            for x in 0..16 {
                let on = (x + y) % 2 == 0;
                rgba.extend_from_slice(if on { &[0xD1, 0x4D, 0x41, 255] } else { &[0x10, 0x0F, 0x0F, 255] });
            }
        }
        let out = convert(&rgba, 16, 8, 96, 60, true).unwrap().raster;
        assert_eq!((out.width, out.height), (16, 8));
        assert_eq!(out.get(0, 0), Some(ix::RED));
        assert_eq!(out.get(1, 0), Some(ix::BLACK));
    }
}
