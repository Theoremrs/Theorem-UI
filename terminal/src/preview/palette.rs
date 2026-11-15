//! The fixed reference illustration palette and the colour arithmetic the
//! converter uses: sRGB transfer, Oklab, and nearest-colour mapping.
//!
//! The palette is `flexoki-illustration-reference-32` version 1 from
//! docs/plans/artifact-cabinet/preview-profiles.json: Flexoki's neutral ramp
//! and three values from each of its eight chromatic families (Flexoki is MIT,
//! © Steph Ango; see THIRD-PARTY-NOTICES.txt in that bundle). Indices into it
//! are what a preview stores; the page maps each index through the active
//! terminal theme's illustration palette when it draws, so a theme change
//! never moves a pixel.
//!
//! Oklab is Björn Ottosson's (https://bottosson.github.io/posts/oklab/), with
//! his published M1/M2 matrices for linear sRGB.

/// `flexoki-illustration-reference-32`, version 1, in index order.
pub const PALETTE_ID: &str = "flexoki-illustration-reference-32";
pub const PALETTE_VERSION: u32 = 1;

pub const REFERENCE: [(&str, [u8; 3]); 32] = [
    ("black", [0x10, 0x0F, 0x0F]),
    ("base-950", [0x1C, 0x1B, 0x1A]),
    ("base-800", [0x40, 0x3E, 0x3C]),
    ("base-600", [0x6F, 0x6E, 0x69]),
    ("base-400", [0x9F, 0x9D, 0x96]),
    ("base-200", [0xCE, 0xCD, 0xC3]),
    ("base-50", [0xF2, 0xF0, 0xE5]),
    ("paper", [0xFF, 0xFC, 0xF0]),
    ("red-200", [0xF8, 0x9A, 0x8A]),
    ("red-400", [0xD1, 0x4D, 0x41]),
    ("red-700", [0x94, 0x28, 0x22]),
    ("orange-200", [0xF9, 0xAE, 0x77]),
    ("orange-400", [0xDA, 0x70, 0x2C]),
    ("orange-700", [0x9D, 0x43, 0x10]),
    ("yellow-200", [0xEC, 0xCB, 0x60]),
    ("yellow-400", [0xD0, 0xA2, 0x15]),
    ("yellow-700", [0x8E, 0x6B, 0x01]),
    ("green-200", [0xBE, 0xC9, 0x7E]),
    ("green-400", [0x87, 0x9A, 0x39]),
    ("green-700", [0x53, 0x69, 0x07]),
    ("cyan-200", [0x87, 0xD3, 0xC3]),
    ("cyan-400", [0x3A, 0xA9, 0x9F]),
    ("cyan-700", [0x1C, 0x6C, 0x66]),
    ("blue-200", [0x92, 0xBF, 0xDB]),
    ("blue-400", [0x43, 0x85, 0xBE]),
    ("blue-700", [0x1A, 0x4F, 0x8C]),
    ("purple-200", [0xC4, 0xB9, 0xE0]),
    ("purple-400", [0x8B, 0x7E, 0xC8]),
    ("purple-700", [0x4F, 0x36, 0x85]),
    ("magenta-200", [0xF4, 0xA4, 0xC2]),
    ("magenta-400", [0xCE, 0x5D, 0x97]),
    ("magenta-700", [0x87, 0x28, 0x5E]),
];

/// Named indices, so recipes say what they draw rather than a number.
pub mod ix {
    pub const BLACK: u8 = 0;
    pub const BASE_950: u8 = 1;
    pub const BASE_800: u8 = 2;
    pub const BASE_600: u8 = 3;
    pub const BASE_400: u8 = 4;
    pub const BASE_200: u8 = 5;
    pub const BASE_50: u8 = 6;
    pub const PAPER: u8 = 7;
    pub const RED_200: u8 = 8;
    pub const RED: u8 = 9;
    pub const RED_700: u8 = 10;
    pub const ORANGE_200: u8 = 11;
    pub const ORANGE: u8 = 12;
    pub const ORANGE_700: u8 = 13;
    pub const YELLOW_200: u8 = 14;
    pub const YELLOW: u8 = 15;
    pub const YELLOW_700: u8 = 16;
    pub const GREEN_200: u8 = 17;
    pub const GREEN: u8 = 18;
    pub const GREEN_700: u8 = 19;
    pub const CYAN_200: u8 = 20;
    pub const CYAN: u8 = 21;
    pub const CYAN_700: u8 = 22;
    pub const BLUE_200: u8 = 23;
    pub const BLUE: u8 = 24;
    pub const BLUE_700: u8 = 25;
    pub const PURPLE_200: u8 = 26;
    pub const PURPLE: u8 = 27;
    pub const PURPLE_700: u8 = 28;
    pub const MAGENTA_200: u8 = 29;
    pub const MAGENTA: u8 = 30;
    pub const MAGENTA_700: u8 = 31;
}

/// The eight chromatic 400s in a fixed order: categorical colours for chart
/// series and graph nodes, chosen by position, never by hue preference.
pub const CATEGORICAL: [u8; 8] = [
    ix::CYAN,
    ix::BLUE,
    ix::ORANGE,
    ix::PURPLE,
    ix::GREEN,
    ix::YELLOW,
    ix::MAGENTA,
    ix::RED,
];

/// sRGB-encoded channel (0..=1) to linear light, the IEC 61966-2-1 curve.
pub fn to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear light (0..=1) back to an sRGB-encoded channel.
pub fn to_srgb(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// A byte's linear value, from a table built once so every pixel takes the
/// same arithmetic path.
pub fn linear_lut() -> [f32; 256] {
    let mut lut = [0.0; 256];
    for (i, v) in lut.iter_mut().enumerate() {
        *v = to_linear(i as f32 / 255.0);
    }
    lut
}

/// Linear sRGB to Oklab.
pub fn oklab([r, g, b]: [f32; 3]) -> [f32; 3] {
    let l = 0.412_221_47 * r + 0.536_332_55 * g + 0.051_445_995 * b;
    let m = 0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b;
    let s = 0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b;
    let (l, m, s) = (l.cbrt(), m.cbrt(), s.cbrt());
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

/// The reference palette in Oklab, by index.
pub fn reference_oklab() -> [[f32; 3]; 32] {
    let lut = linear_lut();
    let mut out = [[0.0; 3]; 32];
    for (i, (_, rgb)) in REFERENCE.iter().enumerate() {
        out[i] = oklab([
            lut[rgb[0] as usize],
            lut[rgb[1] as usize],
            lut[rgb[2] as usize],
        ]);
    }
    out
}

/// The nearest reference index to an Oklab colour by squared Euclidean
/// distance. Equal distances keep the lower index (strict `<`).
pub fn nearest(lab: [f32; 3], palette: &[[f32; 3]; 32]) -> u8 {
    let mut best = 0u8;
    let mut best_d = f32::INFINITY;
    for (i, p) in palette.iter().enumerate() {
        let d = (lab[0] - p[0]).powi(2) + (lab[1] - p[1]).powi(2) + (lab[2] - p[2]).powi(2);
        if d < best_d {
            best_d = d;
            best = i as u8;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_reference_colour_maps_to_itself() {
        let lab = reference_oklab();
        for (i, c) in lab.iter().enumerate() {
            assert_eq!(nearest(*c, &lab) as usize, i, "{}", REFERENCE[i].0);
        }
    }

    #[test]
    fn white_is_near_one_lightness_and_neutral() {
        let w = oklab([1.0, 1.0, 1.0]);
        assert!((w[0] - 1.0).abs() < 1e-3);
        assert!(w[1].abs() < 1e-3 && w[2].abs() < 1e-3);
    }

    #[test]
    fn transfer_round_trips() {
        for i in 0..=255u32 {
            let c = i as f32 / 255.0;
            assert!((to_srgb(to_linear(c)) - c).abs() < 1e-4);
        }
    }
}
