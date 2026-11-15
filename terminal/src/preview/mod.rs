//! Deterministic, type-aware miniature previews (SPEC-THEOREM-ARTIFACT-
//! CABINET-1.0 §6, procedural-pixel-previews.md). Pure: no network, no
//! credentials, no clock, no randomness. A source goes in, one indexed
//! raster over the reference palette comes out, with a record of how it was
//! made. The page runs this in a worker and keeps the result by key.
//!
//! Recipes are one table (`RECIPES`); the cabinet only ever sees the common
//! raster, so adding a recipe never adds a branch to the gallery.

pub mod image;
pub mod palette;
pub mod raster;
pub mod recipes;

use serde::{Deserialize, Serialize};

pub use raster::Raster;

/// The renderer's own version: part of every cache key.
pub const RENDERER_VERSION: u32 = 1;
/// The standard artboard (preview-profiles.json `standard`).
pub const ARTBOARD: (u16, u16) = (128, 84);
/// The image recipe's content box inside the artboard.
pub const IMAGE_BOUNDS: (u32, u32) = (96, 60);
/// The longest text excerpt a structured recipe reads.
pub const TEXT_LIMIT: usize = 16 * 1024;

/// What the page hands a recipe: already authorized, already bounded.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Source {
    /// The artifact's verified kind: document, image, app, code, diagram,
    /// chart, table, upload, …
    pub kind: String,
    pub media_type: String,
    pub language: Option<String>,
    /// A bounded text excerpt of the represented revision (markdown, code,
    /// mermaid, CSV, HTML), when the kind has one.
    pub text: Option<String>,
    /// An exact hint that an image is existing pixel art.
    pub pixel_art: bool,
}

/// How the picture relates to its source (method doc §2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    SourceRaster,
    StructuredRecipe,
    TypeIllustration,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Limitation {
    pub code: String,
    pub detail: String,
}

/// A named failure. Browsing goes on; the card says which one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreviewError {
    Malformed(String),
    TooLarge(String),
    Unsupported(String),
}

impl PreviewError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Malformed(_) => "malformed",
            Self::TooLarge(_) => "too_large",
            Self::Unsupported(_) => "unsupported",
        }
    }
    pub fn detail(&self) -> &str {
        match self {
            Self::Malformed(d) | Self::TooLarge(d) | Self::Unsupported(d) => d,
        }
    }
}

/// The common output of every recipe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    pub raster: Raster,
    pub recipe: &'static str,
    pub recipe_version: u32,
    pub method: Method,
    pub limitation: Option<Limitation>,
}

/// The record a preview carries alongside its indices.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta<'a> {
    pub renderer_version: u32,
    pub recipe: &'a str,
    pub recipe_version: u32,
    pub method: Method,
    pub width: u16,
    pub height: u16,
    pub palette_id: &'a str,
    pub palette_version: u32,
    pub palette_colours: usize,
    pub result_digest: String,
    pub limitation: Option<&'a Limitation>,
    pub target: &'a str,
}

impl Preview {
    pub fn meta(&self) -> Meta<'_> {
        Meta {
            renderer_version: RENDERER_VERSION,
            recipe: self.recipe,
            recipe_version: self.recipe_version,
            method: self.method,
            width: self.raster.width,
            height: self.raster.height,
            palette_id: palette::PALETTE_ID,
            palette_version: palette::PALETTE_VERSION,
            palette_colours: self.raster.colours(),
            result_digest: self.raster.digest(),
            limitation: self.limitation.as_ref(),
            target: if cfg!(target_arch = "wasm32") {
                "wasm32"
            } else {
                "native"
            },
        }
    }
}

/// A decoded image the page passes with an image source.
pub struct Pixels<'a> {
    pub rgba: &'a [u8],
    pub width: u32,
    pub height: u32,
}

/// One recipe in the registry.
pub struct Recipe {
    pub id: &'static str,
    pub version: u32,
    /// Whether this recipe can draw `source` from what it carries.
    pub accepts: fn(&Source, bool) -> bool,
    pub run: fn(&Source, Option<&Pixels>) -> Result<Preview, PreviewError>,
}

pub const RECIPES: &[Recipe] = recipes::REGISTRY;

/// Draws `source`: the first recipe that accepts it, else the kind's type
/// illustration. A recipe's named failure becomes the type illustration
/// with that failure as its limitation, so browsing never shows a blank
/// success.
pub fn render(source: &Source, pixels: Option<&Pixels>) -> Preview {
    render_with(RECIPES, source, pixels)
}

/// `render` against any registry: the contribution seam. A new recipe is one
/// more `Recipe` entry; nothing downstream branches on artifact kind.
pub fn render_with(registry: &[Recipe], source: &Source, pixels: Option<&Pixels>) -> Preview {
    let source = &Source {
        text: source.text.as_ref().map(|t| clip(t, TEXT_LIMIT).to_owned()),
        ..source.clone()
    };
    let Some(recipe) = registry
        .iter()
        .find(|r| (r.accepts)(source, pixels.is_some()))
    else {
        return recipes::type_illustration(source, None);
    };
    match (recipe.run)(source, pixels) {
        Ok(preview) => preview,
        Err(error) => recipes::type_illustration(
            source,
            Some(Limitation {
                code: error.code().into(),
                detail: error.detail().into(),
            }),
        ),
    }
}

/// The first `limit` bytes of `text`, cut at a character boundary.
fn clip(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stripes(_: &Source, _: Option<&Pixels>) -> Result<Preview, PreviewError> {
        let mut raster = raster::Raster::new(ARTBOARD.0, ARTBOARD.1, palette::ix::BLACK);
        for x in (0..i32::from(ARTBOARD.0)).step_by(4) {
            raster.set(x, 0, palette::ix::BASE_200);
        }
        Ok(Preview {
            raster,
            recipe: "stripes",
            recipe_version: 1,
            method: Method::StructuredRecipe,
            limitation: None,
        })
    }

    #[test]
    fn a_seventh_recipe_joins_through_the_registry_alone() {
        // A17: one more entry; the result is the standard Preview the
        // cabinet already consumes, with no new kind branch anywhere.
        let mut registry = vec![Recipe {
            id: "stripes",
            version: 1,
            accepts: |s, _| s.kind == "timeline",
            run: stripes,
        }];
        assert_eq!(RECIPES.len(), 6);
        registry.extend(RECIPES.iter().map(|r| Recipe { ..*r }));
        let source = Source {
            kind: "timeline".into(),
            ..Default::default()
        };
        let p = render_with(&registry, &source, None);
        assert_eq!(p.recipe, "stripes");
        assert_eq!((p.raster.width, p.raster.height), ARTBOARD);
        // Without it, the same source is an honest type illustration.
        assert_eq!(render(&source, None).method, Method::TypeIllustration);
    }

    #[test]
    fn every_recipe_is_repeatable() {
        // A21: same normalized input, same indices, every time.
        for (kind, media, text) in [
            (
                "document",
                "text/markdown",
                "# Title\n\nA paragraph.\n\n- a\n- b\n",
            ),
            ("diagram", "text/vnd.mermaid", "graph LR\nA-->B\nB-->C\n"),
            ("chart", "", "pie\n\"A\" : 3\n\"B\" : 2\n"),
            (
                "app",
                "text/html",
                "<body><h1>x</h1><button>a</button></body>",
            ),
            ("code", "", "fn main() {}\n"),
        ] {
            let s = Source {
                kind: kind.into(),
                media_type: media.into(),
                text: Some(text.into()),
                ..Default::default()
            };
            let a = render(&s, None);
            for _ in 0..5 {
                assert_eq!(render(&s, None).raster, a.raster, "{kind}");
            }
        }
    }
}
