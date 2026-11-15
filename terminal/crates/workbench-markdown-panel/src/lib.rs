//! The Markdown panel of the Theo Web terminal workbench.
//!
//! One document session shows as Visual, Source, Split or Preview. Source is
//! the editor crate's `SourceView` over the very session the Markdown model
//! holds; the rendered modes read the same text, so there is no second buffer
//! to keep in step. Edits go to the document owner as the editor sends them:
//! in order, one in flight, with the base revision and an operation id.
//!
//! * `panel`: the state machine, its answers from the owner, its input and its cells.
//! * `actions`: the `markdown.*` actions and their registry entries.
//! * `links`: links and task boxes of the text, read from the Markdown model's tree.
//! * `styles`: the roles the panel draws with.

mod actions;
mod links;
mod panel;
mod styles;
mod visible;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use theorem_workbench_core::ids::ResourceRef;
use theorem_workbench_core::{OPENER_SPECIFIC, OpenTarget, PanelFactories};
use theorem_workbench_markdown::MarkdownDoc;

pub use actions::{Choice, Descriptor, actions, descriptors, extend_registry};
pub use panel::MarkdownPanel;
pub use styles::MarkdownPanelStyles;

/// The panel kind this crate registers.
pub const KIND: &str = "markdown";

/// The files this panel opens ahead of the plain editor.
fn is_markdown(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".md", ".markdown", ".mdx"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// Documents of closed panels that still hold text the owner has not accepted,
/// with the block that was open in them. The owner keeps the draft in the end;
/// until it does, reopening the same document gets its own session back, with
/// its undo history, its unsent edits and the text typed in its open block.
#[derive(Clone, Default)]
pub struct Drafts(Rc<RefCell<BTreeMap<ResourceRef, MarkdownDoc>>>);

impl Drafts {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.0.borrow().len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.borrow().is_empty()
    }

    pub fn holds(&self, resource: &ResourceRef) -> bool {
        self.0.borrow().contains_key(resource)
    }

    pub(crate) fn put(&self, resource: ResourceRef, doc: MarkdownDoc) {
        self.0.borrow_mut().insert(resource, doc);
    }

    pub(crate) fn take(&self, resource: &ResourceRef) -> Option<MarkdownDoc> {
        self.0.borrow_mut().remove(resource)
    }
}

/// Register the panel as the `markdown` kind and as the opener of Markdown
/// files, at the specific priority: it opens them ahead of the editor whatever
/// the order the two are registered in.
pub fn register(factories: &mut PanelFactories) {
    register_with(factories, Drafts::new());
}

/// [`register`], with the drafts store the caller keeps hold of.
pub fn register_with(factories: &mut PanelFactories, drafts: Drafts) {
    factories.register(KIND, move |state, _version| {
        Box::new(MarkdownPanel::restore(state, drafts.clone()))
    });
    // Specific: the editor claims every file, and this claims Markdown ahead of
    // it whichever of the two registered first.
    factories.register_opener_with(KIND, OPENER_SPECIFIC, |target| match target {
        OpenTarget::File { path, .. } | OpenTarget::FileAt { path, .. } => is_markdown(path),
        _ => false,
    });
}
