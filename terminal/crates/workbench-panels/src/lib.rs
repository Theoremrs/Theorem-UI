//! Panels of the Theo Web terminal workbench, each written against the core's
//! `Panel` trait and nothing else.

pub mod caret;
pub mod clip;
pub mod files;
pub mod threads;

use theorem_workbench_core::PanelFactories;

pub use files::FilesPanel;
pub use threads::ThreadsPanel;

/// Register every panel this crate provides.
pub fn register(factories: &mut PanelFactories) {
    files::register(factories);
    threads::register(factories);
}
