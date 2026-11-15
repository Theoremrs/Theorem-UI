//! What the panel offers to assistive technology and to the agent: its visible rows as
//! nodes of the core's semantic tree.
//!
//! Written for this crate; not translated. The donor's rows carry a role, a label and a
//! selected flag for its toolkit's accessibility tree (`changes.rs`: `Role::ListItem`,
//! `aria_label`, `aria_selected`); this is the same idea in the workbench's own terms,
//! with the level, the position in the set, the expanded state and the actions a row
//! offers, and the reason one is not available.

use ratatui::layout::Rect;
use theorem_workbench_core::ActionId;
use theorem_workbench_core::semantics::{Node, NodeAction, NodeId, Role, SemanticTree};

use crate::layout::{Row, banner_rows, banners, regions, rows};
use crate::model::{Changes, Confirm, Focus, LogState, Mode, PanelState, ReadBody};
use crate::status::{LISTED, RowKey, Section, letter, shown};
use crate::text::visible;

/// The actions the panel registers, by id. Each is a registry action the core resolves
/// for a person or the agent and delivers to the panel as `PanelMsg::Action`; see
/// [`crate::actions`] for their descriptors. Moving the cursor, folding a hunk and the
/// layout toggle start no work, so they are keys only and have no action.
pub mod actions {
    pub const REFRESH: &str = "changes.refresh";
    pub const DIFF: &str = "changes.diff";
    pub const STAGE: &str = "changes.stage";
    pub const UNSTAGE: &str = "changes.unstage";
    pub const STAGE_ALL: &str = "changes.stageAll";
    pub const UNSTAGE_ALL: &str = "changes.unstageAll";
    pub const DISCARD: &str = "changes.discard";
    pub const CONFIRM: &str = "changes.confirm";
    pub const RESTORE: &str = "changes.restore";
    pub const COMMIT: &str = "changes.commit";
    pub const COMMIT_ALL: &str = "changes.commitAll";
    pub const LOG: &str = "changes.log";
    pub const HISTORY: &str = "changes.history";
    pub const BLAME: &str = "changes.blame";
    pub const SHOW_HEAD: &str = "changes.showHead";
    pub const SHOW_INDEX: &str = "changes.showIndex";
    pub const FETCH: &str = "changes.fetch";
    pub const PUSH: &str = "changes.push";
    pub const SWITCH_BRANCH: &str = "changes.switchBranch";
    pub const CREATE_BRANCH: &str = "changes.createBranch";
    pub const MERGE: &str = "changes.merge";
    pub const AMEND: &str = "changes.amend";
    pub const OPEN_COMMIT: &str = "changes.openCommit";
    pub const SHOW_AT_COMMIT: &str = "changes.showAtCommit";
    pub const OPEN_CONFLICT: &str = "changes.openConflict";
    pub const TAKE_OURS: &str = "changes.takeOurs";
    pub const TAKE_THEIRS: &str = "changes.takeTheirs";
    pub const EDIT_CONFLICT: &str = "changes.editConflict";
    // The panel's own movement and view actions: the keys they stand for, as actions.
    pub const CURSOR_UP: &str = "changes.cursorUp";
    pub const CURSOR_DOWN: &str = "changes.cursorDown";
    pub const NEXT_GROUP: &str = "changes.nextGroup";
    pub const FOCUS_FILES: &str = "changes.focusFiles";
    pub const FOCUS_DRAFT: &str = "changes.focusDraft";
    pub const TOGGLE_DIFF: &str = "changes.toggleDiff";
    pub const TOGGLE_SELECTED: &str = "changes.toggleSelected";
    pub const SELECT_ALL: &str = "changes.selectAll";
    pub const TOGGLE_AMEND: &str = "changes.toggleAmend";
    pub const TOGGLE_LAYOUT: &str = "changes.toggleLayout";
    pub const TOGGLE_FOLD: &str = "changes.toggleFold";
    pub const NEXT_HUNK: &str = "changes.nextHunk";
    pub const PREVIOUS_HUNK: &str = "changes.previousHunk";
    pub const OPEN_FILE: &str = "changes.openFile";
    pub const CANCEL: &str = "changes.cancel";
    pub const DISMISS_NOTICES: &str = "changes.dismissNotices";
}

fn act(id: &str, reason: Option<String>) -> NodeAction {
    NodeAction {
        id: ActionId::new(id),
        enabled: reason.is_none(),
        reason,
    }
}

impl Changes {
    /// The visible rows as a tree rooted at a region named "Changes". Node ids start with
    /// `id`.
    pub fn semantics(&self, id: &str, area: Rect) -> SemanticTree {
        let area = Rect::new(area.x, area.y, area.width, area.height);
        let regions = regions(self, area);
        let mut nodes: Vec<Node> = Vec::new();
        let mut root = Node::new(id, Role::Region, "Changes", area);
        let block = self.mutation_block().map(|r| r.reason());

        // The branch line.
        let head = self
            .head()
            .map(|h| h.label())
            .unwrap_or_else(|| "reading".into());
        let mut branch = Node::new(
            &format!("{id}/branch"),
            Role::Status,
            &format!("Branch: {head}"),
            regions.branch,
        );
        branch.state.busy = !self.in_flight().is_empty();
        let loaded = self.snapshot.is_some();
        let not_read = (!loaded).then(|| "The repository has not been read yet".to_owned());
        branch.actions = vec![
            act(actions::FETCH, block.clone()),
            act(actions::PUSH, block.clone()),
            act(actions::SWITCH_BRANCH, block.clone()),
            act(actions::CREATE_BRANCH, block.clone()),
            act(actions::MERGE, block.clone()),
            act(actions::REFRESH, None),
        ];
        if let Some(prompt) = &self.prompt {
            branch.role = Role::TextBox;
            branch.name = prompt.kind.label().to_owned();
            branch.state.focused = true;
            branch.state.description = Some(if prompt.text.is_empty() {
                "Type a branch name and press Enter".to_owned()
            } else {
                prompt.text.clone()
            });
            branch.actions.clear();
        }
        if let Some(open) = self.unreconciled().first() {
            branch.state.description = Some(format!(
                "The result of the earlier {} is unknown",
                open.label()
            ));
        }
        root.children.push(branch.id.clone());
        nodes.push(branch);

        let said = banners(self);
        let laid = banner_rows(self, regions.banners.width, area.height);
        for (at, first, rows) in laid.spans {
            let line = &said[at].1;
            let rect = Rect::new(
                regions.banners.x,
                regions.banners.y + first as u16,
                regions.banners.width,
                rows as u16,
            );
            let mut node = Node::new(&format!("{id}/banner/{at}"), Role::Alert, line, rect);
            if at == 0
                && let Some(confirm) = &self.confirm
            {
                node.role = Role::Dialog;
                node.name = visible(&confirm.text().0);
                node.state.description = Some(visible(&confirm.text().1));
                node.actions = vec![act(actions::CONFIRM, None)];
                if matches!(confirm, Confirm::Restore { .. }) {
                    node.state.description = Some(confirm.text().1);
                }
            }
            root.children.push(node.id.clone());
            nodes.push(node);
        }

        // The list.
        let list_role = match self.mode {
            Mode::Branches => Role::Menu,
            Mode::Read => Role::Document,
            Mode::Changes => Role::Tree,
        };
        let list_name = match (&self.mode, &self.read) {
            (Mode::Branches, _) => "Branches".to_owned(),
            (Mode::Read, Some(read)) => read.kind.title(&read.path),
            _ => "Changes list".to_owned(),
        };
        let mut list = Node::new(&format!("{id}/list"), list_role, &list_name, regions.list);
        if let (Mode::Read, Some(read)) = (&self.mode, &self.read) {
            list.state.busy = read.body == ReadBody::Loading;
            if let ReadBody::Conflict(sides) = &read.body {
                let settled =
                    (!sides.conflict).then(|| "The file is no longer in conflict".to_owned());
                list.actions = vec![
                    act(
                        actions::TAKE_OURS,
                        settled.clone().or_else(|| block.clone()),
                    ),
                    act(actions::TAKE_THEIRS, settled.or_else(|| block.clone())),
                ];
                // Merging by hand needs text: a binary file offers whole sides only.
                if !sides.binary {
                    list.actions.push(act(actions::EDIT_CONFLICT, None));
                }
            }
            if matches!(read.body, ReadBody::History(_)) {
                list.actions = vec![
                    act(actions::OPEN_COMMIT, None),
                    act(actions::SHOW_AT_COMMIT, None),
                ];
            }
            list.state.description = Some(match &read.body {
                ReadBody::Loading => "Reading".to_owned(),
                ReadBody::Blame(h) => format!("{} blame hunks", h.len()),
                ReadBody::Text { exists: false, .. } => "The file has no such version".to_owned(),
                ReadBody::Text { text, .. } => format!("{} lines", text.lines().count()),
                ReadBody::History(c) => format!("{} commits", c.len()),
                ReadBody::Conflict(sides) if !sides.conflict => {
                    "The file is no longer in conflict".to_owned()
                }
                ReadBody::Conflict(sides) if sides.binary => {
                    "Binary file: its sides cannot be shown as text".to_owned()
                }
                ReadBody::Conflict(sides) => format!(
                    "Ours {}, theirs {}",
                    side_words(sides.ours.as_deref()),
                    side_words(sides.theirs.as_deref())
                ),
                ReadBody::Problem(p) => p.text(),
                ReadBody::Outdated => {
                    "Dropped: it was for an earlier state of the repository".to_owned()
                }
            });
        } else if let PanelState::Refused { code, reason } = self.state() {
            list.state.description = Some(visible(&format!(
                "Source control is unavailable ({code}): {reason}"
            )));
        } else if let PanelState::Failed { reason } = self.state() {
            list.state.description = Some(visible(&format!(
                "The repository could not be read: {reason}"
            )));
        } else if let PanelState::Uncertain { reason } = self.state() {
            list.state.description = Some(visible(&format!(
                "Unknown result: the repository was not read: {reason}"
            )));
        } else if self.state() == PanelState::Empty {
            list.state.description = Some("No changes".into());
        } else if self.state() == PanelState::Loading {
            list.state.busy = true;
        }
        let all = rows(self, self.split_at(regions.list.width), regions.list.width);
        let height = regions.list.height as usize;
        let first = self.scroll().min(all.len().saturating_sub(height));
        let mut section: Option<(Node, Vec<Node>)> = None;
        let flush =
            |section: &mut Option<(Node, Vec<Node>)>, list: &mut Node, nodes: &mut Vec<Node>| {
                if let Some((node, kids)) = section.take() {
                    list.children.push(node.id.clone());
                    nodes.push(node);
                    nodes.extend(kids);
                }
            };
        let groups = self.groups();
        for (at, row) in all.iter().enumerate() {
            let visible = at >= first && at < first + height;
            let rect = Rect::new(
                regions.list.x,
                regions.list.y + at.saturating_sub(first) as u16,
                regions.list.width,
                if visible { 1 } else { 0 },
            );
            match row {
                Row::Header { section: s, count } => {
                    flush(&mut section, &mut list, &mut nodes);
                    let mut node = Node::new(
                        &format!("{id}/section/{s:?}"),
                        Role::TreeItem,
                        &format!("{} ({count})", s.title()),
                        rect,
                    );
                    node.level = Some(1);
                    node.state.expanded = Some(true);
                    let (all_id, all_reason) = match s {
                        Section::Unstaged => (Some(actions::STAGE_ALL), block.clone()),
                        Section::Staged => (Some(actions::UNSTAGE_ALL), block.clone()),
                        _ => (None, None),
                    };
                    node.actions = all_id.map(|a| vec![act(a, all_reason)]).unwrap_or_default();
                    section = Some((node, Vec::new()));
                }
                Row::File {
                    key,
                    change,
                    expanded,
                } if visible => {
                    let size = groups
                        .map(|g| g.section(key.section).len().min(LISTED))
                        .unwrap_or(0);
                    let pos = groups
                        .and_then(|g| {
                            g.section(key.section)
                                .iter()
                                .position(|c| c.path == key.path)
                        })
                        .map(|p| p + 1)
                        .unwrap_or(1);
                    let mut node = Node::new(
                        &format!("{id}/file/{:?}/{}", key.section, key.path),
                        Role::TreeItem,
                        &format!("{} {}", letter(key.section, change), shown(&key.path)),
                        rect,
                    );
                    node.level = Some(2);
                    node.pos_in_set = Some(pos as u16);
                    node.set_size = Some(size.max(pos) as u16);
                    node.state.selected = self.selected.contains(key);
                    node.state.focused =
                        self.cursor.as_ref() == Some(key) && self.focus == Focus::Files;
                    node.state.expanded = Some(*expanded);
                    node.actions = self.file_actions(key, block.clone());
                    if let Some(doc) = self.unsaved(&key.path) {
                        node.state.description = Some(match doc.saved_revision {
                            Some(r) => format!(
                                "Unsaved draft in the editor, not included when staged or committed; the saved file is revision {r}"
                            ),
                            None => "Unsaved draft in the editor, not included when staged or committed; the saved file is used".to_owned(),
                        });
                    }
                    if let Some(view) = self.diffs.get(key) {
                        let mut diff = Node::new(
                            &format!("{id}/diff/{:?}/{}", key.section, key.path),
                            Role::Document,
                            &format!("Diff of {}", shown(&key.path)),
                            rect,
                        );
                        diff.state.busy = view.state == crate::model::DiffState::Loading;
                        diff.state.description = Some(self.diff_description(view));
                        diff.actions = vec![act(actions::DIFF, None)];
                        node.children.push(diff.id.clone());
                        if let Some((_, kids)) = section.as_mut() {
                            kids.push(node);
                            kids.push(diff);
                        }
                    } else if let Some((_, kids)) = section.as_mut() {
                        kids.push(node);
                    }
                    if let Some((sec, kids)) = section.as_mut() {
                        for kid in kids.iter() {
                            if kid.level == Some(2) && !sec.children.contains(&kid.id) {
                                sec.children.push(kid.id.clone());
                            }
                        }
                    }
                }
                Row::Branch { info, cursor } if visible => {
                    let mut node = Node::new(
                        &format!("{id}/branch/{}", info.name),
                        Role::MenuItem,
                        &info.name,
                        rect,
                    );
                    node.state.selected = *cursor;
                    node.state.description = info.upstream.as_ref().map(|u| format!("tracks {u}"));
                    list.children.push(node.id.clone());
                    nodes.push(node);
                }
                _ => {}
            }
        }
        flush(&mut section, &mut list, &mut nodes);
        root.children.push(list.id.clone());
        nodes.push(list);

        // The commit box.
        if regions.commit.height > 0 {
            let r = regions.commit;
            let mut subject = Node::new(
                &format!("{id}/commit/subject"),
                Role::TextBox,
                "Commit message",
                Rect::new(r.x, r.y, r.width, 1),
            );
            subject.state.focused = self.focus == Focus::Message;
            subject.state.description = Some(format!(
                "{}/{} characters",
                self.subject.chars().count(),
                crate::model::SUBJECT.0
            ));
            root.children.push(subject.id.clone());
            nodes.push(subject);
            if r.height >= 4 {
                let body = Node::new(
                    &format!("{id}/commit/body"),
                    Role::TextBox,
                    "Commit description",
                    Rect::new(r.x, r.y + 1, r.width, 2),
                );
                root.children.push(body.id.clone());
                nodes.push(body);
            }
            let y = r.y + r.height - 1;
            let amend_w = crate::text::width(&self.amend_text()) as u16;
            let mut amend = Node::new(
                &format!("{id}/commit/amend"),
                Role::Button,
                "Amend",
                Rect::new(r.x + 1, y, amend_w.min(r.width.saturating_sub(1)), 1),
            );
            amend.state.selected = self.amend;
            let amend_why = (!self.amend_available())
                .then(|| "This host does not offer amend (scm.commit.amend)".to_owned())
                .or_else(|| block.clone());
            amend.state.disabled = amend_why.is_some();
            amend.state.busy = self.amend_waiting();
            amend.state.description = Some(match &amend_why {
                Some(why) => why.clone(),
                None if self.amend_body_unread() => {
                    "Amending the last commit. The host sent no body, so the draft holds the subject only and the body would be dropped.".to_owned()
                }
                None if self.amend => "Amending the last commit".to_owned(),
                None => "Amend the last commit instead of making a new one".to_owned(),
            });
            amend.actions = vec![act(actions::AMEND, amend_why)];
            root.children.push(amend.id.clone());
            nodes.push(amend);
            let (label, ready) = self.commit_button();
            let mut button = Node::new(
                &format!("{id}/commit/button"),
                Role::Button,
                &label,
                Rect::new(r.x, y, r.width, 1),
            );
            let why = if self.subject.trim().is_empty() {
                Some("Write a commit message first".to_owned())
            } else if !ready {
                block
                    .clone()
                    .or_else(|| Some("There are no changes to commit".to_owned()))
            } else {
                block.clone()
            };
            button.state.disabled = why.is_some();
            button.state.busy = self.is_busy(crate::intent::ActionKind::Commit);
            button.state.description = why.clone();
            let nothing_staged = self.groups().is_some_and(|g| g.staged.is_empty());
            button.actions = vec![if nothing_staged {
                act(actions::COMMIT_ALL, why)
            } else {
                act(actions::COMMIT, why)
            }];
            root.children.push(button.id.clone());
            nodes.push(button);
        }

        // The log.
        if regions.log.height > 0 {
            let r = regions.log;
            let mut log = Node::new(&format!("{id}/log"), Role::Log, "Recent commits", r);
            log.actions = vec![act(actions::LOG, not_read.clone())];
            if let LogState::Ready(entries) = &self.log {
                let size = entries.len();
                for (at, entry) in entries.iter().take(r.height as usize - 1).enumerate() {
                    let mut node = Node::new(
                        &format!("{id}/log/{}", entry.commit),
                        Role::TreeItem,
                        &visible(&format!(
                            "{} {}",
                            entry.commit.chars().take(7).collect::<String>(),
                            entry.subject
                        )),
                        Rect::new(r.x, r.y + 1 + at as u16, r.width, 1),
                    );
                    node.level = Some(1);
                    node.pos_in_set = Some(at as u16 + 1);
                    node.set_size = Some(size as u16);
                    node.state.selected = self.focus == Focus::Log && at == self.log_cursor;
                    node.state.description = Some(visible(&format!("by {}", entry.author)));
                    node.actions = vec![act(actions::OPEN_COMMIT, None)];
                    log.children.push(node.id.clone());
                    nodes.push(node);
                }
            } else if let LogState::Problem(p) = &self.log {
                log.state.description = Some(p.text());
            }
            root.children.push(log.id.clone());
            nodes.push(log);
        }

        let root_id: NodeId = root.id.clone();
        nodes.insert(0, root);
        SemanticTree {
            root: root_id,
            nodes,
        }
    }

    fn diff_description(&self, view: &crate::model::DiffView) -> String {
        use crate::model::DiffState as D;
        let base = match &view.state {
            D::Loading => "Reading the diff".to_owned(),
            D::Hunks(h) => format!("{} hunk{}", h.len(), if h.len() == 1 { "" } else { "s" }),
            D::Binary => "A binary file".into(),
            D::NoLines => "No line changes".into(),
            D::Folder => "An untracked folder".into(),
            D::NoStatus => "No status was reported".into(),
            D::Problem(p) => p.text(),
            D::Unreadable(why) => format!("Could not be read: {why}"),
            D::Outdated => "Dropped: it was for an earlier state of the repository".into(),
        };
        if view.stale {
            format!("{base}; out of date, reload to read it again")
        } else {
            base
        }
    }

    fn file_actions(&self, key: &RowKey, block: Option<String>) -> Vec<NodeAction> {
        let mut out = vec![act(
            actions::DIFF,
            (!key.section.can_diff())
                .then(|| "The host did not report this file's status".to_owned()),
        )];
        if key.section.can_stage() {
            out.push(act(actions::STAGE, block.clone()));
        }
        if key.section.can_unstage() {
            out.push(act(actions::UNSTAGE, block.clone()));
        }
        if key.section.can_discard() {
            out.push(act(actions::DISCARD, block));
        }
        if key.section == Section::Conflicted {
            out.push(act(actions::OPEN_CONFLICT, None));
            out.push(act(actions::EDIT_CONFLICT, None));
        }
        let untracked = (key.section == Section::Untracked)
            .then(|| "The file is not tracked yet, so it has no history".to_owned());
        out.push(act(actions::BLAME, untracked.clone()));
        out.push(act(actions::HISTORY, untracked.clone()));
        out.push(act(actions::SHOW_HEAD, untracked.clone()));
        out.push(act(actions::SHOW_INDEX, untracked));
        out
    }
}

/// How a side reads in a description: its line count, or that it has no file.
fn side_words(side: Option<&str>) -> String {
    match side {
        Some(text) => format!("{} lines", text.lines().count()),
        None => "has no file".to_owned(),
    }
}
