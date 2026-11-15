//! Panels of the Theo Web terminal workbench, each written against the core's
//! `Panel` trait and nothing else.

pub mod files;

use theorem_workbench_core::PanelFactories;

pub use files::FilesPanel;

/// Register every panel this crate provides.
pub fn register(factories: &mut PanelFactories) {
    files::register(factories);
}
