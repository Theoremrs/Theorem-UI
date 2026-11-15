//! The actions the editor answers to, by id.
//!
//! The panel answers an id when `PanelMsg::Action` carries one, and offers
//! every one in its semantic nodes with its availability. [`extend_registry`]
//! lists them with the registry: the ones that start an effect, and the ones
//! the panel handles itself (`Local`). The undo, redo and find family carry
//! their chord as a default key; the others keep an in-panel chord, because
//! a bare Enter or Esc means different things by state (replace, retry,
//! create, close a popup) and a registry key would take it from typing.

use theorem_workbench_core::effect::EffectKind;
use theorem_workbench_core::ids::{ActionId, PanelKind};
use theorem_workbench_core::registry::{
    ActionDescriptor, ActionIntent, KeyScope, Registry, RegistryError,
};

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
    /// How [`extend_registry`] lists it.
    pub listed: Listed,
}

/// How an action reaches the registry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Listed {
    /// Not added: the registry has it already, or it belongs to a strip only.
    No,
    /// Starts an effect, so the root routes it to the panel.
    Sends,
    /// The panel handles it itself, with no effect of its own.
    Local,
    /// The same, and `chord` is its default key while the panel has focus.
    Keyed,
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
        listed: Listed::No,
    }
}

/// The same, for an action the panel handles itself.
const fn local(
    choice: Choice,
    id: &'static str,
    title: &'static str,
    chord: &'static str,
    requires: Option<&'static str>,
    listed: Listed,
) -> Descriptor {
    Descriptor {
        listed,
        ..d(choice, id, title, chord, requires)
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
        listed: Listed::Sends,
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
    local(
        Choice::Undo,
        "document.undo",
        "Undo",
        "Mod+Z",
        None,
        Listed::Keyed,
    ),
    local(
        Choice::Redo,
        "document.redo",
        "Redo",
        "Mod+Y",
        None,
        Listed::Keyed,
    ),
    local(
        Choice::Find,
        "document.find",
        "Find in file",
        "Mod+F",
        None,
        Listed::Keyed,
    ),
    local(
        Choice::FindNext,
        "document.findNext",
        "Next match",
        "F3",
        None,
        Listed::Keyed,
    ),
    local(
        Choice::FindPrevious,
        "document.findPrevious",
        "Previous match",
        "Shift+F3",
        None,
        Listed::Keyed,
    ),
    local(
        Choice::FindReplace,
        "document.findReplace",
        "Replace in file",
        "Mod+H",
        None,
        Listed::Keyed,
    ),
    local(
        Choice::Replace,
        "document.replace",
        "Replace",
        "Enter",
        None,
        Listed::Local,
    ),
    local(
        Choice::ReplaceAll,
        "document.replaceAll",
        "Replace all",
        "Alt+Enter",
        None,
        Listed::Local,
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
    local(
        Choice::Dismiss,
        "document.dismiss",
        "Dismiss",
        "Esc",
        None,
        Listed::Local,
    ),
    local(
        Choice::Retry,
        "document.retry",
        "Try again",
        "Enter",
        Some("documents"),
        Listed::Local,
    ),
    local(
        Choice::Close,
        "document.close",
        "Close",
        "",
        None,
        Listed::Local,
    ),
];

/// The descriptors the registry's `document` kind needs for the editor.
pub fn descriptors() -> &'static [Descriptor] {
    &TABLE
}

/// The actions [`extend_registry`] adds, as the registry takes them: those
/// that start an effect are routed to the panel as `PanelMsg::Action`, and
/// the panel's own are `Local`, which the root delivers the same way.
pub fn actions() -> Vec<ActionDescriptor> {
    TABLE
        .iter()
        .filter(|d| d.listed != Listed::No)
        .map(|d| {
            let mut action = if d.listed == Listed::Sends {
                ActionDescriptor::new(d.id, d.title, ActionIntent::Start)
            } else {
                ActionDescriptor::local(d.id, d.title)
            };
            if let Some(effect) = d.emits {
                action = action.emits(effect);
            }
            if let Some(capability) = d.requires {
                action = action.requires(capability);
            }
            if d.listed == Listed::Keyed {
                action = action.key(d.chord, KeyScope::Panel);
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
