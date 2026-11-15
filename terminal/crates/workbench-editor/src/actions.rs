//! The actions the editor answers to, by id.
//!
//! The panel answers an id when `PanelMsg::Action` carries one, and offers
//! every one in its semantic nodes with its availability. The registry routes
//! an action to the panel only when its intent may emit an effect, so
//! [`extend_registry`] registers the actions that do (save, format, the
//! choices over held text, and the rest listed with `routed`); the others
//! (undo, find, the popups) are panel-local and are reached by their chord and
//! by their node's action id, never by the palette.

use theorem_workbench_core::effect::EffectKind;
use theorem_workbench_core::ids::{ActionId, PanelKind};
use theorem_workbench_core::registry::{ActionDescriptor, ActionIntent, Registry, RegistryError};

use crate::panel::KIND;

/// Everything a person can choose in the editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    Save,
    Undo,
    Redo,
    Find,
    FindNext,
    FindPrevious,
    FindReplace,
    Replace,
    ReplaceAll,
    Rename,
    Format,
    ApplyPlan,
    Hover,
    Complete,
    Definition,
    References,
    Check,
    KeepMine,
    TakeTheirs,
    KeepBoth,
    CopyMine,
    Resend,
    KeepDisk,
    KeepAuthority,
    Create,
    Dismiss,
    Retry,
    Close,
}

/// One action as the registry would list it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Descriptor {
    pub choice: Choice,
    pub id: &'static str,
    pub title: &'static str,
    /// The chord the panel answers to, in the key table's syntax. Empty for an
    /// action reached only by the strip it belongs to.
    pub chord: &'static str,
    /// The capability the action needs, when it needs one.
    pub requires: Option<&'static str>,
    /// The effect the action sends, when choosing it sends one.
    pub emits: Option<EffectKind>,
    /// Whether [`extend_registry`] adds it: the action sends an effect and the
    /// registry does not list it already.
    pub routed: bool,
}

const fn d(
    choice: Choice,
    id: &'static str,
    title: &'static str,
    chord: &'static str,
    requires: Option<&'static str>,
) -> Descriptor {
    Descriptor {
        choice,
        id,
        title,
        chord,
        requires,
        emits: None,
        routed: false,
    }
}

/// The same, for an action that sends `effect` when chosen.
const fn sends(
    choice: Choice,
    id: &'static str,
    title: &'static str,
    chord: &'static str,
    requires: Option<&'static str>,
    effect: EffectKind,
) -> Descriptor {
    Descriptor {
        emits: Some(effect),
        routed: true,
        ..d(choice, id, title, chord, requires)
    }
}

const TABLE: [Descriptor; 28] = [
    sends(
        Choice::Save,
        "document.save",
        "Save",
        "Mod+S",
        Some("documents"),
        EffectKind::DocumentSave,
    ),
    d(Choice::Undo, "document.undo", "Undo", "Mod+Z", None),
    d(Choice::Redo, "document.redo", "Redo", "Mod+Shift+Z", None),
    d(Choice::Find, "document.find", "Find in file", "Mod+F", None),
    d(
        Choice::FindNext,
        "document.findNext",
        "Next match",
        "F3",
        None,
    ),
    d(
        Choice::FindPrevious,
        "document.findPrevious",
        "Previous match",
        "Shift+F3",
        None,
    ),
    d(
        Choice::FindReplace,
        "document.findReplace",
        "Replace in file",
        "Mod+H",
        None,
    ),
    d(
        Choice::Replace,
        "document.replace",
        "Replace",
        "Enter",
        None,
    ),
    d(
        Choice::ReplaceAll,
        "document.replaceAll",
        "Replace all",
        "Alt+Enter",
        None,
    ),
    sends(
        Choice::Rename,
        "document.rename",
        "Rename symbol",
        "F2",
        Some("language"),
        EffectKind::LanguageRename,
    ),
    sends(
        Choice::Format,
        "document.format",
        "Format document",
        "Alt+Shift+F",
        Some("language"),
        EffectKind::LanguageFormat,
    ),
    sends(
        Choice::ApplyPlan,
        "document.applyPlan",
        "Apply the rename",
        "Alt+A",
        Some("language"),
        EffectKind::LanguageApplyPlan,
    ),
    sends(
        Choice::Hover,
        "document.hover",
        "Show hover",
        "Alt+H",
        Some("language"),
        EffectKind::LanguageHover,
    ),
    sends(
        Choice::Complete,
        "document.complete",
        "Complete",
        "Ctrl+Space",
        Some("language"),
        EffectKind::LanguageComplete,
    ),
    sends(
        Choice::Definition,
        "document.definition",
        "Go to definition",
        "F12",
        Some("language"),
        EffectKind::LanguageNavigate,
    ),
    sends(
        Choice::References,
        "document.references",
        "Find references",
        "Shift+F12",
        Some("language"),
        EffectKind::LanguageReferences,
    ),
    sends(
        Choice::Check,
        "document.check",
        "Check the file",
        "Alt+X",
        Some("language"),
        EffectKind::LanguageDiagnostics,
    ),
    sends(
        Choice::KeepMine,
        "document.keepMine",
        "Keep my text",
        "Alt+M",
        Some("documents"),
        EffectKind::DocumentSettle,
    ),
    sends(
        Choice::TakeTheirs,
        "document.takeTheirs",
        "Take their text",
        "Alt+T",
        Some("documents"),
        EffectKind::DocumentSettle,
    ),
    sends(
        Choice::KeepBoth,
        "document.keepBoth",
        "Keep both",
        "Alt+B",
        Some("documents"),
        EffectKind::DocumentSettle,
    ),
    sends(
        Choice::CopyMine,
        "document.copyMine",
        "Copy my text",
        "Alt+Y",
        None,
        EffectKind::ClipboardWrite,
    ),
    sends(
        Choice::Resend,
        "document.resend",
        "Send the edit again",
        "Alt+R",
        Some("documents"),
        EffectKind::DocumentEdit,
    ),
    sends(
        Choice::KeepDisk,
        "document.keepDisk",
        "Take the file on disk",
        "Alt+D",
        Some("documents"),
        EffectKind::DocumentReconcile,
    ),
    sends(
        Choice::KeepAuthority,
        "document.keepAuthority",
        "Keep the editor's text",
        "Alt+K",
        Some("documents"),
        EffectKind::DocumentReconcile,
    ),
    // The registry lists `page.create` itself, for the `document` kind.
    Descriptor {
        emits: Some(EffectKind::DocumentCreate),
        ..d(
            Choice::Create,
            "page.create",
            "Create page",
            "Enter",
            Some("documents"),
        )
    },
    d(Choice::Dismiss, "document.dismiss", "Dismiss", "Esc", None),
    d(
        Choice::Retry,
        "document.retry",
        "Try again",
        "Enter",
        Some("documents"),
    ),
    d(Choice::Close, "document.close", "Close", "", None),
];

/// The descriptors the registry's `document` kind needs for the editor.
pub fn descriptors() -> &'static [Descriptor] {
    &TABLE
}

/// The actions [`extend_registry`] adds, as the registry takes them: each
/// starts an effect, so the root routes it to the panel as `PanelMsg::Action`.
pub fn actions() -> Vec<ActionDescriptor> {
    TABLE
        .iter()
        .filter(|d| d.routed)
        .map(|d| {
            let mut action = ActionDescriptor::new(d.id, d.title, ActionIntent::Start);
            if let Some(effect) = d.emits {
                action = action.emits(effect);
            }
            if let Some(capability) = d.requires {
                action = action.requires(capability);
            }
            action
        })
        .collect()
}

/// Add the editor's actions to the registry's `document` kind, so the
/// palette, the picker and an agent can route them. Call it on the registry
/// before building the `Model`.
pub fn extend_registry(registry: &mut Registry) -> Result<(), RegistryError> {
    registry.extend_actions(&PanelKind::new(KIND), actions())
}

impl Choice {
    pub fn descriptor(self) -> &'static Descriptor {
        TABLE
            .iter()
            .find(|d| d.choice == self)
            .expect("every choice has a descriptor")
    }

    pub fn id(self) -> &'static str {
        self.descriptor().id
    }

    pub fn action_id(self) -> ActionId {
        ActionId::new(self.id())
    }

    pub fn from_id(id: &str) -> Option<Self> {
        TABLE.iter().find(|d| d.id == id).map(|d| d.choice)
    }
}
