//! The process (shell) pane of the Theo workbench: a `Panel` that attaches to
//! a host terminal and draws it with `workbench-vt`.
//!
//! The pane never starts anything on its own. Opening Shell shows what could
//! be bound to; one choice emits one effect. Closing the pane detaches; only
//! the separately named End process action ends a program, and it asks first.

mod bound;
mod catalog;
mod chooser;
mod draw;
mod keys;
mod panel;
mod semantics;
mod state;
mod styles;

use std::rc::Rc;

use theorem_workbench_core::PanelFactories;

pub use catalog::{CatalogData, ProcessCatalog, ProcessProfile, ProcessSession, SessionState};
pub use panel::ProcessPanel;
pub use styles::ProcessStyles;

/// The registry kind this pane serves. It is the existing `shell` kind.
pub const KIND: &str = "shell";

/// Register the pane under `shell`. `catalog` is where the chooser reads the
/// host's sessions and profiles from; `styles` carries the ANSI palette.
pub fn register(factories: &mut PanelFactories, catalog: ProcessCatalog, styles: ProcessStyles) {
    let styles = Rc::new(styles);
    factories.register(KIND, move |state, _version| {
        Box::new(ProcessPanel::restore(
            state,
            catalog.clone(),
            styles.clone(),
        ))
    });
}
