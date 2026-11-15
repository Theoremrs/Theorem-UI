//! One indexed raster on an integer grid, and the drawing primitives recipes
//! compose it from. Every shape lands on whole logical pixels: no
//! antialiasing, no blending, explicit edge rules (rectangles include their
//! first row/column and exclude `x + w`/`y + h`).

/// A preview's pixels as indices into the reference palette.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Raster {
    pub width: u16,
    pub height: u16,
    pub indices: Vec<u8>,
}

impl Raster {
    pub fn new(width: u16, height: u16, fill: u8) -> Self {
        Self {
            width,
            height,
            indices: vec![fill; width as usize * height as usize],
        }
    }

    pub fn get(&self, x: i32, y: i32) -> Option<u8> {
        if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
            return None;
        }
        Some(self.indices[y as usize * self.width as usize + x as usize])
    }

    /// Sets one pixel; points off the grid are clipped.
    pub fn set(&mut self, x: i32, y: i32, c: u8) {
        if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
            return;
        }
        let w = self.width as usize;
        self.indices[y as usize * w + x as usize] = c;
    }

    pub fn fill(&mut self, x: i32, y: i32, w: i32, h: i32, c: u8) {
        for yy in y..y + h {
            for xx in x..x + w {
                self.set(xx, yy, c);
            }
        }
    }

    /// A one-pixel outline of the same rectangle `fill` would cover.
    pub fn outline(&mut self, x: i32, y: i32, w: i32, h: i32, c: u8) {
        if w <= 0 || h <= 0 {
            return;
        }
        self.hline(x, x + w - 1, y, c);
        self.hline(x, x + w - 1, y + h - 1, c);
        self.vline(x, y, y + h - 1, c);
        self.vline(x + w - 1, y, y + h - 1, c);
    }

    pub fn hline(&mut self, x0: i32, x1: i32, y: i32, c: u8) {
        for x in x0.min(x1)..=x0.max(x1) {
            self.set(x, y, c);
        }
    }

    pub fn vline(&mut self, x: i32, y0: i32, y1: i32, c: u8) {
        for y in y0.min(y1)..=y0.max(y1) {
            self.set(x, y, c);
        }
    }

    /// Bresenham's line, both ends included.
    pub fn line(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, c: u8) {
        let (mut x, mut y) = (x0, y0);
        let dx = (x1 - x0).abs();
        let dy = -(y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut err = dx + dy;
        loop {
            self.set(x, y, c);
            if x == x1 && y == y1 {
                break;
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x += sx;
            }
            if e2 <= dx {
                err += dx;
                y += sy;
            }
        }
    }

    /// Copies `src` with its top left at (x, y), clipped to this raster.
    pub fn blit(&mut self, src: &Raster, x: i32, y: i32) {
        for sy in 0..src.height as i32 {
            for sx in 0..src.width as i32 {
                if let Some(c) = src.get(sx, sy) {
                    self.set(x + sx, y + sy, c);
                }
            }
        }
    }

    /// Decorative bitmap lettering in a 3×5 cell with one column between
    /// letters. Characters the font lacks are skipped as a blank cell; real
    /// labels are always also rendered as text outside the art.
    pub fn text(&mut self, x: i32, y: i32, s: &str, c: u8) {
        let mut cx = x;
        for ch in s.chars() {
            if let Some(rows) = glyph(ch.to_ascii_uppercase()) {
                for (ry, row) in rows.iter().enumerate() {
                    for rx in 0..3 {
                        if row & (0b100 >> rx) != 0 {
                            self.set(cx + rx, y + ry as i32, c);
                        }
                    }
                }
            }
            cx += 4;
        }
    }

    /// Distinct indices used.
    pub fn colours(&self) -> usize {
        let mut seen = [false; 256];
        for &i in &self.indices {
            seen[i as usize] = true;
        }
        seen.iter().filter(|s| **s).count()
    }

    /// FNV-1a 64 over width, height and indices: the result digest a cache
    /// and the acceptance fixtures compare.
    pub fn digest(&self) -> String {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |b: u8| {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        };
        for b in self.width.to_le_bytes().into_iter().chain(self.height.to_le_bytes()) {
            eat(b);
        }
        for &b in &self.indices {
            eat(b);
        }
        format!("fnv1a64:{h:016x}")
    }
}

/// Rows of a 3×5 glyph, high bit on the left.
fn glyph(ch: char) -> Option<[u8; 5]> {
    Some(match ch {
        'A' => [0b010, 0b101, 0b111, 0b101, 0b101],
        'B' => [0b110, 0b101, 0b110, 0b101, 0b110],
        'C' => [0b011, 0b100, 0b100, 0b100, 0b011],
        'D' => [0b110, 0b101, 0b101, 0b101, 0b110],
        'E' => [0b111, 0b100, 0b110, 0b100, 0b111],
        'F' => [0b111, 0b100, 0b110, 0b100, 0b100],
        'G' => [0b011, 0b100, 0b101, 0b101, 0b011],
        'H' => [0b101, 0b101, 0b111, 0b101, 0b101],
        'I' => [0b111, 0b010, 0b010, 0b010, 0b111],
        'J' => [0b001, 0b001, 0b001, 0b101, 0b010],
        'K' => [0b101, 0b101, 0b110, 0b101, 0b101],
        'L' => [0b100, 0b100, 0b100, 0b100, 0b111],
        'M' => [0b101, 0b111, 0b111, 0b101, 0b101],
        'N' => [0b110, 0b101, 0b101, 0b101, 0b101],
        'O' => [0b010, 0b101, 0b101, 0b101, 0b010],
        'P' => [0b110, 0b101, 0b110, 0b100, 0b100],
        'Q' => [0b010, 0b101, 0b101, 0b110, 0b011],
        'R' => [0b110, 0b101, 0b110, 0b101, 0b101],
        'S' => [0b011, 0b100, 0b010, 0b001, 0b110],
        'T' => [0b111, 0b010, 0b010, 0b010, 0b010],
        'U' => [0b101, 0b101, 0b101, 0b101, 0b111],
        'V' => [0b101, 0b101, 0b101, 0b101, 0b010],
        'W' => [0b101, 0b101, 0b111, 0b111, 0b101],
        'X' => [0b101, 0b101, 0b010, 0b101, 0b101],
        'Y' => [0b101, 0b101, 0b010, 0b010, 0b010],
        'Z' => [0b111, 0b001, 0b010, 0b100, 0b111],
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b110, 0b001, 0b010, 0b100, 0b111],
        '3' => [0b110, 0b001, 0b010, 0b001, 0b110],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b110, 0b001, 0b110],
        '6' => [0b011, 0b100, 0b110, 0b101, 0b010],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b010, 0b101, 0b010, 0b101, 0b010],
        '9' => [0b010, 0b101, 0b011, 0b001, 0b110],
        '?' => [0b110, 0b001, 0b010, 0b000, 0b010],
        '.' => [0b000, 0b000, 0b000, 0b000, 0b010],
        '-' => [0b000, 0b000, 0b111, 0b000, 0b000],
        '/' => [0b001, 0b001, 0b010, 0b100, 0b100],
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_edges_are_half_open() {
        let mut r = Raster::new(8, 8, 0);
        r.fill(2, 2, 3, 2, 5);
        assert_eq!(r.indices.iter().filter(|&&i| i == 5).count(), 6);
        assert_eq!(r.get(4, 3), Some(5));
        assert_eq!(r.get(5, 3), Some(0));
    }

    #[test]
    fn lines_include_both_ends_and_clip() {
        let mut r = Raster::new(8, 8, 0);
        r.line(-3, -3, 3, 3, 1);
        assert_eq!(r.get(0, 0), Some(1));
        assert_eq!(r.get(3, 3), Some(1));
    }
}
