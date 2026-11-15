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
mod report;
mod semantics;
mod state;
mod styles;
mod wrap;

use std::rc::Rc;

use theorem_workbench_core::PanelFactories;
use theorem_workbench_core::effect::EffectKind;
use theorem_workbench_core::ids::PanelKind;
use theorem_workbench_core::registry::{ActionDescriptor, ActionIntent, Registry, RegistryError};

pub use panel::ProcessPanel;
pub use styles::ProcessStyles;

/// The registry kind this pane serves. It is the existing `shell` kind.
pub const KIND: &str = "shell";

/// Register the pane under `shell`.
///
/// What the chooser lists comes from `HostMessage::TerminalSessions`; the
/// panes this call builds share the latest one, so a pane opened after it
/// still shows it. `load_nonce` must differ between page loads: it keeps
/// input ids and attachment names unique across reloads.
pub fn register(
    factories: &mut PanelFactories,
    styles: ProcessStyles,
    load_nonce: impl Into<String>,
) {
    let styles = Rc::new(styles);
    let catalog = catalog::Catalog::new(load_nonce);
    // A Herdr row of the Threads panel opens its session here, or focuses the
    // pane already bound to it.
    factories.register_opener(KIND, |target| {
        matches!(target, theorem_workbench_core::OpenTarget::Terminal { .. })
    });
    factories.register(KIND, move |state, _version| {
        Box::new(ProcessPanel::restore(
            state,
            catalog.clone(),
            styles.clone(),
        ))
    });
}

/// The actions the pane has beyond the registry's `shell.choose`,
/// `shell.start` and `shell.end`. Each is a workflow a person otherwise
/// reaches only by a key.
pub fn actions() -> Vec<ActionDescriptor> {
    use ActionIntent::{Create, Destroy, Start};
    vec![
        // The selected session row of the chooser.
        ActionDescriptor::new("shell.attach", "Attach to session", Create)
            .emits(EffectKind::TerminalAttach),
        ActionDescriptor::new("shell.observe", "Observe session", Create)
            .emits(EffectKind::TerminalAttach),
        // Asks the host for the lease. Taking it from another holder moves
        // that viewer to observing; the herdr-integration spec does not make
        // it a person-only act, so it is not marked human only.
        ActionDescriptor::new("shell.control", "Request control", Start)
            .emits(EffectKind::TerminalAttach),
        // Attaches to the same terminal again when only the connection to it
        // was lost. Never starts a new process.
        ActionDescriptor::new("shell.reconnect", "Reconnect to the terminal", Create)
            .emits(EffectKind::TerminalAttach),
        ActionDescriptor::new("shell.resend", "Resend unconfirmed input", Start)
            .emits(EffectKind::TerminalInput),
        // `shell.end` only asks; this confirms, and a model-origin request is
        // refused whatever it names.
        ActionDescriptor::new("shell.end.confirm", "Confirm end process", Destroy)
            .emits(EffectKind::TerminalEnd)
            .human_only(),
    ]
}

/// Add [`actions`] to the registry's `shell` kind. Call it on the registry
/// before building the `Model`.
pub fn extend_registry(registry: &mut Registry) -> Result<(), RegistryError> {
    registry.extend_actions(&PanelKind::new(KIND), actions())
}
