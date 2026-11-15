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
                .glyph("\u{25a1}")
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
            ActionDescriptor::new("theo.branch", "Select branch", Start)
                .emits(EffectKind::ConversationSwitchBranch),
            // The composer's controls: each exists only where the host can do
            // what it asks, and is the person's to use or the agent's to call.
            ActionDescriptor::new("theo.attach", "Attach files", Start)
                .emits(EffectKind::ConversationAttachPick)
                .requires("conversation.attach"),
            ActionDescriptor::new("theo.model", "Choose model", Start)
                .emits(EffectKind::ConversationModels)
                .emits(EffectKind::ConversationSetModel)
                .requires("conversation.model"),
            ActionDescriptor::new("theo.effort", "Set effort", Start)
                .emits(EffectKind::ConversationSetEffort)
                .requires("conversation.model"),
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
            ActionDescriptor::new("picker.more", "More tools", Open)
                .row(6)
                .glyph("\u{25a6}"),
            // Escape is the picker's fixed way back and Left walks it
            // sideways; these are the same moves by name, for the agent and
            // the palette. Pinning takes a chord because typing is the filter.
            // The built-in presets and the account's saved arrangements. The
            // page's own moves are named too, so a chord, the palette and the
            // semantic mirror reach what the keys do: rename and delete act on
            // the highlighted saved layout.
            ActionDescriptor::new("picker.layout.rename", "Rename layout", Open)
                .key("Mod+Alt+R", KeyScope::Panel),
            ActionDescriptor::new("picker.layout.delete", "Delete layout", Open)
                .key("Mod+Alt+D", KeyScope::Panel),
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
            ActionDescriptor::new("changes.open", "Changes", Focus)
                .row(1)
                .glyph("\u{00b1}")
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
                .glyph("\u{203a}")
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
            requires: &["conversation.side"],
        }
        .build(vec![
            ActionDescriptor::new("side-chat.choose", "Side chat", Open)
                .row(4)
                .glyph("\u{2295}")
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
                .glyph("\u{2261}")
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
            ActionDescriptor::new("cabinet.open", "Artifacts", Focus).more(),
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
            requires: &["diagnostics.subscribe"],
        }
        .build(vec![
            ActionDescriptor::new("diagnostics.open", "Diagnostics", Focus).more(),
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
            requires: &["run.start", "run.subscribe"],
        }
        .build(vec![
            ActionDescriptor::new("run-output.open", "Run output", Focus).more(),
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
            requires: &["search.query"],
        }
        .build(vec![
            ActionDescriptor::new("search.open", "Search", Focus).more(),
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
            ActionDescriptor::new("history.open", "History", Focus).more(),
        ]),
        // The workbench's own actions: no panel of this kind is ever opened.
        // They move focus and panels between groups, resize and maximise from
        // the keyboard, and apply a preset.
        Spec {
            kind: crate::panels::WORKBENCH_KIND,
            title: "Workbench",
            icon: "layout",
            binding: R::None,
            placement: Main,
            min: (1, 1),
            role: Role::Region,
            theme_roles: CHROME,
            requires: &[],
        }
        .build(vec![
            ActionDescriptor::new("workbench.focus.left", "Focus the group to the left", Focus)
                .key("Mod+Alt+Left", KeyScope::Global),
            ActionDescriptor::new(
                "workbench.focus.right",
                "Focus the group to the right",
                Focus,
            )
            .key("Mod+Alt+Right", KeyScope::Global),
            ActionDescriptor::new("workbench.focus.up", "Focus the group above", Focus)
                .key("Mod+Alt+Up", KeyScope::Global),
            ActionDescriptor::new("workbench.focus.down", "Focus the group below", Focus)
                .key("Mod+Alt+Down", KeyScope::Global),
            ActionDescriptor::new(
                "workbench.move.left",
                "Move the panel to the group on the left",
                Focus,
            )
            .key("Mod+Alt+Shift+Left", KeyScope::Global),
            ActionDescriptor::new(
                "workbench.move.right",
                "Move the panel to the group on the right",
                Focus,
            )
            .key("Mod+Alt+Shift+Right", KeyScope::Global),
            ActionDescriptor::new(
                "workbench.move.up",
                "Move the panel to the group above",
                Focus,
            )
            .key("Mod+Alt+Shift+Up", KeyScope::Global),
            ActionDescriptor::new(
                "workbench.move.down",
                "Move the panel to the group below",
                Focus,
            )
            .key("Mod+Alt+Shift+Down", KeyScope::Global),
            ActionDescriptor::new("workbench.resize.wider", "Make the group wider", Focus)
                .key("Mod+Alt+]", KeyScope::Global),
            ActionDescriptor::new(
                "workbench.resize.narrower",
                "Make the group narrower",
                Focus,
            )
            .key("Mod+Alt+[", KeyScope::Global),
            ActionDescriptor::new("workbench.resize.taller", "Make the group taller", Focus)
                .key("Mod+Alt+PageUp", KeyScope::Global),
            ActionDescriptor::new("workbench.resize.shorter", "Make the group shorter", Focus)
                .key("Mod+Alt+PageDown", KeyScope::Global),
            ActionDescriptor::new("workbench.drawer.close", "Close the drawer", Focus)
                .key("Mod+Alt+Escape", KeyScope::Global),
            // Follow the agent: the views go where a followed run edits. The
            // person's own navigation pauses it; either may pause or resume.
            ActionDescriptor::new("follow.pause", "Pause Follow the agent", Focus),
            ActionDescriptor::new("follow.resume", "Resume Follow the agent", Focus),
            // Show the document a panel is bound to another way (R48, AC-59):
            // the panel stays, and so do its place and its binding.
            ActionDescriptor::new(
                "panel.presentation",
                "Choose how this document is shown",
                Focus,
            ),
            ActionDescriptor::new(
                "panel.presentation.next",
                "Show this document the next way",
                Focus,
            ),
            ActionDescriptor::new("workbench.maximize", "Maximise or restore the group", Focus)
                .key("Mod+Alt+M", KeyScope::Global),
            // Under More tools too, so the picker leads to them.
            ActionDescriptor::new("workbench.layouts", "Layouts", Open)
                .more()
                .key("Mod+Alt+W", KeyScope::Global),
            ActionDescriptor::new("workbench.layout.save", "Save layout as\u{2026}", Focus)
                .key("Mod+Alt+B", KeyScope::Global),
            ActionDescriptor::new("workbench.layout.default", "Layout: Default", Focus),
            ActionDescriptor::new("workbench.layout.editor", "Layout: Editor-centred", Focus),
            ActionDescriptor::new("workbench.layout.agent", "Layout: Agent-centred", Focus),
            ActionDescriptor::new("workbench.layout.minimal", "Layout: Minimal", Focus),
        ]),
    ];
    let mut reg = Registry::new();
    for panel in panels {
        reg.register(panel)
            .expect("the built-in panels are consistent");
    }
    reg
}
