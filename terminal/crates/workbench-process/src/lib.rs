//! The process (shell) pane of the Theo workbench: a `Panel` that attaches to
//! a host terminal and draws it with `workbench-vt`.
//!
//! The pane never starts anything on its own. Opening Shell shows what could
//! be bound to; one choice emits one effect. Closing the pane detaches; only
//! the separately named End process action ends a program, and it asks first.

mod bound;
mod catalog;
mod chooser;
mod control;
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

/// An agent run asks for the input claim on a shell's terminal.
pub const ACTION_CODE_CLAIM: &str = "code.claim";
/// An agent run gives its input claim up; the process keeps running.
pub const ACTION_CODE_RELEASE: &str = "code.release";
/// The person ends their takeover of a terminal an agent was typing into.
pub const ACTION_SHELL_HAND_BACK: &str = "shell.hand_back";

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
    use ActionIntent::{Create, Destroy, Local, Start};
    vec![
        // The selected session row of the chooser.
        ActionDescriptor::new("shell.attach", "Attach to session", Create)
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
        // Agent input control (IN-02, IN-03, Gate 0 decision 1). There is no
        // lease between the person's views; these arbitrate agent input.
        // They change no host state, so they are local to the pane.
        ActionDescriptor::new(ACTION_CODE_CLAIM, "Claim agent input", Local),
        ActionDescriptor::new(ACTION_CODE_RELEASE, "Release agent input", Local),
        ActionDescriptor::new(ACTION_SHELL_HAND_BACK, "Hand back to the agent", Local)
            .human_only(),
    ]
}

/// Add [`actions`] to the registry's `shell` kind. Call it on the registry
/// before building the `Model`.
pub fn extend_registry(registry: &mut Registry) -> Result<(), RegistryError> {
    registry.extend_actions(&PanelKind::new(KIND), actions())
}
