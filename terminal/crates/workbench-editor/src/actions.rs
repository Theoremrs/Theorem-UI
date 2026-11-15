//! The actions the editor answers to, by id.
//!
//! The core's registry is static (`builtin.rs`) and lists only `page.new` and
//! `page.create` for the `document` kind, so the ids here are not yet
//! routable by the palette, the picker or an agent. The panel answers them
//! when `PanelMsg::Action` carries one, and offers them in its semantic nodes
//! with their availability, so adding the descriptors in [`descriptors`] to
//! the registry is all the core owes.

use theorem_workbench_core::ids::ActionId;

/// Everything a person can choose in the editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    Save,
    Undo,
    Redo,
    Find,
    FindNext,
    FindPrevious,
    Rename,
    Format,
    ApplyPlan,
    KeepMine,
    TakeTheirs,
    KeepBoth,
    CopyMine,
    Resend,
    KeepDisk,
    KeepAuthority,
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
    }
}

const TABLE: [Descriptor; 19] = [
    d(
        Choice::Save,
        "document.save",
        "Save",
        "Mod+S",
        Some("documents"),
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
        Choice::Rename,
        "document.rename",
        "Rename symbol",
        "F2",
        Some("language"),
    ),
    d(
        Choice::Format,
        "document.format",
        "Format document",
        "Alt+Shift+F",
        Some("language"),
    ),
    d(
        Choice::ApplyPlan,
        "document.applyPlan",
        "Apply the rename",
        "Alt+A",
        Some("language"),
    ),
    d(
        Choice::KeepMine,
        "document.keepMine",
        "Keep my text",
        "Alt+M",
        Some("documents"),
    ),
    d(
        Choice::TakeTheirs,
        "document.takeTheirs",
        "Take their text",
        "Alt+T",
        Some("documents"),
    ),
    d(
        Choice::KeepBoth,
        "document.keepBoth",
        "Keep both",
        "Alt+B",
        Some("documents"),
    ),
    d(
        Choice::CopyMine,
        "document.copyMine",
        "Copy my text",
        "Alt+Y",
        None,
    ),
    d(
        Choice::Resend,
        "document.resend",
        "Send the edit again",
        "Alt+R",
        Some("documents"),
    ),
    d(
        Choice::KeepDisk,
        "document.keepDisk",
        "Take the file on disk",
        "Alt+D",
        Some("documents"),
    ),
    d(
        Choice::KeepAuthority,
        "document.keepAuthority",
        "Keep the editor's text",
        "Alt+K",
        Some("documents"),
    ),
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
