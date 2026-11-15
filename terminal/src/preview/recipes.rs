//! The recipe registry and the six initial recipes: document, image,
//! application, code, graph/diagram, chart/table; plus the labelled type
//! illustrations every kind falls back to. Each structured recipe draws only
//! what its source shows: no invented chart values, no invented edges, no
//! generic game for every app.

use super::palette::{CATEGORICAL, ix};
use super::raster::Raster;
use super::{
    ARTBOARD, IMAGE_BOUNDS, Limitation, Method, Pixels, Preview, PreviewError, Recipe, Source,
    image,
};

pub const REGISTRY: &[Recipe] = &[
    Recipe {
        id: "image",
        version: 1,
        accepts: accepts_image,
        run: run_image,
    },
    Recipe {
        id: "chart",
        version: 1,
        accepts: accepts_chart,
        run: run_chart,
    },
    Recipe {
        id: "graph",
        version: 1,
        accepts: accepts_graph,
        run: run_graph,
    },
    Recipe {
        id: "code",
        version: 1,
        accepts: accepts_code,
        run: run_code,
    },
    Recipe {
        id: "app",
        version: 1,
        accepts: accepts_app,
        run: run_app,
    },
    Recipe {
        id: "document",
        version: 1,
        accepts: accepts_document,
        run: run_document,
    },
];

fn board() -> Raster {
    Raster::new(ARTBOARD.0, ARTBOARD.1, ix::BLACK)
}

fn text_of(source: &Source) -> Option<&str> {
    source.text.as_deref().filter(|t| !t.trim().is_empty())
}

fn ok(
    raster: Raster,
    recipe: &'static str,
    method: Method,
    limitation: Option<Limitation>,
) -> Preview {
    Preview {
        raster,
        recipe,
        recipe_version: 1,
        method,
        limitation,
    }
}

fn limit(code: &str, detail: impl Into<String>) -> Option<Limitation> {
    Some(Limitation {
        code: code.into(),
        detail: detail.into(),
    })
}

// ── Image ────────────────────────────────────────────────────────────────

fn accepts_image(source: &Source, has_pixels: bool) -> bool {
    has_pixels && (source.kind == "image" || source.media_type.starts_with("image/"))
}

/// The approved landscape's composition: a framed 96×60 content box,
/// letterboxed, on the artboard.
fn run_image(source: &Source, pixels: Option<&Pixels>) -> Result<Preview, PreviewError> {
    let p = pixels.ok_or_else(|| PreviewError::Unsupported("no decoded image".into()))?;
    let reduced = image::convert(
        p.rgba,
        p.width,
        p.height,
        IMAGE_BOUNDS.0,
        IMAGE_BOUNDS.1,
        source.pixel_art,
    )?;
    let mut b = board();
    let (bw, bh) = (IMAGE_BOUNDS.0 as i32, IMAGE_BOUNDS.1 as i32);
    let (ox, oy) = ((ARTBOARD.0 as i32 - bw) / 2, (ARTBOARD.1 as i32 - bh) / 2);
    b.fill(ox - 2, oy - 2, bw + 4, bh + 4, ix::BASE_800);
    b.fill(ox, oy, bw, bh, ix::BASE_950);
    let r = &reduced.raster;
    b.blit(
        r,
        ox + (bw - r.width as i32) / 2,
        oy + (bh - r.height as i32) / 2,
    );
    Ok(ok(b, "image", Method::SourceRaster, reduced.limitation))
}

// ── Document ─────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum Block {
    Heading(usize),
    Line(usize),
    Item(usize),
    Table { columns: usize, rows: usize },
    Code(usize),
    Gap,
}

/// Markdown's block structure, as lengths: enough to draw its shape.
fn blocks(text: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        let t = line.trim();
        if t.starts_with("```") {
            let mut n = 0;
            for l in lines.by_ref() {
                if l.trim().starts_with("```") {
                    break;
                }
                n += 1;
            }
            out.push(Block::Code(n));
        } else if t.starts_with('|') {
            let columns = t.trim_matches('|').split('|').count();
            let mut rows = 1;
            while lines.peek().is_some_and(|l| l.trim().starts_with('|')) {
                let l = lines.next().unwrap_or_default();
                // The |---|---| separator is not a row.
                if !l.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
                    rows += 1;
                }
            }
            out.push(Block::Table { columns, rows });
        } else if let Some(h) = t.strip_prefix('#') {
            out.push(Block::Heading(
                h.trim_start_matches('#').trim().chars().count(),
            ));
        } else if t.starts_with("- ")
            || t.starts_with("* ")
            || t.split_once(". ")
                .is_some_and(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        {
            out.push(Block::Item(t.chars().count()));
        } else if t.is_empty() {
            if out.last().is_some_and(|b| *b != Block::Gap) {
                out.push(Block::Gap);
            }
        } else {
            out.push(Block::Line(t.chars().count()));
        }
    }
    out
}

fn accepts_document(source: &Source, _: bool) -> bool {
    matches!(source.kind.as_str(), "document" | "markdown" | "note")
        || source.media_type.starts_with("text/markdown")
        || source.media_type == "text/plain"
        || source.media_type == "application/pdf"
}

fn badge_for(media_type: &str, kind: &str) -> (&'static str, u8) {
    match media_type {
        "application/pdf" => ("PDF", ix::RED),
        m if m.starts_with("text/markdown") => ("MD", ix::BLUE),
        "text/html" => ("HTML", ix::ORANGE),
        "text/plain" => ("TXT", ix::BASE_600),
        _ if kind == "document" => ("DOC", ix::CYAN_700),
        _ => ("", ix::BASE_600),
    }
}

/// The page, stack and badge every document shares.
fn page(b: &mut Raster, depth: i32, badge: (&str, u8)) -> (i32, i32, i32, i32) {
    let (x, y, w, h) = (42, 10, 40, 58);
    for d in (1..=depth).rev() {
        b.fill(
            x + 3 * d,
            y + 2 * d,
            w,
            h,
            if d == 1 { ix::BASE_600 } else { ix::BASE_800 },
        );
    }
    b.fill(x, y, w, h, ix::BASE_200);
    // Folded corner.
    for i in 0..6 {
        b.hline(x + w - 6 + i, x + w - 1, y + i, ix::BLACK);
        b.set(x + w - 6 + i, y + i, ix::BASE_400);
    }
    b.fill(x + w - 6, y, 1, 6, ix::BASE_400);
    b.hline(x + w - 6, x + w - 1, y + 6, ix::BASE_400);
    // Ground line under the stack.
    b.hline(
        x - 4,
        x + w + 3 * depth + 4,
        y + h + 2 * depth + 2,
        ix::BASE_800,
    );
    let (label, colour) = badge;
    if !label.is_empty() {
        let bw = label.len() as i32 * 4 + 3;
        let (bx, by) = (x + w - bw + 8, y + h - 16);
        b.fill(bx, by, bw, 9, colour);
        b.text(bx + 2, by + 2, label, ix::BLACK);
    }
    (x + 4, y + 5, w - 8, y + h - 3)
}

fn run_document(source: &Source, _: Option<&Pixels>) -> Result<Preview, PreviewError> {
    let Some(text) = text_of(source) else {
        return Ok(type_illustration(source, None));
    };
    let blocks = blocks(text);
    let mut b = board();
    let lines = text.lines().count();
    let depth = if lines > 120 {
        2
    } else if lines > 30 {
        1
    } else {
        0
    };
    let (cx, mut cy, cw, bottom) = page(&mut b, depth, badge_for(&source.media_type, &source.kind));
    let span = |chars: usize, full: usize| ((chars.min(full) * cw as usize) / full).max(3) as i32;
    for block in &blocks {
        if cy >= bottom - 1 {
            break;
        }
        match *block {
            Block::Heading(n) => {
                b.fill(cx, cy, span(n, 32), 2, ix::CYAN);
                cy += 4;
            }
            Block::Line(n) | Block::Item(n) => {
                let indent = if matches!(block, Block::Item(_)) {
                    b.set(cx, cy, ix::BASE_600);
                    2
                } else {
                    0
                };
                // One stroke per ~60 characters, wrapped like a paragraph.
                let mut left = n;
                while left > 0 && cy < bottom - 1 {
                    let take = left.min(60);
                    b.hline(
                        cx + indent,
                        cx + indent + span(take, 60) - 1 - indent,
                        cy,
                        ix::BASE_600,
                    );
                    left -= take;
                    cy += 2;
                }
            }
            Block::Table { columns, rows } => {
                let rows = rows.min(((bottom - cy - 1) / 3).max(1) as usize) as i32;
                let cols = columns.clamp(1, 6) as i32;
                let h = rows * 3 + 1;
                b.outline(cx, cy, cw, h, ix::BASE_400);
                b.fill(cx + 1, cy + 1, cw - 2, 2, ix::BASE_400);
                for r in 1..rows {
                    b.hline(cx, cx + cw - 1, cy + r * 3, ix::BASE_400);
                }
                for c in 1..cols {
                    b.vline(cx + c * cw / cols, cy, cy + h - 1, ix::BASE_400);
                }
                cy += h + 2;
            }
            Block::Code(n) => {
                let h = (n as i32 * 2 + 2).min(bottom - cy).max(3);
                b.fill(cx, cy, cw, h, ix::BASE_800);
                for i in 0..((h - 2) / 2) {
                    b.hline(
                        cx + 2,
                        cx + 2 + 8 + (i * 7) % 14,
                        cy + 1 + i * 2 + 1,
                        ix::GREEN_200,
                    );
                }
                cy += h + 2;
            }
            Block::Gap => cy += 1,
        }
    }
    Ok(ok(b, "document", Method::StructuredRecipe, None))
}

// ── Code ─────────────────────────────────────────────────────────────────

const KEYWORDS: &[&str] = &[
    "fn",
    "let",
    "mut",
    "pub",
    "struct",
    "enum",
    "impl",
    "use",
    "mod",
    "match",
    "if",
    "else",
    "for",
    "while",
    "loop",
    "return",
    "const",
    "static",
    "type",
    "trait",
    "where",
    "async",
    "await",
    "def",
    "class",
    "import",
    "from",
    "function",
    "var",
    "export",
    "interface",
    "package",
    "func",
    "public",
    "private",
    "new",
    "in",
    "of",
    "true",
    "false",
    "null",
    "None",
    "self",
    "this",
    "SELECT",
    "FROM",
    "WHERE",
    "select",
    "from",
    "where",
];

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tok {
    Keyword,
    Call,
    Word,
    String,
    Number,
    Comment,
    Punct,
    Space,
}

fn tokens(line: &str) -> Vec<(Tok, usize)> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let start = i;
        let tok = if c == ' ' || c == '\t' {
            while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') {
                i += 1;
            }
            Tok::Space
        } else if (c == '/' && chars.get(i + 1) == Some(&'/'))
            || c == '#'
            || (c == '-' && chars.get(i + 1) == Some(&'-'))
        {
            i = chars.len();
            Tok::Comment
        } else if c == '"' || c == '\'' || c == '`' {
            i += 1;
            while i < chars.len() && chars[i] != c {
                i += 1;
            }
            i = (i + 1).min(chars.len());
            Tok::String
        } else if c.is_ascii_digit() {
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '.' || chars[i] == '_')
            {
                i += 1;
            }
            Tok::Number
        } else if c.is_alphanumeric() || c == '_' {
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            if KEYWORDS.contains(&word.as_str()) {
                Tok::Keyword
            } else if chars.get(i) == Some(&'(') {
                Tok::Call
            } else {
                Tok::Word
            }
        } else {
            i += 1;
            Tok::Punct
        };
        out.push((tok, i - start));
    }
    out
}

fn accepts_code(source: &Source, _: bool) -> bool {
    source.kind == "code" && text_of(source).is_some()
}

fn window(b: &mut Raster, x: i32, y: i32, w: i32, h: i32) {
    b.fill(x, y, w, h, ix::BASE_950);
    b.outline(x, y, w, h, ix::BASE_600);
    b.fill(x + 1, y + 1, w - 2, 5, ix::BASE_800);
    b.fill(x + 3, y + 3, 2, 1, ix::RED);
    b.fill(x + 7, y + 3, 2, 1, ix::ORANGE);
    b.fill(x + 11, y + 3, 2, 1, ix::YELLOW);
}

fn run_code(source: &Source, _: Option<&Pixels>) -> Result<Preview, PreviewError> {
    let text = text_of(source).unwrap_or_default();
    let mut b = board();
    let (x, y, w, h) = (14, 8, 100, 64);
    window(&mut b, x, y, w, h);
    b.hline(x - 6, x + w + 5, y + h + 2, ix::BASE_800);
    let mut row = y + 9;
    let left = x + 9;
    let right = x + w - 3;
    for line in text.lines().take(24) {
        if row > y + h - 3 {
            break;
        }
        // Gutter mark: a line number stub.
        b.hline(x + 3, x + 4, row, ix::BASE_800);
        let indent = line.chars().take_while(|c| *c == ' ').count() as i32 / 2;
        let mut cx = left + indent;
        for (tok, len) in tokens(line.trim_start()) {
            if tok == Tok::Space {
                cx += (len as i32 + 1) / 2;
                continue;
            }
            let span = (len as i32 + 1) / 2;
            let colour = match tok {
                Tok::Keyword => ix::MAGENTA,
                Tok::Call => ix::BLUE,
                Tok::Word => ix::BASE_200,
                Tok::String => ix::GREEN,
                Tok::Number => ix::ORANGE,
                Tok::Comment => ix::BASE_600,
                Tok::Punct | Tok::Space => ix::BASE_400,
            };
            if cx >= right {
                break;
            }
            b.hline(cx, (cx + span - 1).min(right), row, colour);
            cx += span;
        }
        row += 2;
    }
    Ok(ok(b, "code", Method::StructuredRecipe, None))
}

// ── Graph / diagram ─────────────────────────────────────────────────────

/// Node ids, edges as index pairs, and whether the flow runs left to right.
pub type Graph = (Vec<String>, Vec<(usize, usize)>, bool);

/// Node ids and edges from a mermaid flowchart or a `{nodes, edges}` JSON
/// graph, in first-appearance order.
pub fn parse_graph(text: &str) -> Option<Graph> {
    let mut nodes: Vec<String> = Vec::new();
    let mut edges: Vec<(usize, usize)> = Vec::new();
    let id_of = |nodes: &mut Vec<String>, id: &str| -> usize {
        if let Some(i) = nodes.iter().position(|n| n == id) {
            i
        } else {
            nodes.push(id.to_owned());
            nodes.len() - 1
        }
    };
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
        for n in json.get("nodes")?.as_array()? {
            let id = n.get("id").and_then(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .or_else(|| v.as_i64().map(|i| i.to_string()))
            })?;
            id_of(&mut nodes, &id);
        }
        for e in json
            .get("edges")
            .or_else(|| json.get("links"))?
            .as_array()?
        {
            let end = |k: &str| {
                e.get(k).and_then(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .or_else(|| v.as_i64().map(|i| i.to_string()))
                })
            };
            let (s, t) = (end("source")?, end("target")?);
            let (s, t) = (id_of(&mut nodes, &s), id_of(&mut nodes, &t));
            edges.push((s, t));
        }
        return Some((nodes, edges, true));
    }
    let mut lines = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("%%"));
    let header = lines.next()?;
    let lr = header.contains("LR") || header.contains("RL");
    if !(header.starts_with("graph") || header.starts_with("flowchart")) {
        return None;
    }
    const ARROWS: [&str; 8] = ["-.->", "==>", "-->", "---", "-.-", "--o", "--x", "<-->"];
    for line in lines {
        if line.starts_with("subgraph")
            || line == "end"
            || line.starts_with("classDef")
            || line.starts_with("class ")
            || line.starts_with("style ")
            || line.starts_with("click ")
            || line.starts_with("linkStyle")
        {
            continue;
        }
        // Split the line on arrows, dropping |labels|.
        let mut rest = line.to_owned();
        let mut ids = Vec::new();
        loop {
            let found = ARROWS
                .iter()
                .filter_map(|a| rest.find(a).map(|i| (i, *a)))
                .min();
            let (head, tail) = match found {
                Some((i, a)) => (rest[..i].to_owned(), Some(rest[i + a.len()..].to_owned())),
                None => (rest.clone(), None),
            };
            let head = head.trim();
            let head = head
                .strip_prefix('|')
                .and_then(|h| h.split_once('|').map(|(_, r)| r.trim()))
                .unwrap_or(head);
            let id: String = head
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if !id.is_empty() {
                ids.push(id);
            }
            match tail {
                Some(t) => rest = t,
                None => break,
            }
        }
        for id in &ids {
            id_of(&mut nodes, id);
        }
        for pair in ids.windows(2) {
            let s = id_of(&mut nodes, &pair[0]);
            let t = id_of(&mut nodes, &pair[1]);
            edges.push((s, t));
        }
    }
    (!nodes.is_empty()).then_some((nodes, edges, lr))
}

fn accepts_graph(source: &Source, _: bool) -> bool {
    (matches!(source.kind.as_str(), "diagram" | "graph") || source.media_type == "text/vnd.mermaid")
        && text_of(source).and_then(parse_graph).is_some()
}

const GRAPH_MAX_NODES: usize = 16;

fn run_graph(source: &Source, _: Option<&Pixels>) -> Result<Preview, PreviewError> {
    let (nodes, edges, lr) = text_of(source)
        .and_then(parse_graph)
        .ok_or_else(|| PreviewError::Malformed("no graph structure".into()))?;
    let total = nodes.len();
    // Too dense: keep the best-connected nodes, in first-appearance order,
    // and say so. Edges are only ever those between kept nodes.
    let mut degree = vec![0usize; total];
    for &(s, t) in &edges {
        degree[s] += 1;
        degree[t] += 1;
    }
    let mut keep: Vec<usize> = (0..total).collect();
    if total > GRAPH_MAX_NODES {
        keep.sort_by(|a, b| degree[*b].cmp(&degree[*a]).then(a.cmp(b)));
        keep.truncate(GRAPH_MAX_NODES);
        keep.sort();
    }
    let kept: Vec<Option<usize>> = (0..total)
        .map(|i| keep.iter().position(|k| *k == i))
        .collect();
    let shown: Vec<(usize, usize)> = edges
        .iter()
        .filter_map(|&(s, t)| Some((kept[s]?, kept[t]?)))
        .filter(|(s, t)| s != t)
        .collect();
    let n = keep.len();
    // Layers by longest path from the sources, bounded to n passes so a cycle ends.
    let mut layer = vec![0usize; n];
    for _ in 0..n {
        let mut changed = false;
        for &(s, t) in &shown {
            if layer[t] < layer[s] + 1 && layer[s] + 1 < n {
                layer[t] = layer[s] + 1;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let layers = layer.iter().max().map_or(1, |m| m + 1);
    let mut slot = vec![0usize; n];
    let mut counts = vec![0usize; layers];
    for i in 0..n {
        slot[i] = counts[layer[i]];
        counts[layer[i]] += 1;
    }
    let (nw, nh) = (12, 7);
    let (aw, ah) = (ARTBOARD.0 as i32 - 16, ARTBOARD.1 as i32 - 14);
    let centre = |i: usize| -> (i32, i32) {
        let (a, b) = (layer[i] as i32, slot[i] as i32);
        let (na, nb) = (layers as i32, counts[layer[i]] as i32);
        let along = |k: i32, of: i32, len: i32| 8 + (len * (2 * k + 1)) / (2 * of);
        if lr {
            (along(a, na, aw), 7 + (ah * (2 * b + 1)) / (2 * nb))
        } else {
            (along(b, nb, aw), 7 + (ah * (2 * a + 1)) / (2 * na))
        }
    };
    let mut b = board();
    for &(s, t) in &shown {
        let ((x0, y0), (x1, y1)) = (centre(s), centre(t));
        // Orthogonal: along the flow, across, along.
        if lr {
            let mid = (x0 + x1) / 2;
            b.hline(x0, mid, y0, ix::BASE_600);
            b.vline(mid, y0, y1, ix::BASE_600);
            b.hline(mid, x1, y1, ix::BASE_600);
        } else {
            let mid = (y0 + y1) / 2;
            b.vline(x0, y0, mid, ix::BASE_600);
            b.hline(x0, x1, mid, ix::BASE_600);
            b.vline(x1, mid, y1, ix::BASE_600);
        }
    }
    for i in 0..n {
        let (x, y) = centre(i);
        let c = CATEGORICAL[layer[i] % CATEGORICAL.len()];
        b.fill(x - nw / 2, y - nh / 2, nw, nh, ix::BLACK);
        b.outline(x - nw / 2, y - nh / 2, nw, nh, c);
        b.outline(x - nw / 2 + 1, y - nh / 2 + 1, nw - 2, nh - 2, c);
        b.hline(x - 3, x + 2, y, ix::BASE_200);
    }
    let limitation = (total > n).then(|| Limitation {
        code: "partial_graph".into(),
        detail: format!(
            "Shows the {n} best-connected of {total} nodes and the {} of {} edges between them.",
            shown.len(),
            edges.len()
        ),
    });
    Ok(ok(b, "graph", Method::StructuredRecipe, limitation))
}

// ── Chart / table ───────────────────────────────────────────────────────

/// Category values from a mermaid `pie` or a two-column label/number table
/// (markdown or CSV).
pub fn parse_series(text: &str) -> Option<Result<Vec<(String, f64)>, PreviewError>> {
    let t = text.trim_start();
    let rows: Vec<(String, String)> = if t.starts_with("pie") {
        t.lines()
            .skip(1)
            .filter_map(|l| {
                let (k, v) = l.trim().rsplit_once(':')?;
                let k = k.trim().trim_matches('"');
                (!k.is_empty() && !k.starts_with("title"))
                    .then(|| (k.to_owned(), v.trim().to_owned()))
            })
            .collect()
    } else {
        let sep = if t.lines().next()?.contains('|') {
            '|'
        } else {
            ','
        };
        let mut rows: Vec<Vec<String>> = t
            .lines()
            .map(|l| {
                l.trim()
                    .trim_matches('|')
                    .split(sep)
                    .map(|c| c.trim().to_owned())
                    .collect::<Vec<_>>()
            })
            .filter(|r: &Vec<String>| {
                r.len() >= 2
                    && !r
                        .iter()
                        .all(|c| c.chars().all(|ch| matches!(ch, '-' | ':' | ' ')))
            })
            .collect();
        if rows.len() < 2 || rows.iter().any(|r| r.len() != 2) {
            return None;
        }
        rows.remove(0); // header
        rows.into_iter()
            .map(|r| (r[0].clone(), r[1].clone()))
            .collect()
    };
    if rows.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for (k, v) in rows {
        let Ok(n) = v.trim_end_matches('%').parse::<f64>() else {
            return Some(Err(PreviewError::Malformed(format!(
                "“{v}” is not a number"
            ))));
        };
        if !n.is_finite() || n < 0.0 {
            return Some(Err(PreviewError::Unsupported(format!(
                "{k} is {v}; a part-of-whole preview needs finite non-negative values"
            ))));
        }
        out.push((k, n));
    }
    if out.iter().map(|(_, v)| v).sum::<f64>() <= 0.0 {
        return Some(Err(PreviewError::Unsupported(
            "the values sum to zero".into(),
        )));
    }
    Some(Ok(out))
}

fn accepts_chart(source: &Source, _: bool) -> bool {
    matches!(source.kind.as_str(), "chart" | "table" | "diagram" | "data")
        && text_of(source).and_then(parse_series).is_some()
}

pub const DONUT: (i32, i32, f64, f64) = (40, 42, 30.0, 15.0);

/// Each annulus pixel's category: angle from 12 o'clock clockwise against
/// cumulative fractions. Pixel centres are tested, so the grid is exact.
pub fn donut_category(x: i32, y: i32, fractions: &[f64]) -> Option<usize> {
    let (cx, cy, ro, ri) = DONUT;
    let (dx, dy) = (
        f64::from(x) + 0.5 - f64::from(cx),
        f64::from(y) + 0.5 - f64::from(cy),
    );
    let r = (dx * dx + dy * dy).sqrt();
    if r > ro || r < ri {
        return None;
    }
    let mut a = dx.atan2(-dy) / std::f64::consts::TAU;
    if a < 0.0 {
        a += 1.0;
    }
    let mut acc = 0.0;
    for (i, f) in fractions.iter().enumerate() {
        acc += f;
        if a < acc {
            return Some(i);
        }
    }
    Some(fractions.len() - 1)
}

fn run_chart(source: &Source, _: Option<&Pixels>) -> Result<Preview, PreviewError> {
    let series = text_of(source)
        .and_then(parse_series)
        .ok_or_else(|| PreviewError::Malformed("no series".into()))??;
    let total: f64 = series.iter().map(|(_, v)| v).sum();
    let shown = series.len().min(CATEGORICAL.len());
    let fractions: Vec<f64> = series.iter().take(shown).map(|(_, v)| v / total).collect();
    let mut b = board();
    let mut counts = vec![0usize; shown];
    for y in 0..ARTBOARD.1 as i32 {
        for x in 0..80 {
            if let Some(i) = donut_category(x, y, &fractions) {
                b.set(x, y, CATEGORICAL[i]);
                counts[i] += 1;
            }
        }
    }
    // Legend: a swatch and a stroke per category, stroke length by value.
    let max = fractions
        .iter()
        .cloned()
        .fold(0.0, f64::max)
        .max(f64::MIN_POSITIVE);
    for (i, f) in fractions.iter().enumerate() {
        let y = 16 + i as i32 * 7;
        b.fill(82, y, 4, 4, CATEGORICAL[i]);
        b.hline(
            89,
            89 + ((f / max) * 26.0).round().max(1.0) as i32,
            y + 1,
            ix::BASE_200,
        );
        b.hline(
            89,
            89 + ((f / max) * 18.0).round().max(1.0) as i32,
            y + 3,
            ix::BASE_600,
        );
    }
    b.hline(18, 62, 78, ix::BASE_800);
    let below: Vec<&str> = series
        .iter()
        .take(shown)
        .zip(&counts)
        .filter(|(_, c)| **c == 0)
        .map(|((k, _), _)| k.as_str())
        .collect();
    let mut notes = Vec::new();
    if !below.is_empty() {
        notes.push(format!("Below preview resolution: {}.", below.join(", ")));
    }
    if series.len() > shown {
        notes.push(format!("Shows {shown} of {} categories.", series.len()));
    }
    let limitation = (!notes.is_empty()).then(|| Limitation {
        code: "partial_chart".into(),
        detail: notes.join(" "),
    });
    Ok(ok(b, "chart", Method::StructuredRecipe, limitation))
}

// ── Application ─────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
enum Widget {
    Heading,
    Button,
    Field,
    Canvas,
    Table,
    Picture,
    List,
    Text,
}

/// The app's significant elements in source order, read from its markup as
/// text. Nothing is parsed into a DOM and nothing runs.
fn widgets(html: &str) -> Vec<Widget> {
    let lower = html.to_ascii_lowercase();
    let body = lower.split_once("<body").map_or(lower.as_str(), |(_, b)| b);
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(i) = rest.find('<') {
        rest = &rest[i + 1..];
        let name: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        let w = match name.as_str() {
            "h1" | "h2" | "h3" | "header" => Widget::Heading,
            "button" => Widget::Button,
            "input" | "textarea" | "select" => Widget::Field,
            "canvas" | "svg" | "video" => Widget::Canvas,
            "table" => Widget::Table,
            "img" => Widget::Picture,
            "ul" | "ol" => Widget::List,
            "p" => Widget::Text,
            "script" | "style" => {
                // Skip their bodies: scripts are not structure.
                if let Some(end) = rest.find(&format!("</{name}")) {
                    rest = &rest[end..];
                }
                continue;
            }
            _ => continue,
        };
        out.push(w);
    }
    out
}

fn accepts_app(source: &Source, _: bool) -> bool {
    source.kind == "app"
        && text_of(source).is_some_and(|t| t.contains('<') && !widgets(t).is_empty())
}

fn run_app(source: &Source, _: Option<&Pixels>) -> Result<Preview, PreviewError> {
    let found = widgets(text_of(source).unwrap_or_default());
    let mut b = board();
    let (x, y, w, h) = (14, 8, 100, 66);
    window(&mut b, x, y, w, h);
    let (left, right, bottom) = (x + 5, x + w - 5, y + h - 3);
    let mut cy = y + 9;
    let mut i = 0;
    while i < found.len() && cy < bottom - 2 {
        match found[i] {
            Widget::Heading => {
                b.fill(left, cy, 30, 3, ix::BASE_200);
                cy += 6;
            }
            Widget::Button => {
                // A run of buttons lays out as a key grid, as many as there are.
                let run = found[i..]
                    .iter()
                    .take_while(|w| **w == Widget::Button)
                    .count();
                let cols = if run > 4 { 4 } else { run } as i32;
                let bw = ((right - left) - (cols - 1) * 2) / cols;
                for k in 0..run as i32 {
                    let (r, c) = (k / cols, k % cols);
                    let by = cy + r * 6;
                    if by + 4 > bottom {
                        break;
                    }
                    b.fill(
                        left + c * (bw + 2),
                        by,
                        bw,
                        4,
                        if k == 0 { ix::CYAN } else { ix::BASE_800 },
                    );
                }
                cy += ((run as i32 + cols - 1) / cols) * 6 + 1;
                i += run;
                continue;
            }
            Widget::Field => {
                b.outline(left, cy, right - left, 5, ix::BASE_600);
                cy += 7;
            }
            Widget::Canvas => {
                let ch = (bottom - cy).min(24);
                b.fill(left, cy, right - left, ch, ix::BLACK);
                b.outline(left, cy, right - left, ch, ix::BLUE_700);
                cy += ch + 2;
            }
            Widget::Table => {
                for r in 0..4 {
                    b.hline(left, right - 1, cy + r * 3, ix::BASE_600);
                }
                cy += 12;
            }
            Widget::Picture => {
                b.fill(left, cy, 24, 14, ix::BASE_800);
                cy += 16;
            }
            Widget::List => {
                for r in 0..3 {
                    b.set(left, cy + r * 2, ix::BASE_400);
                    b.hline(left + 2, left + 22 - r * 4, cy + r * 2, ix::BASE_600);
                }
                cy += 7;
            }
            Widget::Text => {
                b.hline(left, left + 40, cy, ix::BASE_600);
                cy += 3;
            }
        }
        i += 1;
    }
    Ok(ok(
        b,
        "app",
        Method::StructuredRecipe,
        limit(
            "markup_sketch",
            "A layout sketch read from the app's markup; not a capture of it running.",
        ),
    ))
}

// ── Type illustrations ──────────────────────────────────────────────────

/// What a kind looks like when nothing about its content can be drawn. The
/// method says so; nothing here depicts the missing content.
pub fn type_illustration(source: &Source, limitation: Option<Limitation>) -> Preview {
    let mut b = board();
    let kind = if source.media_type.starts_with("image/") {
        "image"
    } else {
        source.kind.as_str()
    };
    match kind {
        "document" | "markdown" | "note" | "upload" if !source.media_type.starts_with("image/") => {
            let (cx, cy, cw, _) = page(&mut b, 0, badge_for(&source.media_type, &source.kind));
            for r in 0..6 {
                b.hline(cx, cx + cw - 1 - (r % 3) * 6, cy + r * 3, ix::BASE_400);
            }
        }
        "image" => {
            b.outline(32, 14, 64, 48, ix::BASE_600);
            b.outline(33, 15, 62, 46, ix::BASE_800);
            b.text(58, 35, "IMG", ix::BASE_600);
        }
        "app" => {
            window(&mut b, 24, 12, 80, 56);
            b.text(56, 38, "APP", ix::BASE_600);
        }
        "code" => {
            window(&mut b, 24, 12, 80, 56);
            for r in 0..8 {
                b.hline(32, 60 + (r * 11) % 30, 22 + r * 5, ix::BASE_600);
            }
        }
        "diagram" | "graph" => {
            for (x, y) in [(40, 26), (84, 26), (62, 56)] {
                b.outline(x - 6, y - 4, 12, 8, ix::BASE_600);
            }
            b.line(46, 26, 78, 26, ix::BASE_800);
            b.line(42, 30, 58, 52, ix::BASE_800);
        }
        "chart" | "table" | "data" => {
            b.outline(30, 14, 68, 52, ix::BASE_800);
            b.text(52, 37, "DATA", ix::BASE_600);
        }
        _ => {
            b.outline(44, 18, 40, 44, ix::BASE_600);
            b.text(62, 38, "?", ix::BASE_600);
        }
    }
    ok(b, "type_illustration", Method::TypeIllustration, limitation)
}

#[cfg(test)]
mod tests {
    use super::super::{Source, render};
    use super::*;

    fn src(kind: &str, media: &str, text: &str) -> Source {
        Source {
            kind: kind.into(),
            media_type: media.into(),
            text: Some(text.into()),
            ..Default::default()
        }
    }

    #[test]
    fn markdown_draws_its_own_blocks_and_no_pdf_badge() {
        let p = render(
            &src(
                "document",
                "text/markdown",
                "# Title\n\nA paragraph.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
            ),
            None,
        );
        assert_eq!(p.method, Method::StructuredRecipe);
        assert_eq!(p.recipe, "document");
        // The PDF badge colour is never on a markdown page.
        assert!(!p.raster.indices.contains(&ix::RED));
        assert!(p.raster.indices.contains(&ix::CYAN), "heading band");
    }

    #[test]
    fn pdf_without_structure_is_a_labelled_type_illustration() {
        let s = Source {
            kind: "document".into(),
            media_type: "application/pdf".into(),
            ..Default::default()
        };
        let p = render(&s, None);
        assert_eq!(p.method, Method::TypeIllustration);
        assert!(
            p.raster.indices.contains(&ix::RED),
            "PDF badge from the verified media type"
        );
    }

    #[test]
    fn chart_area_tracks_its_data_within_three_points() {
        let text = "pie\n\"A\" : 50\n\"B\" : 30\n\"C\" : 15\n\"D\" : 5\n";
        let series = parse_series(text).unwrap().unwrap();
        let total: f64 = series.iter().map(|s| s.1).sum();
        let fr: Vec<f64> = series.iter().map(|s| s.1 / total).collect();
        let mut counts = vec![0usize; fr.len()];
        for y in 0..84 {
            for x in 0..80 {
                if let Some(i) = donut_category(x, y, &fr) {
                    counts[i] += 1;
                }
            }
        }
        let all: usize = counts.iter().sum();
        for (i, f) in fr.iter().enumerate() {
            let got = counts[i] as f64 / all as f64;
            assert!((got - f).abs() <= 0.03, "category {i}: {got} vs {f}");
        }
    }

    #[test]
    fn tiny_category_is_reported_not_enlarged() {
        let p = render(
            &src("chart", "", "pie\n\"Big\" : 100000\n\"Tiny\" : 1\n"),
            None,
        );
        assert_eq!(p.recipe, "chart");
        assert!(p.limitation.unwrap().detail.contains("Tiny"));
    }

    #[test]
    fn invalid_series_falls_back_with_a_named_reason() {
        let p = render(&src("chart", "", "pie\n\"A\" : -3\n\"B\" : 4\n"), None);
        assert_eq!(p.method, Method::TypeIllustration);
        assert_eq!(p.limitation.unwrap().code, "unsupported");
        let zero = render(&src("chart", "", "pie\n\"A\" : 0\n"), None);
        assert_eq!(zero.method, Method::TypeIllustration);
    }

    #[test]
    fn graph_draws_only_source_edges() {
        let (nodes, edges, lr) =
            parse_graph("graph LR\nA[Notes] --> B(Sources)\nB -->|cites| C\nA --- C\n").unwrap();
        assert_eq!(nodes, ["A", "B", "C"]);
        assert_eq!(edges, [(0, 1), (1, 2), (0, 2)]);
        assert!(lr);
        let p = render(
            &src("diagram", "text/vnd.mermaid", "graph TD\nA-->B\n"),
            None,
        );
        assert_eq!(p.recipe, "graph");
    }

    #[test]
    fn dense_graph_says_it_is_partial() {
        let mut t = String::from("graph TD\n");
        for i in 0..30 {
            t.push_str(&format!("N{i} --> N{}\n", i + 1));
        }
        let p = render(&src("diagram", "", &t), None);
        let l = p.limitation.unwrap();
        assert_eq!(l.code, "partial_graph");
        assert!(l.detail.contains("of 31 nodes"));
    }

    #[test]
    fn apps_are_sketched_from_their_markup_not_a_maze() {
        let calc = "<body><input><button>7</button><button>8</button><button>9</button><button>+</button><button>4</button></body>";
        let p = render(&src("app", "text/html", calc), None);
        assert_eq!(p.recipe, "app");
        let board = "<body><h1>Tasks</h1><ul><li>a</li></ul><script>for(;;){}</script></body>";
        assert_ne!(
            render(&src("app", "text/html", board), None).raster,
            p.raster
        );
        // No markup: an honest app illustration.
        let none = render(
            &Source {
                kind: "app".into(),
                ..Default::default()
            },
            None,
        );
        assert_eq!(none.method, Method::TypeIllustration);
    }

    #[test]
    fn code_follows_line_lengths() {
        let a = render(&src("code", "", "fn main() {\n    let x = 1;\n}\n"), None);
        let b = render(
            &src(
                "code",
                "",
                "fn main() {\n    let a_much_longer_name = \"string\";\n}\n",
            ),
            None,
        );
        assert_eq!(a.recipe, "code");
        assert_ne!(a.raster, b.raster);
    }

    #[test]
    fn every_recipe_stays_in_bounds_and_palette() {
        for p in [
            render(
                &src("document", "text/markdown", "# a\n- b\n```\nc\n```\n"),
                None,
            ),
            render(&src("code", "", "x"), None),
            render(&src("diagram", "", "graph TD\nA-->B"), None),
            render(&src("chart", "", "a,b\nx,1\ny,2"), None),
            render(&src("app", "", "<button>"), None),
            render(&src("mystery", "", ""), None),
        ] {
            assert_eq!((p.raster.width, p.raster.height), ARTBOARD);
            assert!(p.raster.indices.iter().all(|i| *i < 32));
            assert!(p.raster.colours() <= 32);
        }
    }
}
