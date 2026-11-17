//! Search, Diagnostics and Run output for the Theo Web terminal workbench.
//!
//! Each is a `Panel` over what its TypeScript owner (`src/lib/workbench/{search,language,run}`)
//! really answers, and none keeps a second copy of the owner's state machine: a search is
//! the pages the owner pushed for one id, the findings are the snapshots the language owner
//! returned per document and revision, and a run is the host's last word about it. Nothing
//! here reads a clock, the network or a terminal, so the crate builds for `wasm32`.

mod diagnostics;
mod replace;
mod run;
mod search;
mod styles;
mod text;

pub use diagnostics::{DiagnosticsPanel, actions as diagnostics_actions};
pub use run::{RunPanel, actions as run_actions};
pub use search::{SearchPanel, actions as search_actions};

use theorem_workbench_core::PanelFactories;
use theorem_workbench_core::registry::{Registry, RegistryError};

/// The kinds the builtin registry declares for these panels.
pub const SEARCH_KIND: &str = search::KIND;
pub const DIAGNOSTICS_KIND: &str = diagnostics::KIND;
pub const RUN_KIND: &str = run::KIND;

/// Registers the three panels under their builtin kinds.
pub fn register(factories: &mut PanelFactories) {
    search::register(factories);
    diagnostics::register(factories);
    run::register(factories);
}

/// Adds the panels' actions to the builtin kinds `search`, `diagnostics` and `run-output`.
/// Call it on the registry before the `Model` is built.
pub fn extend_registry(registry: &mut Registry) -> Result<(), RegistryError> {
    registry.extend_actions(&search::kind(), search::descriptors())?;
    registry.extend_actions(&diagnostics::kind(), diagnostics::descriptors())?;
    registry.extend_actions(&run::kind(), run::descriptors())
}
