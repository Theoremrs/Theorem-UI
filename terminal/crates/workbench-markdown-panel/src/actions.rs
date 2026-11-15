//! The actions the Markdown panel answers to, by id.
//!
//! The panel answers an id when `PanelMsg::Action` carries one, and offers
//! every one in its semantic nodes with its availability. [`extend_registry`]
//! registers them all under `markdown`: the ones that send an effect (save, a
//! checkbox toggle, settling held text, reconciling with the disk) start one,
//! and the rest (mode switches, opening a block, moving between blocks and
//! links) are local actions that only change what the panel shows.

use theorem_workbench_core::effect::EffectKind;
use theorem_workbench_core::ids::{ActionId, PanelKind, ResourceKind};
use theorem_workbench_core::registry::{
    ActionDescriptor, ActionIntent, BodyKind, CellSize, PanelDescriptor, Placement, Registry,
    RegistryError,
};
use theorem_workbench_core::semantics::Role;
use theorem_workbench_markdown::MarkdownMode;

use theorem_workbench_text::recovery;

use crate::KIND;

/// Everything a person can choose in the Markdown panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    Visual,
    Source,
    Split,
    Preview,
    ToggleCheckbox,
    OpenBlock,
    CloseBlock,
    NextBlock,
    PreviousBlock,
    OpenLink,
    NextLink,
    PreviousLink,
    Save,
    KeepMine,
    TakeTheirs,
    KeepBoth,
    CopyMine,
    CopyRecovered,
    Resend,
    KeepDisk,
    KeepAuthority,
    KeepRecovered,
    DiscardRecovered,
    Dismiss,
    Retry,
    Close,
}

impl Choice {
    /// The choice that switches to `mode`.
    pub fn of_mode(mode: MarkdownMode) -> Self {
        match mode {
            MarkdownMode::Visual => Self::Visual,
            MarkdownMode::Source => Self::Source,
            MarkdownMode::Split => Self::Split,
            MarkdownMode::Preview => Self::Preview,
        }
    }

    /// The mode a switch choice goes to.
    pub fn mode(self) -> Option<MarkdownMode> {
        match self {
            Self::Visual => Some(MarkdownMode::Visual),
            Self::Source => Some(MarkdownMode::Source),
            Self::Split => Some(MarkdownMode::Split),
            Self::Preview => Some(MarkdownMode::Preview),
            _ => None,
        }
    }
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
    /// The effect the action sends, when choosing it sends one. Such an action
    /// is the one [`extend_registry`] adds.
    pub emits: Option<EffectKind>,
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
    }
}

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
        ..d(choice, id, title, chord, requires)
    }
}

const TABLE: [Descriptor; 26] = [
    d(
        Choice::Visual,
        "markdown.mode.visual",
        "Visual mode",
        "Alt+1",
        None,
    ),
    d(
        Choice::Source,
        "markdown.mode.source",
        "Source mode",
        "Alt+2",
        None,
    ),
    d(
        Choice::Split,
        "markdown.mode.split",
        "Split mode",
        "Alt+3",
        None,
    ),
    d(
        Choice::Preview,
        "markdown.mode.preview",
        "Preview mode",
        "Alt+4",
        None,
    ),
    sends(
        Choice::ToggleCheckbox,
        "markdown.checkbox.toggle",
        "Toggle checkbox",
        "Alt+X",
        Some("documents"),
        EffectKind::DocumentEdit,
    ),
    d(
        Choice::OpenBlock,
        "markdown.block.open",
        "Edit this block",
        "Enter",
        None,
    ),
    d(
        Choice::CloseBlock,
        "markdown.block.close",
        "Close the block",
        "Esc",
        None,
    ),
    d(
        Choice::NextBlock,
        "markdown.block.next",
        "Next block",
        "Alt+Down",
        None,
    ),
    d(
        Choice::PreviousBlock,
        "markdown.block.previous",
        "Previous block",
        "Alt+Up",
        None,
    ),
    d(
        Choice::OpenLink,
        "markdown.link.open",
        "Open link",
        "Alt+Enter",
        None,
    ),
    d(
        Choice::NextLink,
        "markdown.link.next",
        "Next link",
        "Tab",
        None,
    ),
    d(
        Choice::PreviousLink,
        "markdown.link.previous",
        "Previous link",
        "Shift+Tab",
        None,
    ),
    sends(
        Choice::Save,
        "markdown.save",
        "Save",
        "Mod+S",
        Some("documents"),
        EffectKind::DocumentSave,
    ),
    sends(
        Choice::KeepMine,
        "markdown.resolve.keepMine",
        recovery::KEEP_MINE_TITLE,
        "Alt+M",
        Some("documents"),
        EffectKind::DocumentSettle,
    ),
    sends(
        Choice::TakeTheirs,
        "markdown.resolve.takeTheirs",
        recovery::TAKE_THEIRS_TITLE,
        "Alt+T",
        Some("documents"),
        EffectKind::DocumentSettle,
    ),
    sends(
        Choice::KeepBoth,
        "markdown.resolve.keepBoth",
        recovery::KEEP_BOTH_TITLE,
        "Alt+B",
        Some("documents"),
        EffectKind::DocumentSettle,
    ),
    d(
        Choice::CopyMine,
        "markdown.resolve.copyMine",
        recovery::COPY_MINE_TITLE,
        "Alt+Y",
        None,
    ),
    d(
        Choice::CopyRecovered,
        "markdown.recovered.copy",
        recovery::COPY_TITLE,
        "",
        None,
    ),
    sends(
        Choice::Resend,
        "markdown.resend",
        "Send the edit again",
        "Alt+R",
        Some("documents"),
        EffectKind::DocumentEdit,
    ),
    sends(
        Choice::KeepDisk,
        "markdown.disk.keepDisk",
        "Take the file on disk",
        "Alt+D",
        Some("documents"),
        EffectKind::DocumentReconcile,
    ),
    sends(
        Choice::KeepAuthority,
        "markdown.disk.keepAuthority",
        "Keep the editor's text",
        "Alt+K",
        Some("documents"),
        EffectKind::DocumentReconcile,
    ),
    sends(
        Choice::KeepRecovered,
        "markdown.recovered.keep",
        recovery::KEEP_TITLE,
        recovery::KEEP_CHORD,
        Some("documents"),
        EffectKind::DocumentSettle,
    ),
    sends(
        Choice::DiscardRecovered,
        "markdown.recovered.discard",
        recovery::DISCARD_TITLE,
        recovery::DISCARD_CHORD,
        Some("documents"),
        EffectKind::DocumentSettle,
    ),
    d(Choice::Dismiss, "markdown.dismiss", "Dismiss", "Esc", None),
    sends(
        Choice::Retry,
        "markdown.retry",
        "Try again",
        "Enter",
        Some("documents"),
        EffectKind::DocumentOpen,
    ),
    d(Choice::Close, "markdown.close", "Close", "", None),
];

/// Every action, in the order the panel lists them.
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

    /// The choice that answers a button of the recovered-edits bar.
    pub fn from_offer(offer: recovery::Offer) -> Self {
        use recovery::Offer;
        match offer {
            Offer::Keep => Self::KeepRecovered,
            Offer::Discard => Self::DiscardRecovered,
            Offer::Copy => Self::CopyRecovered,
            Offer::TakeTheirs => Self::TakeTheirs,
            Offer::KeepBoth => Self::KeepBoth,
            Offer::CopyMine => Self::CopyMine,
            Offer::KeepMine => Self::KeepMine,
        }
    }

    pub fn action_id(self) -> ActionId {
        ActionId::new(self.id())
    }

    pub fn from_id(id: &str) -> Option<Self> {
        TABLE.iter().find(|d| d.id == id).map(|d| d.choice)
    }
}

/// The actions [`extend_registry`] adds. Those that send an effect start one
/// and the root routes them to the panel as `PanelMsg::Action`; the rest only
/// change what the panel shows and are local to it.
pub fn actions() -> Vec<ActionDescriptor> {
    TABLE
        .iter()
        // Retry only re-opens, and the strip draws it; Close is the core's.
        .filter(|d| !matches!(d.choice, Choice::Retry | Choice::Close))
        .map(|d| {
            let mut action = match d.emits {
                Some(effect) => {
                    ActionDescriptor::new(d.id, d.title, ActionIntent::Start).emits(effect)
                }
                None => ActionDescriptor::local(d.id, d.title),
            };
            if let Some(capability) = d.requires {
                action = action.requires(capability);
            }
            action
        })
        .collect()
}

/// The `markdown` kind as the registry lists it, for a registry built before
/// this panel existed: the built-in set has no `markdown` kind, and
/// `extend_actions` refuses a kind nobody registered.
fn descriptor() -> PanelDescriptor {
    PanelDescriptor {
        kind: PanelKind::new(KIND),
        version: 1,
        title: "Markdown".to_owned(),
        icon: "file".to_owned(),
        body: BodyKind::Drawn,
        binding: ResourceKind::Document,
        actions: vec![],
        requires: vec![theorem_workbench_core::Capability::new("documents")],
        min_size: CellSize { cols: 40, rows: 8 },
        default_placement: Placement::Tools,
        theme_roles: [
            "chrome.bg",
            "chrome.text",
            "chrome.muted",
            "chrome.line",
            "chrome.focus",
            "state.error",
            "state.warning",
        ]
        .iter()
        .map(|r| (*r).to_owned())
        .collect(),
        semantic_role: Role::Document,
    }
}

/// Add the panel's actions to the registry's `markdown` kind, registering the
/// kind first when the registry does not list it. Call it on the registry
/// before building the `Model`.
pub fn extend_registry(registry: &mut Registry) -> Result<(), RegistryError> {
    let kind = PanelKind::new(KIND);
    if registry.get(&kind).is_none() {
        registry.register(descriptor())?;
    }
    registry.extend_actions(&kind, actions())
}
