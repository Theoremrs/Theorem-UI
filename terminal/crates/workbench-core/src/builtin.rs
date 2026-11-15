//! The panels registered at start (ARCHITECTURE section 6). Data only: each
//! panel's factory and view-state serializer live with the panel itself.
//!
//! Cell minimums and default shortcuts are starting values for the dock and
//! the visual pass to tune. The shortcuts avoid chords browsers reserve.

use crate::effect::EffectKind;
use crate::ids::{Capability, PanelKind, ResourceKind};
use crate::registry::{
    ActionDescriptor,
    ActionIntent::{Create, Destroy, Focus, Open, Start},
    BodyKind, CellSize, KeyScope, PanelDescriptor, Placement, Registry,
};
use crate::semantics::Role;

struct Spec {
    kind: &'static str,
    title: &'static str,
    icon: &'static str,
    binding: ResourceKind,
    placement: Placement,
    min: (u16, u16),
    role: Role,
    theme_roles: &'static [&'static str],
    requires: &'static [&'static str],
}

impl Spec {
    fn build(self, actions: Vec<ActionDescriptor>) -> PanelDescriptor {
        PanelDescriptor {
            kind: PanelKind::new(self.kind),
            version: 1,
            title: self.title.to_owned(),
            icon: self.icon.to_owned(),
            body: BodyKind::Drawn,
            binding: self.binding,
            actions,
            requires: self.requires.iter().map(|c| Capability::new(*c)).collect(),
            min_size: CellSize {
                cols: self.min.0,
                rows: self.min.1,
            },
            default_placement: self.placement,
            theme_roles: self.theme_roles.iter().map(|r| (*r).to_owned()).collect(),
            semantic_role: self.role,
        }
    }
}

const CHROME: &[&str] = &[
    "chrome.bg",
    "chrome.text",
    "chrome.muted",
    "chrome.line",
    "chrome.focus",
];
const DIFF: &[&str] = &[
    "chrome.bg",
    "chrome.text",
    "diff.addedLine",
    "diff.removedLine",
    "diff.addedWords",
    "diff.removedWords",
];

/// The registry every surface resolves through.
pub fn registry() -> Registry {
    use Placement::{Left, Main, Tools};
    use ResourceKind as R;
    let panels = vec![
        Spec {
            kind: "files",
            title: "Files",
            icon: "folder",
            binding: R::Workspace,
            placement: Left,
            min: (20, 6),
            role: Role::Tree,
            theme_roles: CHROME,
            requires: &["files"],
        }
        .build(vec![
            ActionDescriptor::new("files.focus", "Files", Focus)
                .row(3)
                .key("Mod+Alt+E", KeyScope::Global),
        ]),
        Spec {
            kind: "theo",
            title: "Theo",
            icon: "theo",
            binding: R::Conversation,
            placement: Main,
            min: (40, 10),
            role: Role::Region,
            theme_roles: CHROME,
            requires: &[],
        }
        .build(vec![
            ActionDescriptor::new("theo.focus", "Theo", Focus),
            // Turns and thread changes start work: none is a Focus or Open
            // action, and none is reachable from the picker.
            ActionDescriptor::new("theo.send", "Send", Start).emits(EffectKind::ConversationSend),
            ActionDescriptor::new("theo.retry", "Retry", Start)
                .emits(EffectKind::ConversationRetry),
            ActionDescriptor::new("theo.edit", "Edit and resend", Start)
                .emits(EffectKind::ConversationEdit),
            ActionDescriptor::new("theo.switch", "Switch conversation", Start)
                .emits(EffectKind::ConversationSwitch),
            ActionDescriptor::new("theo.new", "New conversation", Create)
                .emits(EffectKind::ConversationCreate),
            // Stopping a run is destroying: closing the view must never do it.
            ActionDescriptor::new("theo.stop", "Stop", Destroy)
                .emits(EffectKind::ConversationCancel),
            // An approval is the person's decision. A model-origin request
            // for either is refused (R34, AC-44).
            ActionDescriptor::new("approval.allow", "Allow", Start)
                .emits(EffectKind::ConversationApproval)
                .human_only(),
            ActionDescriptor::new("approval.deny", "Deny", Destroy)
                .emits(EffectKind::ConversationApproval)
                .human_only(),
        ]),
        Spec {
            kind: "picker",
            title: "Add tool",
            icon: "plus",
            binding: R::None,
            placement: Tools,
            min: (24, 8),
            role: Role::Menu,
            theme_roles: CHROME,
            requires: &[],
        }
        .build(vec![
            ActionDescriptor::new("picker.open", "Add tool", Open)
                .key("Mod+Alt+T", KeyScope::Global),
            ActionDescriptor::new("picker.more", "More tools", Open).row(6),
            // Escape is the picker's fixed way back and Left walks it
            // sideways; these are the same moves by name, for the agent and
            // the palette. Pinning takes a chord because typing is the filter.
            ActionDescriptor::new("picker.back", "Back", Open),
            ActionDescriptor::new("picker.toggle-pin", "Pin or unpin tool", Open)
                .key("Mod+Alt+P", KeyScope::Panel),
        ]),
        Spec {
            kind: "changes",
            title: "Changes",
            icon: "git-branch",
            binding: R::Repository,
            placement: Tools,
            min: (32, 8),
            role: Role::Region,
            theme_roles: DIFF,
            requires: &["scm"],
        }
        .build(vec![
            ActionDescriptor::new("changes.open", "Changes", Open)
                .row(1)
                .key("Mod+Alt+G", KeyScope::Global),
        ]),
        Spec {
            kind: "shell",
            title: "Shell",
            icon: "terminal",
            binding: R::Terminal,
            placement: Tools,
            min: (40, 8),
            role: Role::Region,
            theme_roles: CHROME,
            requires: &["environment"],
        }
        .build(vec![
            // The row opens the chooser of profiles and existing sessions;
            // nothing starts until a profile is chosen in it.
            ActionDescriptor::new("shell.choose", "Shell", Open)
                .starts("process")
                .row(2)
                .key("Mod+Alt+S", KeyScope::Global),
            ActionDescriptor::new("shell.start", "Start shell", Start)
                .emits(EffectKind::TerminalOpen),
            ActionDescriptor::new("shell.end", "End process", Destroy)
                .emits(EffectKind::TerminalEnd),
        ]),
        Spec {
            kind: "side-chat",
            title: "Side chat",
            icon: "message",
            binding: R::Conversation,
            placement: Tools,
            min: (32, 8),
            role: Role::Region,
            theme_roles: CHROME,
            requires: &[],
        }
        .build(vec![
            ActionDescriptor::new("side-chat.choose", "Side chat", Open)
                .row(4)
                .key("Mod+Alt+L", KeyScope::Global),
            ActionDescriptor::new("side-chat.create", "New side chat", Create)
                .emits(EffectKind::ConversationCreate),
        ]),
        Spec {
            kind: "document",
            title: "Page",
            icon: "file",
            binding: R::Document,
            placement: Tools,
            min: (40, 8),
            role: Role::Region,
            theme_roles: CHROME,
            requires: &["documents"],
        }
        .build(vec![
            // The row asks for a name; only confirming it creates anything,
            // so cancelling leaves no orphan.
            ActionDescriptor::new("page.new", "New page", Open)
                .creates("document")
                .row(5)
                .key("Mod+Alt+N", KeyScope::Global),
            ActionDescriptor::new("page.create", "Create page", Create)
                .emits(EffectKind::DocumentCreate),
        ]),
        Spec {
            kind: "cabinet",
            title: "Artifacts",
            icon: "archive",
            binding: R::Project,
            placement: Tools,
            min: (32, 8),
            role: Role::Region,
            theme_roles: CHROME,
            requires: &["artifacts"],
        }
        .build(vec![
            ActionDescriptor::new("cabinet.open", "Artifacts", Open).more(),
        ]),
        Spec {
            kind: "diagnostics",
            title: "Diagnostics",
            icon: "alert",
            binding: R::Document,
            placement: Tools,
            min: (32, 6),
            role: Role::Region,
            theme_roles: CHROME,
            requires: &["language"],
        }
        .build(vec![
            ActionDescriptor::new("diagnostics.open", "Diagnostics", Open).more(),
        ]),
        Spec {
            kind: "run-output",
            title: "Run output",
            icon: "play",
            binding: R::Workspace,
            placement: Tools,
            min: (32, 6),
            role: Role::Log,
            theme_roles: CHROME,
            requires: &["run"],
        }
        .build(vec![
            ActionDescriptor::new("run-output.open", "Run output", Open).more(),
        ]),
        Spec {
            kind: "search",
            title: "Search",
            icon: "search",
            binding: R::Workspace,
            placement: Tools,
            min: (32, 6),
            role: Role::Region,
            theme_roles: CHROME,
            requires: &["search"],
        }
        .build(vec![
            ActionDescriptor::new("search.open", "Search", Open).more(),
        ]),
        Spec {
            kind: "history",
            title: "History",
            icon: "history",
            binding: R::Repository,
            placement: Tools,
            min: (32, 6),
            role: Role::Region,
            theme_roles: DIFF,
            requires: &["scm"],
        }
        .build(vec![
            ActionDescriptor::new("history.open", "History", Open).more(),
        ]),
    ];
    let mut reg = Registry::new();
    for panel in panels {
        reg.register(panel)
            .expect("the built-in panels are consistent");
    }
    reg
}
