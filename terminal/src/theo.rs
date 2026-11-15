//! The Theo conversation panel and the Side chat panel (SPEC-THEO-WEB-TERMINAL-
//! WORKBENCH-1.0 sections 4.1, 5 and 7.1).
//!
//! One panel type serves both kinds. It draws with the terminal drawer's own
//! [`Session`] (the transcript, its scroll, its prompt line and its input), fed
//! only by the conversation owner's snapshots as the host delivers them, and
//! everything a person does with it leaves as a core effect. The panel decides
//! nothing the owner decides: whether a send is a turn or input for a working
//! run is read from the snapshot's run state, which is the owner's own rule (a
//! `send` while a run works is refused with `run_active`; `input` is what a
//! working run takes).
//!
//! Snapshots reach the panel through the core: bound to a conversation, the
//! ones for it arrive as `PanelMsg::Host`, and the core replays the latest one
//! it kept when the panel binds. A panel with no conversation yet learns which
//! one the owner opened from the mount's [`Directory`]. One revision gate
//! judges every snapshot.

use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Rc,
};

use keybinds::{Key, KeyInput, Mods};
use ratatui::{
    buffer::Buffer,
    layout::{Constraint, Layout, Position, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Widget},
};
use ratzilla::event::{KeyCode, KeyEvent};
use serde::Deserialize;
use serde_json::{Value, json};
use theorem_workbench_core::{
    ActionId, Completion, Composition, Ctx, Effect, EffectBody, EffectId, HostMessage, Msg,
    OpenTarget, Outcome, Panel, PanelMsg, PointerKind, ResourceRef, Revision, ViewCtx,
    completion::{CompletionPayload, SideChatInfo},
    effect::{
        ApprovalDecision, ConversationApproval, ConversationCancel, ConversationEdit,
        ConversationInput, ConversationRetry, ConversationSend, ConversationSwitchBranch,
        SideChatOpen, SideChatScope,
    },
    semantics::{Node, NodeAction, Role},
    stale::Binding,
};

use crate::{
    Action, Approval, Branches, DiffLine, Message, Open, Output, Part, Sent, Session, Snapshot,
    Token, now, palette,
};

// ---- the owner's snapshot ---------------------------------------------------------------

/// The conversation owner's snapshot (`src/lib/workbench/conversation/
/// conversation.ts`, `ConversationSnapshot`), read as far as the panel draws and
/// acts on it. A field the owner does not send reads as empty.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Owner {
    conversation_id: String,
    loading: bool,
    messages: Vec<OwnerMessage>,
    run: OwnerRun,
    approval: Option<OwnerApproval>,
    queued: Vec<OwnerQueued>,
    history: Option<OwnerHistory>,
}

/// The thread's branches as the owner sends them: the root, then each fork oldest first.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OwnerHistory {
    root_branch_id: String,
    selected_branch_id: String,
    forks: Vec<OwnerFork>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OwnerFork {
    branch_id: String,
}

impl OwnerHistory {
    /// Every branch id, the root first, then each fork oldest first.
    fn branch_ids(&self) -> Vec<&str> {
        std::iter::once(self.root_branch_id.as_str())
            .chain(self.forks.iter().map(|f| f.branch_id.as_str()))
            .collect()
    }

    /// The selected branch's place, root first, when the thread has more than one branch.
    fn position(&self) -> Option<(usize, usize)> {
        if self.forks.is_empty() {
            return None;
        }
        let total = self.forks.len() + 1;
        let at = if self.selected_branch_id == self.root_branch_id {
            0
        } else {
            self.forks
                .iter()
                .position(|f| f.branch_id == self.selected_branch_id)
                .map_or(0, |i| i + 1)
        };
        Some((at + 1, total))
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OwnerMessage {
    id: String,
    role: String,
    client_message_id: Option<String>,
    status: String,
    parts: Vec<OwnerPart>,
    attachments: Vec<OwnerAttachment>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct OwnerAttachment {
    name: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum OwnerPart {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    Tool {
        id: String,
        name: String,
        #[serde(default)]
        args: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        result: Option<String>,
        #[serde(default)]
        result_truncated: bool,
        /// Not sent by the owner today: a structured diff for an edit's result.
        /// Drawn when present; nothing is read out of the result text.
        #[serde(default)]
        diff: Vec<DiffLine>,
        /// Not sent by the owner today: the file the call worked on.
        #[serde(default)]
        open: Option<Open>,
    },
    Program {
        source: String,
        #[serde(default)]
        streaming: bool,
    },
    Input {
        #[serde(default)]
        input_id: Option<String>,
        #[serde(default)]
        text: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        reason: Option<String>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OwnerRun {
    /// idle, streaming, waiting_approval, stopped or failed.
    state: String,
    run_id: Option<String>,
    activity: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OwnerApproval {
    run_id: String,
    approval_id: String,
    tool_name: String,
    summary: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OwnerQueued {
    client_message_id: String,
    text: String,
    /// sending, queued, failed or uncertain.
    state: String,
    reason: Option<String>,
}

impl Owner {
    /// Whether a run is working: the owner takes input for it, not a new turn.
    fn working(&self) -> bool {
        matches!(self.run.state.as_str(), "streaming" | "waiting_approval")
    }

    fn last_user(&self) -> Option<&OwnerMessage> {
        self.messages.iter().rev().find(|m| m.role == "user")
    }

    /// Whether the snapshot already carries the message sent under `id`.
    fn shows(&self, id: &str) -> bool {
        self.queued.iter().any(|q| q.client_message_id == id)
            || self.messages.iter().any(|m| {
                m.client_message_id.as_deref() == Some(id)
                    || m.parts.iter().any(|part| {
                        matches!(part, OwnerPart::Input { input_id: Some(input), .. } if input == id)
                    })
            })
    }
}

/// What the drawer's transcript draws for the owner's snapshot. Every field it
/// shows is one the snapshot carries.
fn drawn(project: &str, owner: &Owner, pending: &[Pending]) -> Snapshot {
    let working = owner.working();
    let messages = owner
        .messages
        .iter()
        .map(|message| Message {
            role: message.role.clone(),
            parts: message.parts.iter().map(part_of).collect(),
            attachments: message.attachments.iter().map(|a| a.name.clone()).collect(),
        })
        .collect();
    let mut outgoing: Vec<Sent> = owner
        .queued
        .iter()
        .map(|q| Sent {
            text: q.text.clone(),
            status: q.state.clone(),
            reason: q.reason.clone(),
        })
        .collect();
    outgoing.extend(pending.iter().map(|p| {
        Sent {
            text: p.text.clone(),
            status: match &p.state {
                PendingState::Sending => "sending",
                PendingState::Refused(_) => "failed",
                PendingState::Unknown => "uncertain",
            }
            .to_owned(),
            reason: match &p.state {
                PendingState::Refused(reason) => Some(reason.clone()),
                _ => None,
            },
        }
    }));
    Snapshot {
        running: working,
        project: project.to_owned(),
        error: match owner.run.state.as_str() {
            "failed" => Some(
                owner
                    .run
                    .error
                    .clone()
                    .unwrap_or_else(|| "the run failed".to_owned()),
            ),
            "stopped" => Some("the run was stopped".to_owned()),
            _ => None,
        },
        approval: owner.approval.as_ref().map(|a| Approval {
            tool: a.tool_name.clone(),
            summary: a.summary.clone(),
        }),
        activity: owner.run.activity.clone(),
        messages,
        outgoing,
        references: Vec::new(),
        branches: owner
            .history
            .as_ref()
            .and_then(OwnerHistory::position)
            .map(|(position, total)| Branches { position, total }),
    }
}

fn part_of(part: &OwnerPart) -> Part {
    let plain = |text: &str| -> Vec<Vec<Token>> {
        text.lines()
            .map(|row| {
                vec![Token {
                    t: row.to_owned(),
                    c: None,
                    e: false,
                }]
            })
            .collect()
    };
    match part {
        OwnerPart::Text { text } => Part::Text { text: text.clone() },
        OwnerPart::Reasoning { text } => Part::Reasoning { text: text.clone() },
        OwnerPart::Tool {
            id,
            name,
            args,
            status,
            result,
            result_truncated,
            diff,
            open,
        } => {
            let mut lines = result.as_deref().map(plain).unwrap_or_default();
            if *result_truncated {
                lines.push(vec![Token {
                    t: "(the rest of this result was cut)".to_owned(),
                    c: Some("comment".to_owned()),
                    e: false,
                }]);
            }
            let output = (!lines.is_empty() || !diff.is_empty()).then(|| Output {
                lines,
                diff: diff
                    .iter()
                    .map(|line| DiffLine {
                        k: line.k.clone(),
                        t: line
                            .t
                            .iter()
                            .map(|t| Token {
                                t: t.t.clone(),
                                c: t.c.clone(),
                                e: t.e,
                            })
                            .collect(),
                    })
                    .collect(),
                more: 0,
            });
            Part::Tool {
                name: name.clone(),
                summary: args.split_whitespace().collect::<Vec<_>>().join(" "),
                status: status.clone(),
                output,
                open: open.clone(),
                id: Some(id.clone()),
            }
        }
        OwnerPart::Program { source, streaming } => Part::Program {
            lines: plain(source),
            streaming: *streaming,
        },
        OwnerPart::Input {
            text,
            status,
            reason,
            ..
        } => Part::Input(Sent {
            text: text.clone(),
            status: status.clone(),
            reason: reason.clone(),
        }),
        OwnerPart::Other => Part::Other,
    }
}

// ---- the conversation the owner is showing ------------------------------------------------

/// Which conversation the first snapshot named. The core retains the latest
/// snapshot of each conversation and replays it to a panel when it binds, but
/// a panel with no conversation yet has no resource to be replayed against:
/// this tells it which one the owner opened, and the core does the rest.
#[derive(Clone, Default)]
pub(crate) struct Directory(Rc<RefCell<Option<Latest>>>);

#[derive(Clone)]
struct Latest {
    project: String,
    thread: String,
}

impl Directory {
    /// Note a message on its way into the model. The first conversation named
    /// is the owner's main one; side chats name their own and never replace it.
    pub(crate) fn observe(&self, msg: &Msg) {
        let Msg::Host(HostMessage::ConversationSnapshot {
            resource: ResourceRef::Conversation { project, thread },
            conversation_id,
            ..
        }) = msg
        else {
            return;
        };
        let mut held = self.0.borrow_mut();
        if thread != conversation_id || held.is_some() {
            return;
        }
        *held = Some(Latest {
            project: project.clone(),
            thread: thread.clone(),
        });
    }

    fn latest(&self) -> Option<Latest> {
        self.0.borrow().clone()
    }

    fn project(&self) -> Option<String> {
        self.0.borrow().as_ref().map(|l| l.project.clone())
    }
}

// ---- the panel ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// The conversation the owner is showing.
    Main,
    /// A side conversation the person chose or made.
    Side,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PendingState {
    /// Sent to the owner; the snapshot does not carry it yet.
    Sending,
    /// The owner refused it, or it failed before anything was sent. The draft is
    /// back in the composer.
    Refused(String),
    /// Whether the owner took it is not known. Never sent again.
    Unknown,
}

#[derive(Clone, Debug)]
struct Pending {
    client_message_id: String,
    text: String,
    state: PendingState,
}

/// What an effect in flight was for, so its answer lands on the right thing.
#[derive(Clone, Debug)]
enum Tracked {
    /// A send, input or edit: the pending entry's client message id.
    Turn(String),
    Stop,
    Approval,
    Retry,
    NewConversation,
    NewSideChat,
    ListSideChats,
    SwitchBranch,
}

pub(crate) struct TheoPanel {
    /// A side chat that has no conversation yet offers these rows.
    choice: usize,
    /// The side chats the owner said exist, once it has said.
    existing: Vec<SideChatInfo>,
    /// The owner has been asked which side chats exist.
    listed: bool,
    kind: Kind,
    directory: Directory,
    session: RefCell<Session>,
    project: String,
    thread: String,
    revision: Option<u64>,
    owner: Owner,
    pending: Vec<Pending>,
    tracked: BTreeMap<EffectId, Tracked>,
    /// The message being edited; Enter then sends the edit, not a new turn.
    editing: Option<String>,
    /// The approval an answer went out for and the snapshot has not cleared.
    answered: Option<String>,
    /// Snapshots dropped as older than the one held.
    stale: u32,
    /// A snapshot that could not be read.
    unreadable: bool,
    /// The message the view should start at, from a saved layout.
    anchor: Option<String>,
    minted: u32,
    nonce: u64,
    /// The area the panel was last drawn in: pointer cells are relative to it.
    area: Cell<Rect>,
    focused: Cell<bool>,
}

impl TheoPanel {
    fn new(kind: Kind, directory: Directory, state: &Value) -> Self {
        let mut session = Session::new(
            "theo".to_owned(),
            match kind {
                Kind::Main => "Theo",
                Kind::Side => "Side chat",
            }
            .to_owned(),
            false,
        );
        if let Some(draft) = state["draft"].as_str() {
            session.paste(draft);
        }
        session.expanded = state["allOutput"].as_bool().unwrap_or(false);
        for id in state["expanded"].as_array().into_iter().flatten() {
            if let Some(id) = id.as_str() {
                session.disclosed.insert(id.to_owned());
            }
        }
        let text = |key: &str| state[key].as_str().unwrap_or_default().to_owned();
        Self {
            choice: 0,
            existing: Vec::new(),
            listed: false,
            kind,
            directory,
            session: RefCell::new(session),
            project: text("project"),
            thread: text("conversation"),
            revision: None,
            owner: Owner::default(),
            pending: Vec::new(),
            tracked: BTreeMap::new(),
            editing: None,
            answered: None,
            stale: 0,
            unreadable: false,
            anchor: state["anchor"].as_str().map(str::to_owned),
            minted: 0,
            nonce: now() as u64,
            area: Cell::new(Rect::default()),
            focused: Cell::new(false),
        }
    }

    fn bound(&self) -> bool {
        !self.project.is_empty() && !self.thread.is_empty()
    }

    /// The conversation the panel is bound to. A side chat that has asked the
    /// owner for its conversation and has no id yet is bound to the project, so
    /// the owner's answer reaches it as an answer and not as one for a panel
    /// that has moved on.
    fn resource(&self) -> ResourceRef {
        if !self.project.is_empty() {
            ResourceRef::Conversation {
                project: self.project.clone(),
                thread: self.thread.clone(),
            }
        } else {
            ResourceRef::None
        }
    }

    /// An id for a turn that no other turn, in this page or an earlier one,
    /// has used: the owner never sends the same one twice.
    fn mint(&mut self) -> String {
        self.minted += 1;
        format!("theo-{:x}-{}", self.nonce, self.minted)
    }

    // ---- snapshots ----

    /// Take a snapshot for `thread` at `revision`, unless it is older than the
    /// one held. The owner's revisions go up across switches, so the order is
    /// total.
    fn adopt(&mut self, project: &str, thread: &str, revision: u64, json: &str) {
        if self.revision.is_some_and(|held| revision <= held) {
            self.stale += 1;
            return;
        }
        let Ok(owner) = serde_json::from_str::<Owner>(json) else {
            self.unreadable = true;
            return;
        };
        self.unreadable = false;
        self.project = project.to_owned();
        self.thread = thread.to_owned();
        self.revision = Some(revision);
        self.owner = owner;
        self.pending
            .retain(|p| !self.owner.shows(&p.client_message_id));
        if self.answered.as_ref().is_some_and(|id| {
            self.owner
                .approval
                .as_ref()
                .is_none_or(|a| a.approval_id != *id)
        }) {
            self.answered = None;
        }
        self.refresh();
        if let Some(anchor) = self.anchor.take()
            && let Some(index) = self.owner.messages.iter().position(|m| m.id == anchor)
        {
            self.session.borrow_mut().pin = Some(index);
        }
    }

    fn refresh(&self) {
        let snapshot = drawn(&self.project, &self.owner, &self.pending);
        self.session.borrow_mut().set_snapshot(snapshot);
    }

    /// A main panel with no conversation yet takes the one the owner is
    /// showing; the core then replays its latest snapshot to the new binding.
    fn follow_directory(&mut self) -> bool {
        if self.kind != Kind::Main || !self.thread.is_empty() {
            return false;
        }
        let Some(latest) = self.directory.latest() else {
            return false;
        };
        self.project = latest.project;
        self.thread = latest.thread;
        self.revision = None;
        true
    }

    // ---- effects ----

    fn emit(&mut self, cx: &mut Ctx, body: EffectBody, tracked: Tracked) -> bool {
        if !self.bound() {
            self.session
                .borrow_mut()
                .notify("not connected to a conversation yet");
            return false;
        }
        let resource = self.resource();
        match cx.emit(|id| Effect::new(id, resource, body)) {
            Ok(id) => {
                self.tracked.insert(id, tracked);
                true
            }
            Err(error) => {
                self.session.borrow_mut().notify(error.to_string());
                false
            }
        }
    }

    /// Words the person submitted: an edit if one is being made, input for a
    /// working run, else a new turn.
    fn submit(&mut self, text: String, cx: &mut Ctx) {
        let id = self.mint();
        let body = if let Some(message_id) = self.editing.clone() {
            EffectBody::ConversationEdit(ConversationEdit {
                message_id,
                client_message_id: id.clone(),
                text: text.clone(),
                references: vec![],
            })
        } else if self.owner.working() {
            let Some(run_id) = self.owner.run.run_id.clone() else {
                self.keep(&text, "the run has no id to send input to");
                return;
            };
            EffectBody::ConversationInput(ConversationInput {
                run_id,
                client_message_id: id.clone(),
                text: text.clone(),
            })
        } else {
            EffectBody::ConversationSend(ConversationSend {
                client_message_id: id.clone(),
                text: text.clone(),
                attachments: Vec::new(),
                references: vec![],
            })
        };
        self.pending
            .retain(|p| !matches!(p.state, PendingState::Refused(_)));
        if self.emit(cx, body, Tracked::Turn(id.clone())) {
            self.editing = None;
            self.pending.push(Pending {
                client_message_id: id,
                text,
                state: PendingState::Sending,
            });
        } else {
            self.keep(&text, "");
        }
        self.refresh();
    }

    /// Put words back in the composer when they did not go, as a draft.
    fn keep(&mut self, text: &str, why: &str) {
        let mut session = self.session.borrow_mut();
        if session.input.value().is_empty() {
            session.paste(text);
        }
        if !why.is_empty() {
            session.notify(why.to_owned());
        }
    }

    fn stop(&mut self, cx: &mut Ctx) {
        if !self.owner.working() {
            self.session.borrow_mut().notify("no run is working");
            return;
        }
        let run_id = self.owner.run.run_id.clone();
        self.emit(
            cx,
            EffectBody::ConversationCancel(ConversationCancel { run_id }),
            Tracked::Stop,
        );
    }

    fn approve(&mut self, allow: bool, cx: &mut Ctx) {
        let Some(approval) = &self.owner.approval else {
            self.session
                .borrow_mut()
                .notify("nothing is waiting for an answer");
            return;
        };
        if self.answered.as_deref() == Some(approval.approval_id.as_str()) {
            return;
        }
        let body = EffectBody::ConversationApproval(ConversationApproval {
            run_id: approval.run_id.clone(),
            approval_id: approval.approval_id.clone(),
            decision: if allow {
                ApprovalDecision::Allow
            } else {
                ApprovalDecision::Deny
            },
        });
        let id = approval.approval_id.clone();
        if self.emit(cx, body, Tracked::Approval) {
            self.answered = Some(id);
        }
    }

    fn retry(&mut self, cx: &mut Ctx) {
        if self.owner.working() {
            self.session
                .borrow_mut()
                .notify("a run is working; stop it first");
            return;
        }
        let Some(message_id) = self.owner.last_user().map(|m| m.id.clone()) else {
            self.session
                .borrow_mut()
                .notify("there is no message to run again");
            return;
        };
        self.emit(
            cx,
            EffectBody::ConversationRetry(ConversationRetry { message_id }),
            Tracked::Retry,
        );
    }

    /// Select the branch `step` places along from the selected one, wrapping, through the
    /// conversation owner; the snapshot that answers shows it.
    fn branch(&mut self, step: isize, cx: &mut Ctx) {
        if self.owner.working() {
            self.session
                .borrow_mut()
                .notify("a run is working; stop it first");
            return;
        }
        let Some(history) = self.owner.history.as_ref().filter(|h| !h.forks.is_empty()) else {
            self.session
                .borrow_mut()
                .notify("this conversation has only one branch");
            return;
        };
        let ids = history.branch_ids();
        let at = ids
            .iter()
            .position(|id| *id == history.selected_branch_id)
            .unwrap_or(0);
        let next = (at as isize + step).rem_euclid(ids.len() as isize) as usize;
        let body = EffectBody::ConversationSwitchBranch(ConversationSwitchBranch {
            thread_id: self.owner.conversation_id.clone(),
            branch_id: ids[next].to_owned(),
        });
        self.emit(cx, body, Tracked::SwitchBranch);
    }

    /// Load the last message into the composer; Enter then sends it as an edit.
    fn begin_edit(&mut self) {
        if self.owner.working() {
            self.session
                .borrow_mut()
                .notify("a run is working; stop it first");
            return;
        }
        let Some(message) = self.owner.last_user() else {
            self.session
                .borrow_mut()
                .notify("there is no message to edit");
            return;
        };
        let text: String = message
            .parts
            .iter()
            .filter_map(|part| match part {
                OwnerPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" ");
        let id = message.id.clone();
        let mut session = self.session.borrow_mut();
        session.input.reset();
        session.paste(&text);
        drop(session);
        self.editing = Some(id);
    }

    fn new_conversation(&mut self, cx: &mut Ctx) {
        self.emit(cx, EffectBody::ConversationCreate, Tracked::NewConversation);
    }

    /// The project this side chat belongs to, once the owner has named one.
    fn side_project(&mut self) -> Option<String> {
        let project = self
            .directory
            .project()
            .or_else(|| (!self.project.is_empty()).then(|| self.project.clone()));
        match project {
            Some(project) => {
                self.project.clone_from(&project);
                Some(project)
            }
            None => {
                self.session
                    .borrow_mut()
                    .notify("the project is not known yet");
                None
            }
        }
    }

    /// Ask the owner for a side chat of the scope the person chose. The effect
    /// names the project and no thread: the owner makes the id.
    fn new_side_chat(&mut self, scope: SideChatScope, cx: &mut Ctx) {
        if self.side_project().is_none() {
            return;
        }
        let resource = self.resource();
        let open = SideChatOpen { scope: Some(scope) };
        match cx.emit(|id| Effect::new(id, resource, EffectBody::ConversationSideChat(open))) {
            Ok(id) => {
                self.tracked.insert(id, Tracked::NewSideChat);
            }
            Err(error) => self.session.borrow_mut().notify(error.to_string()),
        }
    }

    /// Ask which side chats exist, once, when the chooser first shows.
    fn list_side_chats(&mut self, cx: &mut Ctx) {
        self.listed = true;
        if self.side_project().is_none() {
            self.listed = false;
            return;
        }
        let resource = self.resource();
        match cx.emit(|id| Effect::new(id, resource, EffectBody::ConversationSideList)) {
            Ok(id) => {
                self.tracked.insert(id, Tracked::ListSideChats);
            }
            Err(error) => self.session.borrow_mut().notify(error.to_string()),
        }
    }

    /// What the chooser offers: a new side chat of each scope, then the ones
    /// that exist.
    fn rows(&self) -> Vec<ChooserRow> {
        let mut rows: Vec<ChooserRow> = SCOPES.iter().map(|s| ChooserRow::New(*s)).collect();
        rows.extend((0..self.existing.len()).map(ChooserRow::Existing));
        rows
    }

    /// Do what the chosen row says: ask for a new chat, or join one that exists.
    fn choose_row(&mut self, row: usize, cx: &mut Ctx) {
        match self.rows().get(row).copied() {
            Some(ChooserRow::New(scope)) => self.new_side_chat(scope, cx),
            Some(ChooserRow::Existing(at)) => {
                let Some(chat) = self.existing.get(at).cloned() else {
                    return;
                };
                if self.side_project().is_none() {
                    return;
                }
                self.thread = chat.conversation_id;
                self.revision = None;
                self.owner = Owner::default();
            }
            None => {}
        }
    }

    fn act(&mut self, action: Action, cx: &mut Ctx) {
        match action {
            Action::Submit(text) | Action::Input(text) => self.submit(text, cx),
            Action::Cancel => self.stop(cx),
            Action::New => self.new_conversation(cx),
            Action::Approve(allow) => self.approve(allow, cx),
            // Esc leaves an edit; the drawer's close, tabs and references have
            // no meaning in a panel.
            Action::Close => {
                if self.editing.take().is_some() {
                    self.session.borrow_mut().input.reset();
                }
            }
            Action::Open(_)
            | Action::NewTab
            | Action::CloseTab
            | Action::SelectTab
            | Action::Unreference => {}
        }
    }

    // ---- completions ----

    fn completed(&mut self, c: Completion) {
        let Some(tracked) = self.tracked.remove(&c.effect) else {
            return;
        };
        let said = |outcome: &Outcome| match outcome {
            Outcome::Refused { reason, .. } | Outcome::Failed { reason } => Some(reason.clone()),
            Outcome::Uncertain { .. } | Outcome::Accepted => None,
        };
        match tracked {
            Tracked::Turn(id) => {
                let Some(at) = self.pending.iter().position(|p| p.client_message_id == id) else {
                    return;
                };
                match &c.outcome {
                    Outcome::Accepted => {}
                    Outcome::Uncertain { .. } => self.pending[at].state = PendingState::Unknown,
                    other => {
                        let reason = said(other).unwrap_or_default();
                        let text = self.pending[at].text.clone();
                        self.pending[at].state = PendingState::Refused(reason);
                        self.keep(&text, "");
                    }
                }
            }
            Tracked::Approval => {
                if let Some(reason) = said(&c.outcome) {
                    self.answered = None;
                    self.session
                        .borrow_mut()
                        .notify(format!("the answer was not taken: {reason}"));
                }
            }
            Tracked::Stop
            | Tracked::Retry
            | Tracked::NewConversation
            | Tracked::NewSideChat
            | Tracked::ListSideChats
            | Tracked::SwitchBranch => {
                if let Some(reason) = said(&c.outcome) {
                    self.session.borrow_mut().notify(reason);
                } else if let Outcome::Uncertain { reason } = &c.outcome {
                    self.session
                        .borrow_mut()
                        .notify(format!("not known whether it happened: {reason}"));
                }
                match c.payload {
                    Some(CompletionPayload::ConversationOpened(opened))
                        if self.kind == Kind::Main =>
                    {
                        self.thread = opened.conversation_id;
                    }
                    Some(CompletionPayload::ConversationSideOpened(opened))
                        if self.kind == Kind::Side =>
                    {
                        if let Some(project) = self.directory.project() {
                            self.project = project;
                        }
                        self.thread = opened.conversation_id;
                        self.revision = None;
                        self.owner = Owner::default();
                    }
                    Some(CompletionPayload::ConversationSideList(list))
                        if self.kind == Kind::Side =>
                    {
                        self.existing = list.chats;
                        self.choice = self.choice.min(self.rows().len().saturating_sub(1));
                    }
                    _ => {}
                }
            }
        }
        self.refresh();
    }

    // ---- input ----

    fn on_key(&mut self, input: &KeyInput, cx: &mut Ctx) {
        let Some(event) = event_of(input) else {
            return;
        };
        if self.kind == Kind::Side && !self.bound() {
            let last = self.rows().len().saturating_sub(1);
            match event.code {
                KeyCode::Up => self.choice = self.choice.saturating_sub(1),
                KeyCode::Down => self.choice = (self.choice + 1).min(last),
                KeyCode::Enter => self.choose_row(self.choice, cx),
                _ => {}
            }
            return;
        }
        // Alt+[ and Alt+] select the previous and the next branch of the thread.
        if input.mods().contains(Mods::ALT) {
            match input.key() {
                Key::Char('[') => return self.branch(-1, cx),
                Key::Char(']') => return self.branch(1, cx),
                _ => {}
            }
        }
        let (_, action) = self.session.borrow_mut().key(event);
        if let Some(action) = action {
            self.act(action, cx);
        }
    }

    fn on_pointer(&mut self, x: i32, y: i32, kind: PointerKind, clicks: u8, cx: &mut Ctx) {
        if self.kind == Kind::Side && !self.bound() {
            if let PointerKind::Down(theorem_workbench_core::Button::Left) = kind
                && x >= 0
                && let Some(row) = usize::try_from(y - CHOOSER_TOP).ok()
                && row < self.rows().len()
            {
                self.choice = row;
                self.choose_row(row, cx);
            }
            return;
        }
        match kind {
            PointerKind::Wheel { dy, .. } => {
                let mut session = self.session.borrow_mut();
                let by = usize::from(dy.unsigned_abs());
                session.scroll_back = if dy > 0 {
                    session.scroll_back.saturating_sub(by)
                } else {
                    session.scroll_back + by
                };
            }
            PointerKind::Down(theorem_workbench_core::Button::Left) => {
                let area = self.area.get();
                let (Ok(x), Ok(y)) = (u16::try_from(x), u16::try_from(y)) else {
                    return;
                };
                let cell = Position::new(area.x + x, area.y + y);
                let (toggle, open) = {
                    let session = self.session.borrow();
                    (
                        session.toggle_at(cell).map(str::to_owned),
                        session.link_at(cell).cloned(),
                    )
                };
                // A row that names a file opens it; a double click on it shows
                // its result instead. A row with only a result shows or hides it.
                match (toggle, open) {
                    (Some(id), None) => {
                        self.session.borrow_mut().toggle(&id);
                    }
                    (Some(id), Some(_)) if clicks >= 2 => {
                        self.session.borrow_mut().toggle(&id);
                    }
                    (_, Some(open)) => {
                        let workspace = cx.workspace().workspace.clone();
                        cx.open(match open.start {
                            Some(line) => OpenTarget::FileAt {
                                workspace,
                                path: open.path,
                                line,
                                column: 1,
                            },
                            None => OpenTarget::File {
                                workspace,
                                path: open.path,
                            },
                        })
                    }
                    (None, None) => {}
                }
            }
            _ => {}
        }
    }
}

/// A key as the drawer's session reads it.
fn event_of(input: &KeyInput) -> Option<KeyEvent> {
    let code = match input.key() {
        Key::Char(c) => KeyCode::Char(c),
        Key::Enter => KeyCode::Enter,
        Key::Backspace => KeyCode::Backspace,
        Key::Delete => KeyCode::Delete,
        Key::Left => KeyCode::Left,
        Key::Right => KeyCode::Right,
        Key::Up => KeyCode::Up,
        Key::Down => KeyCode::Down,
        Key::Home => KeyCode::Home,
        Key::End => KeyCode::End,
        Key::PageUp => KeyCode::PageUp,
        Key::PageDown => KeyCode::PageDown,
        Key::Tab => KeyCode::Tab,
        Key::Esc => KeyCode::Esc,
        _ => return None,
    };
    let mods = input.mods();
    Some(KeyEvent {
        code,
        ctrl: mods.contains(Mods::CTRL),
        alt: mods.contains(Mods::ALT),
        shift: mods.contains(Mods::SHIFT),
    })
}

impl Panel for TheoPanel {
    fn update(&mut self, msg: PanelMsg, cx: &mut Ctx) {
        match msg {
            PanelMsg::Key(input) => self.on_key(&input, cx),
            // Typed text and a paste go to the composer and nowhere else: a
            // paste never submits, and never reaches a shell.
            PanelMsg::Text(text) => {
                if self.kind == Kind::Side && !self.bound() {
                    return;
                }
                let approval_key = text == "y" || text == "n";
                let answers = approval_key
                    && self.owner.approval.is_some()
                    && self.session.borrow().input.value().is_empty();
                if answers {
                    self.approve(text == "y", cx);
                } else {
                    self.session.borrow_mut().paste(&text);
                }
            }
            PanelMsg::Paste(text) => {
                if self.kind == Kind::Main || self.bound() {
                    self.session.borrow_mut().paste(&text);
                }
            }
            // A finished composition is typed text; the preedit is not drawn.
            PanelMsg::Composition(Composition::End { text }) if !text.is_empty() => {
                if self.kind == Kind::Main || self.bound() {
                    self.session.borrow_mut().paste(&text);
                }
            }
            PanelMsg::Composition(_) => {}
            PanelMsg::Pointer(p) => self.on_pointer(p.x, p.y, p.kind, p.clicks, cx),
            PanelMsg::Completion(c) => self.completed(c),
            PanelMsg::Host(HostMessage::ConversationSnapshot {
                resource: ResourceRef::Conversation { project, thread },
                revision: Revision::Seq(revision),
                snapshot,
                ..
            }) => self.adopt(&project, &thread, revision, &snapshot),
            PanelMsg::Action(id) => match id.as_str() {
                "theo.stop" => self.stop(cx),
                "approval.allow" => self.approve(true, cx),
                "approval.deny" => self.approve(false, cx),
                "theo.new" => self.new_conversation(cx),
                "theo.retry" => self.retry(cx),
                "theo.edit" => self.begin_edit(),
                "theo.send" => {
                    let text = self.session.borrow().input.value().trim().to_owned();
                    if !text.is_empty() {
                        self.session.borrow_mut().input.reset();
                        self.submit(text, cx);
                    }
                }
                "theo.switch" => self
                    .session
                    .borrow_mut()
                    .notify("no other conversation is offered to switch to yet"),
                "theo.branch" => self.branch(1, cx),
                "side-chat.create" if self.kind == Kind::Side && !self.bound() => {
                    self.choose_row(self.choice, cx);
                }
                "side-chat.create" => {}
                _ => {}
            },
            PanelMsg::Tick => {
                if self.kind == Kind::Side
                    && !self.bound()
                    && !self.listed
                    && self.directory.project().is_some()
                {
                    self.list_side_chats(cx);
                }
                let moved = self.follow_directory();
                let live = {
                    let session = self.session.borrow();
                    session.snapshot.running
                        || session.notice.is_some()
                        || self
                            .pending
                            .iter()
                            .any(|p| p.state == PendingState::Sending)
                };
                if moved || live {
                    cx.invalidate();
                }
            }
            PanelMsg::Resize { .. }
            | PanelMsg::Focus(_)
            | PanelMsg::Cached(_)
            | PanelMsg::Host(_)
            | PanelMsg::Workspace(_)
            | PanelMsg::TerminalOutput { .. }
            | PanelMsg::TerminalReset { .. }
            | PanelMsg::TerminalResetRequest { .. } => {}
            // A message added to the core after this panel was written.
            _ => {}
        }
        // The session's draw reads the pending list, and a snapshot read in
        // `adopt` has already refreshed it; keep the two together after any
        // change that is not a snapshot.
        self.refresh();
    }

    fn view(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        self.area.set(area);
        self.focused.set(cx.focused);
        let p = palette();
        Block::new()
            .style(Style::new().bg(p.bg).fg(p.ink))
            .render(area, buf);
        if self.kind == Kind::Side && !self.bound() {
            draw_chooser(
                area,
                buf,
                cx.focused,
                &self.rows(),
                &self.existing,
                self.choice,
            );
            return;
        }
        if area.height < 6 {
            return;
        }
        let mut session = self.session.borrow_mut();
        let referenced = !session.snapshot.references.is_empty();
        let [body, status, references, prompt] = Layout::vertical([
            Constraint::Fill(1),
            Constraint::Length(1),
            Constraint::Length(u16::from(referenced)),
            Constraint::Length(3),
        ])
        .areas(area);
        session.draw_body(buf, body);
        if !self.bound() {
            Line::styled(" connecting to the conversation", Style::new().fg(p.muted))
                .render(status, buf);
        } else if self.unreadable {
            Line::styled(" a snapshot could not be read", Style::new().fg(p.error))
                .render(status, buf);
        } else if self.owner.loading {
            Line::styled(" loading the conversation", Style::new().fg(p.muted)).render(status, buf);
        } else if let Some(id) = &self.editing {
            let _ = id;
            Line::styled(
                " editing your last message: enter sends it, esc leaves",
                Style::new().fg(p.accent),
            )
            .render(status, buf);
        } else {
            session.draw_status(buf, status);
        }
        if referenced {
            session.draw_references(buf, references);
        }
        let at = session.draw_prompt(buf, prompt, cx.focused);
        if cx.focused
            && let Some(cell) = buf.cell_mut(at)
        {
            cell.modifier.insert(Modifier::REVERSED);
        }
    }

    fn semantics(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        let resource = self.resource();
        let title = match self.kind {
            Kind::Main => "Theo",
            Kind::Side => "Side chat",
        };
        let mut root = Node::new("theo", Role::Region, title, area);
        root.binding = resource.clone();
        if let Some(revision) = self.revision {
            root.revision = Some(Revision::Seq(revision));
        }
        let mut nodes = Vec::new();
        let mut children = Vec::new();

        if self.kind == Kind::Side && !self.bound() {
            let rows = self.rows();
            let mut chooser = Node::new(
                "chooser",
                Role::Group,
                "Choose a side chat",
                Rect::new(
                    area.x,
                    area.y,
                    area.width,
                    area.height.min(CHOOSER_TOP as u16 + rows.len() as u16),
                ),
            );
            for (at, row) in rows.iter().enumerate() {
                let (title, detail) = row.words(&self.existing);
                let mut item = Node::new(
                    &format!("chooser:{at}"),
                    Role::MenuItem,
                    &format!("{title}: {detail}"),
                    Rect::new(
                        area.x,
                        area.y
                            + (CHOOSER_TOP as u16 + at as u16).min(area.height.saturating_sub(1)),
                        area.width,
                        1,
                    ),
                );
                item.state.selected = at == self.choice;
                item.state.focused = cx.focused && at == self.choice;
                if at == self.choice {
                    item.actions = vec![NodeAction {
                        id: ActionId::new("side-chat.create"),
                        enabled: true,
                        reason: None,
                    }];
                }
                chooser.children.push(item.id.clone());
                nodes.push(item);
            }
            children.push(chooser.id.clone());
            nodes.insert(0, chooser);
            root.children = children;
            let mut out = vec![root];
            out.extend(nodes);
            return out;
        }

        let session = self.session.borrow();
        let body = session.body;
        let height = usize::from(body.height);
        let edge = |row: usize, top: usize| -> u16 {
            let relative = row.saturating_sub(top).min(height.saturating_sub(1));
            body.y + relative as u16
        };

        // The transcript: one node per message, in order, each with the rows it
        // takes on screen (clamped to the body when it is scrolled off).
        let mut log = Node::new("log", Role::Log, "Conversation", body);
        log.binding = resource.clone();
        log.state.busy = self.owner.working();
        let count = self.owner.messages.len();
        for (index, message) in self.owner.messages.iter().enumerate() {
            let first = session.starts.get(index).and_then(|l| session.rows.get(*l));
            let end = session
                .starts
                .get(index + 1)
                .and_then(|l| session.rows.get(*l))
                .or_else(|| session.rows.last());
            let rect = match (first, end) {
                (Some(&first), Some(&end)) => {
                    let y = edge(first, session.top);
                    let last = edge(end.max(first + 1) - 1, session.top);
                    Rect::new(body.x, y, body.width, last.saturating_sub(y) + 1)
                }
                _ => Rect::new(body.x, body.y, body.width, 1),
            };
            let who = match message.role.as_str() {
                "user" => "You",
                "assistant" => "Theo",
                other => other,
            };
            let mut node = Node::new(&format!("m:{}", message.id), Role::Group, who, rect);
            node.binding = resource.clone();
            node.pos_in_set = u16::try_from(index + 1).ok();
            node.set_size = u16::try_from(count).ok();
            node.state.busy = message.status == "running";
            let text: Vec<&str> = message
                .parts
                .iter()
                .filter_map(|part| match part {
                    OwnerPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            let mut description = text.join("\n");
            if !message.attachments.is_empty() {
                let names: Vec<&str> = message
                    .attachments
                    .iter()
                    .map(|a| a.name.as_str())
                    .collect();
                description.push_str(&format!("\nAttached: {}", names.join(", ")));
            }
            node.state.description = (!description.is_empty()).then_some(description);
            let mut kids = Vec::new();
            for part in &message.parts {
                let OwnerPart::Tool {
                    id,
                    name,
                    status,
                    result,
                    ..
                } = part
                else {
                    continue;
                };
                let mut tool = Node::new(
                    &format!("t:{id}"),
                    Role::Group,
                    &format!("Tool {name}: {status}"),
                    rect,
                );
                tool.state.expanded = result
                    .is_some()
                    .then(|| session.expanded || session.disclosed.contains(id));
                tool.state.description = result.clone();
                tool.state.busy = status == "running";
                kids.push(tool);
            }
            node.children = kids.iter().map(|k| k.id.clone()).collect();
            log.children.push(node.id.clone());
            nodes.push(node);
            nodes.extend(kids);
        }
        children.push(log.id.clone());
        nodes.insert(0, log);

        // Run state, as a status the person and the agent both read.
        let run = match self.owner.run.state.as_str() {
            "streaming" => "Running".to_owned(),
            "waiting_approval" => "Waiting on your approval".to_owned(),
            "stopped" => "Stopped".to_owned(),
            "failed" => format!(
                "Failed: {}",
                self.owner.run.error.as_deref().unwrap_or("no reason given")
            ),
            _ => "Idle".to_owned(),
        };
        let mut status = Node::new(
            "run",
            Role::Status,
            &run,
            Rect::new(area.x, body.bottom(), area.width, 1),
        );
        status.state.busy = self.owner.working();
        let mut notes = Vec::new();
        if let Some(activity) = &self.owner.run.activity {
            notes.push(activity.clone());
        }
        if self.stale > 0 {
            notes.push(format!("{} older snapshots dropped", self.stale));
        }
        for p in &self.pending {
            notes.push(match &p.state {
                PendingState::Sending => format!("Sending: {}", p.text),
                PendingState::Refused(why) => format!("Not sent ({why}): {}", p.text),
                PendingState::Unknown => {
                    format!("Not known whether it was received: {}", p.text)
                }
            });
        }
        status.state.description = (!notes.is_empty()).then(|| notes.join("\n"));
        children.push(status.id.clone());
        nodes.push(status);

        // Controls: each carries the action that does it and why it is off.
        let bar_rect = Rect::new(area.x, body.bottom(), area.width, 1);
        let mut bar = Node::new("controls", Role::Toolbar, "Run controls", bar_rect);
        let working = self.owner.working();
        let waiting = self.owner.approval.is_some();
        let control = |id: &str, name: &str, action: &str, enabled: bool, why: &str| {
            let mut node = Node::new(id, Role::Button, name, bar_rect);
            node.actions = vec![NodeAction {
                id: ActionId::new(action),
                enabled,
                reason: (!enabled).then(|| why.to_owned()),
            }];
            node.state.disabled = !enabled;
            node
        };
        let mut buttons = vec![
            control("stop", "Stop", "theo.stop", working, "No run is working"),
            control(
                "retry",
                "Retry",
                "theo.retry",
                !working && self.owner.last_user().is_some(),
                if working {
                    "A run is working"
                } else {
                    "There is no message to run again"
                },
            ),
            control(
                "edit",
                "Edit and resend",
                "theo.edit",
                !working && self.owner.last_user().is_some(),
                if working {
                    "A run is working"
                } else {
                    "There is no message to edit"
                },
            ),
        ];
        if self
            .owner
            .history
            .as_ref()
            .is_some_and(|h| !h.forks.is_empty())
        {
            buttons.push(control(
                "branch",
                "Next branch",
                "theo.branch",
                !working,
                "A run is working",
            ));
        }
        if let Some(approval) = &self.owner.approval {
            let open = self.answered.as_deref() != Some(approval.approval_id.as_str());
            let why = "The answer is already sent";
            let mut dialog = Node::new(
                "approval",
                Role::Alert,
                &format!(
                    "{} needs approval: {}",
                    approval.tool_name, approval.summary
                ),
                bar_rect,
            );
            let allow = control("approval:allow", "Allow", "approval.allow", open, why);
            let deny = control("approval:deny", "Deny", "approval.deny", open, why);
            dialog.children = vec![allow.id.clone(), deny.id.clone()];
            children.push(dialog.id.clone());
            nodes.push(dialog);
            nodes.push(allow);
            nodes.push(deny);
        } else {
            let _ = waiting;
        }
        bar.children = buttons.iter().map(|b| b.id.clone()).collect();
        children.push(bar.id.clone());
        nodes.push(bar);
        nodes.append(&mut buttons);

        // The composer: the field the person types a message in.
        let prompt = Rect::new(area.x, area.bottom().saturating_sub(3), area.width, 3);
        let mut composer = Node::new(
            "composer",
            Role::TextBox,
            match self.kind {
                Kind::Main => "Message to Theo",
                Kind::Side => "Message to the side chat",
            },
            prompt,
        );
        composer.state.focused = cx.focused;
        let draft = session.input.value();
        composer.state.description = Some(if draft.is_empty() {
            if working {
                "Enter sends it to the working run".to_owned()
            } else {
                "Enter sends it as a new turn".to_owned()
            }
        } else {
            draft.to_owned()
        });
        children.push(composer.id.clone());
        nodes.push(composer);

        root.children = children;
        let mut out = vec![root];
        out.extend(nodes);
        out
    }

    fn serialize(&self) -> Value {
        let session = self.session.borrow();
        // The message at the top of the view, when the person has scrolled
        // away from the tail; following the tail saves no anchor.
        let anchor = (session.scroll_back > 0)
            .then(|| {
                self.owner
                    .messages
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(index, _)| {
                        session
                            .starts
                            .get(*index)
                            .and_then(|line| session.rows.get(*line))
                            .is_some_and(|row| *row <= session.top)
                    })
                    .map(|(_, m)| m.id.clone())
            })
            .flatten()
            .or_else(|| self.anchor.clone());
        json!({
            "conversation": self.thread,
            "project": self.project,
            "anchor": anchor,
            "expanded": session.disclosed.iter().collect::<Vec<_>>(),
            "allOutput": session.expanded,
            "draft": session.input.value(),
        })
    }

    fn binding(&self) -> Option<Binding> {
        Some(Binding {
            resource: self.resource(),
            revision: self.revision.map(Revision::Seq),
            generation: None,
        })
    }

    fn text_entry(&self) -> bool {
        self.kind == Kind::Main || self.bound()
    }
}

/// The empty Side chat: what choosing it offers, drawn instead of a composer
/// that could send nowhere.
fn draw_chooser(
    area: Rect,
    buf: &mut Buffer,
    focused: bool,
    rows: &[ChooserRow],
    existing: &[SideChatInfo],
    choice: usize,
) {
    let p = palette();
    let mut lines = vec![
        Line::from(Span::styled(
            " Side chat",
            Style::new().fg(p.bright).add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            " up and down choose, enter starts or joins; nothing typed here reaches the main conversation",
            Style::new().fg(p.muted),
        )),
    ];
    for (at, row) in rows.iter().enumerate() {
        let selected = at == choice;
        let mark = if selected { "\u{25b8}" } else { " " };
        let (title, detail) = row.words(existing);
        lines.push(Line::from(vec![
            Span::styled(
                format!(" {mark} {title}"),
                if selected {
                    Style::new()
                        .fg(if focused { p.sage } else { p.bright })
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::new().fg(p.ink)
                },
            ),
            Span::styled(format!("  {detail}"), Style::new().fg(p.muted)),
        ]));
    }
    for (row, line) in lines.into_iter().enumerate() {
        let Some(y) = area.y.checked_add(row as u16) else {
            break;
        };
        if y >= area.bottom() {
            break;
        }
        line.render(Rect::new(area.x, y, area.width, 1), buf);
    }
}

/// The row the chooser's first choice is drawn on, below its two heading lines.
const CHOOSER_TOP: i32 = 2;

const SCOPES: [SideChatScope; 3] = [
    SideChatScope::Fresh,
    SideChatScope::Continued,
    SideChatScope::Forked,
];

/// One thing the Side chat chooser offers.
#[derive(Clone, Copy)]
enum ChooserRow {
    /// A new side chat of this scope.
    New(SideChatScope),
    /// A side chat that exists: its place in the owner's list.
    Existing(usize),
}

impl ChooserRow {
    fn words(self, existing: &[SideChatInfo]) -> (String, String) {
        match self {
            Self::New(SideChatScope::Fresh) => (
                "New side chat".into(),
                "a fresh thread; nothing from the main conversation".into(),
            ),
            Self::New(SideChatScope::Continued) => (
                "New side chat that continues this conversation".into(),
                "starts from the main conversation's history".into(),
            ),
            Self::New(SideChatScope::Forked) => (
                "New side chat forked from this conversation".into(),
                "a copy of the main conversation as it is now, then its own".into(),
            ),
            Self::Existing(at) => match existing.get(at) {
                Some(chat) => (
                    format!("Join {}", chat.conversation_id),
                    match chat.scope {
                        SideChatScope::Fresh => "a fresh side chat",
                        SideChatScope::Continued => "continues the main conversation",
                        SideChatScope::Forked => "forked from the main conversation",
                    }
                    .into(),
                ),
                None => (String::new(), String::new()),
            },
        }
    }
}

/// Register the Theo and Side chat panels. `directory` is the mount's, fed by
/// every message the model takes.
pub(crate) fn register(
    factories: &mut theorem_workbench_core::PanelFactories,
    directory: &Directory,
) {
    let main = directory.clone();
    factories.register("theo", move |state, _| {
        Box::new(TheoPanel::new(Kind::Main, main.clone(), state))
    });
    let side = directory.clone();
    factories.register("side-chat", move |state, _| {
        Box::new(TheoPanel::new(Kind::Side, side.clone(), state))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use theorem_workbench_core::{Actor, PanelFactories, PanelInstanceId, Theme};
    use theorem_workbench_core::{
        EffectKind, Model, Owner, builtin,
        keys::{KeyTable, Overrides, Platform},
        registry::Capabilities,
        semantics,
        semantics::SemanticTree,
        update,
    };
    use theorem_workbench_dock::{CellMetrics, Dock, DockConfig, Preset};

    const PROJECT: &str = "p1";

    fn model(directory: &Directory) -> Model {
        let mut factories = PanelFactories::new();
        register(&mut factories, directory);
        theorem_workbench_panels::register(&mut factories);
        let registry = builtin::registry();
        let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
        assert!(issues.is_empty(), "{issues:?}");
        let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
        let mut m = Model::new(
            registry,
            factories,
            keys,
            Capabilities::of(["files", "conversation", "conversation.side"]),
            dock,
        );
        update(
            &mut m,
            Msg::Resize {
                area: Rect::new(0, 0, 160, 50),
                metrics: CellMetrics::new(8.0, 16.0),
            },
        );
        m
    }

    struct Rig {
        m: Model,
        directory: Directory,
        seen: Vec<Effect>,
    }

    fn rig() -> Rig {
        let directory = Directory::default();
        let mut m = model(&directory);
        update(
            &mut m,
            Msg::Action {
                id: ActionId::new("theo.focus"),
                actor: Actor::Human,
            },
        );
        Rig {
            m,
            directory,
            seen: Vec::new(),
        }
    }

    fn snapshot(revision: u64, thread: &str, body: Value) -> Msg {
        let mut value = json!({
            "conversationId": thread,
            "loading": false,
            "messages": [],
            "run": {"state": "idle"},
            "queued": [],
            "revision": revision,
        });
        for (key, item) in body.as_object().cloned().unwrap_or_default() {
            value[key] = item;
        }
        Msg::Host(HostMessage::ConversationSnapshot {
            resource: ResourceRef::Conversation {
                project: PROJECT.into(),
                thread: thread.into(),
            },
            revision: Revision::Seq(revision),
            conversation_id: thread.into(),
            snapshot: value.to_string(),
        })
    }

    fn user(id: &str, text: &str) -> Value {
        json!({"id": id, "role": "user", "status": "complete",
               "parts": [{"type": "text", "text": text}], "attachments": []})
    }

    fn assistant(id: &str, parts: Value, status: &str) -> Value {
        json!({"id": id, "role": "assistant", "status": status,
               "parts": parts, "attachments": []})
    }

    impl Rig {
        fn send(&mut self, msg: Msg) -> Vec<Effect> {
            self.directory.observe(&msg);
            let fx = update(&mut self.m, msg);
            self.seen.extend(fx.clone());
            fx
        }

        fn id(&self) -> PanelInstanceId {
            self.m
                .panel_ids()
                .find(|(_, k)| k.as_str() == "theo")
                .map(|(id, _)| id.clone())
                .expect("a Theo panel is open")
        }

        fn show(&mut self, revision: u64, thread: &str, body: Value) {
            self.send(snapshot(revision, thread, body));
            self.send(Msg::Tick);
        }

        fn typed(&mut self, text: &str) {
            self.send(Msg::Text(text.to_owned()));
        }

        fn enter(&mut self) -> Vec<Effect> {
            self.send(Msg::Key(KeyInput::new(Key::Enter, Mods::NONE)))
        }

        fn key(&mut self, key: Key, mods: Mods) -> Vec<Effect> {
            self.send(Msg::Key(KeyInput::new(key, mods)))
        }

        fn tree(&self) -> SemanticTree {
            semantics(&self.m)
        }

        fn node(&self, name: &str) -> Option<Node> {
            self.tree().nodes.into_iter().find(|n| n.name == name)
        }

        fn drawn(&self) -> String {
            let area = Rect::new(0, 0, 160, 50);
            let mut buf = Buffer::empty(area);
            theorem_workbench_core::view(&self.m, area, &mut buf, &Theme::plain());
            (0..area.height)
                .map(|y| {
                    (0..area.width)
                        .map(|x| buf[(x, y)].symbol().to_owned())
                        .collect::<String>()
                        .trim_end()
                        .to_owned()
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    }

    fn main_body(r: &Rig) -> Rect {
        r.m.frame()
            .expect("a frame is solved")
            .groups
            .iter()
            .find(|g| g.role == theorem_workbench_dock::Role::Main)
            .expect("a main region")
            .body
    }

    fn conversation_effects(fx: &[Effect]) -> Vec<&Effect> {
        fx.iter()
            .filter(|e| {
                matches!(
                    e.kind(),
                    EffectKind::ConversationSend
                        | EffectKind::ConversationInput
                        | EffectKind::ConversationCancel
                        | EffectKind::ConversationRetry
                        | EffectKind::ConversationEdit
                        | EffectKind::ConversationApproval
                        | EffectKind::ConversationCreate
                        | EffectKind::ConversationSideChat
                        | EffectKind::ConversationSwitchBranch
                )
            })
            .collect()
    }

    #[test]
    fn the_default_layout_puts_theo_in_the_main_region() {
        let r = rig();
        let kinds: Vec<_> =
            r.m.panel_ids()
                .map(|(_, k)| k.as_str().to_owned())
                .collect();
        assert!(kinds.contains(&"theo".to_owned()), "{kinds:?}");
        let theo = r.id();
        let _ = theo;
        let main = main_body(&r);
        assert!(main.width > 40 && main.height > 10, "{main:?}");
        assert!(
            r.drawn().contains("❯"),
            "the composer is drawn in the main region"
        );
    }

    #[test]
    fn a_snapshot_for_a_panel_not_yet_bound_still_reaches_it_through_the_directory() {
        let mut r = rig();
        r.show(1, "t1", json!({"messages": [user("m1", "hello there")]}));
        assert!(r.drawn().contains("hello there"), "{}", r.drawn());
        let b = r.m.panel(&r.id()).unwrap().binding().unwrap();
        assert_eq!(
            b.resource,
            ResourceRef::Conversation {
                project: PROJECT.into(),
                thread: "t1".into()
            }
        );
        assert_eq!(b.revision, Some(Revision::Seq(1)));
    }

    #[test]
    fn an_older_snapshot_than_the_one_held_is_dropped_and_counted() {
        let mut r = rig();
        r.show(5, "t1", json!({"messages": [user("m1", "newer words")]}));
        // The bound panel takes this one through the core, which judges it.
        r.send(snapshot(
            3,
            "t1",
            json!({"messages": [user("m1", "older words")]}),
        ));
        r.send(Msg::Tick);
        assert!(r.drawn().contains("newer words"));
        assert!(!r.drawn().contains("older words"));
        assert!(r.m.counters().dropped >= 1, "{:?}", r.m.counters());
        // And the panel's own gate counts one the core let through (a panel
        // that adopted from the directory).
        let mut p = TheoPanel::new(Kind::Main, Directory::default(), &json!({}));
        p.adopt(PROJECT, "t1", 5, "{}");
        p.adopt(PROJECT, "t1", 4, "{}");
        assert_eq!(p.stale, 1);
    }

    #[test]
    fn a_new_conversation_the_owner_opens_replaces_the_one_shown_and_takes_its_snapshots() {
        let mut r = rig();
        r.show(1, "t1", json!({"messages": [user("m1", "first thread")]}));
        r.typed("/new");
        let fx = r.enter();
        let create = conversation_effects(&fx)[0];
        let mut done = Completion::new(create.id, create.resource.clone(), Outcome::Accepted);
        done.payload = Some(CompletionPayload::ConversationOpened(
            theorem_workbench_core::completion::ConversationOpened {
                conversation_id: "t2".into(),
            },
        ));
        r.send(Msg::Completion(done));
        r.show(9, "t2", json!({"messages": [user("m9", "second thread")]}));
        assert!(r.drawn().contains("second thread"), "{}", r.drawn());
        assert!(!r.drawn().contains("first thread"));
    }

    #[test]
    fn sending_leaves_as_a_core_effect_with_a_fresh_client_message_id() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("add a test");
        let fx = r.enter();
        let sent = conversation_effects(&fx);
        assert_eq!(sent.len(), 1, "{fx:?}");
        let EffectBody::ConversationSend(send) = &sent[0].body else {
            panic!("{:?}", sent[0]);
        };
        assert_eq!(send.text, "add a test");
        assert!(send.client_message_id.starts_with("theo-"));
        assert_eq!(
            sent[0].resource,
            ResourceRef::Conversation {
                project: PROJECT.into(),
                thread: "t1".into()
            }
        );
        r.typed("again");
        let fx = r.enter();
        let EffectBody::ConversationSend(second) = &conversation_effects(&fx)[0].body else {
            panic!()
        };
        assert_ne!(second.client_message_id, send.client_message_id);
    }

    #[test]
    fn a_send_shows_as_pending_until_the_snapshot_carries_it() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("ship it");
        let fx = r.enter();
        let id = fx[0].id;
        assert!(r.drawn().contains("sending"), "{}", r.drawn());
        r.send(Msg::Completion(Completion::new(
            id,
            fx[0].resource.clone(),
            Outcome::Accepted,
        )));
        assert!(r.drawn().contains("sending"));
        let EffectBody::ConversationSend(send) = &fx[0].body else {
            panic!()
        };
        let mut message = user("m1", "ship it");
        message["clientMessageId"] = json!(send.client_message_id);
        r.show(2, "t1", json!({"messages": [message]}));
        assert!(!r.drawn().contains("sending"), "{}", r.drawn());
        assert!(r.drawn().contains("ship it"));
    }

    #[test]
    fn a_refused_send_shows_the_reason_and_keeps_the_draft() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("do the thing");
        let fx = r.enter();
        r.send(Msg::Completion(Completion::new(
            fx[0].id,
            fx[0].resource.clone(),
            Outcome::Refused {
                code: "unavailable".into(),
                reason: "The conversation cannot take a message right now".into(),
            },
        )));
        let drawn = r.drawn();
        assert!(
            drawn.contains("not sent: The conversation cannot take a message"),
            "{drawn}"
        );
        let draft = r.m.panel(&r.id()).unwrap().serialize()["draft"].clone();
        assert_eq!(draft, json!("do the thing"));
    }

    #[test]
    fn an_uncertain_send_is_shown_as_unknown_and_never_sent_again() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("maybe");
        let fx = r.enter();
        let before = r.seen.len();
        r.send(Msg::Completion(Completion::new(
            fx[0].id,
            fx[0].resource.clone(),
            Outcome::Uncertain {
                reason: "the connection dropped".into(),
            },
        )));
        r.send(Msg::Tick);
        r.send(Msg::Tick);
        assert!(
            r.drawn().contains("not known whether it was received"),
            "{}",
            r.drawn()
        );
        let again = conversation_effects(&r.seen[before..]);
        assert!(again.is_empty(), "{again:?}");
        // The draft is not put back either: it may well have gone.
        let draft = r.m.panel(&r.id()).unwrap().serialize()["draft"].clone();
        assert_eq!(draft, json!(""));
    }

    #[test]
    fn a_send_typed_while_a_run_is_active_follows_the_owners_policy() {
        // The owner refuses `send` while a run works (`run_active`) and takes
        // `input` for it, so the panel sends input to the run it saw working.
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({
                "messages": [user("m1", "go"), assistant("m2", json!([{"type": "text", "text": "on it"}]), "running")],
                "run": {"state": "streaming", "runId": "run-7"},
            }),
        );
        r.typed("also check the docs");
        let fx = r.enter();
        let effects = conversation_effects(&fx);
        assert_eq!(effects.len(), 1, "{fx:?}");
        let EffectBody::ConversationInput(input) = &effects[0].body else {
            panic!("{:?}", effects[0]);
        };
        assert_eq!(input.run_id, "run-7");
        assert_eq!(input.text, "also check the docs");
        // Once the run is over, the same keys start a turn.
        r.show(
            2,
            "t1",
            json!({"messages": [user("m1", "go")], "run": {"state": "idle"}}),
        );
        r.typed("thanks");
        let fx = r.enter();
        assert!(matches!(
            conversation_effects(&fx)[0].body,
            EffectBody::ConversationSend(_)
        ));
    }

    #[test]
    fn stopping_a_working_run_names_the_run_the_person_saw() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({"messages": [user("m1", "go")], "run": {"state": "streaming", "runId": "run-2"}}),
        );
        let fx = r.key(Key::Char('c'), Mods::CTRL);
        let effects = conversation_effects(&fx);
        let EffectBody::ConversationCancel(cancel) = &effects[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(cancel.run_id.as_deref(), Some("run-2"));
        let fx = update(
            &mut r.m,
            Msg::Action {
                id: ActionId::new("theo.stop"),
                actor: Actor::Human,
            },
        );
        assert_eq!(conversation_effects(&fx).len(), 1, "{fx:?}");
    }

    #[test]
    fn retry_and_edit_act_on_the_last_message_the_person_sent() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({"messages": [user("m1", "first"), assistant("m2", json!([{"type": "text", "text": "ok"}]), "complete"), user("m3", "second")]}),
        );
        let fx = update(
            &mut r.m,
            Msg::Action {
                id: ActionId::new("theo.retry"),
                actor: Actor::Human,
            },
        );
        let effects = conversation_effects(&fx);
        let EffectBody::ConversationRetry(retry) = &effects[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(retry.message_id, "m3");
        update(
            &mut r.m,
            Msg::Action {
                id: ActionId::new("theo.edit"),
                actor: Actor::Human,
            },
        );
        r.typed(" please");
        let fx = r.enter();
        let effects = conversation_effects(&fx);
        let EffectBody::ConversationEdit(edit) = &effects[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(edit.message_id, "m3");
        assert_eq!(edit.text, "second please");
    }

    #[test]
    fn a_pending_approval_is_answered_with_the_runs_and_the_approvals_ids() {
        let mut r = rig();
        let body = json!({
            "messages": [user("m1", "go"), assistant("m2", json!([{"type": "tool", "id": "c1", "name": "shell", "args": "{\"cmd\":\"rm -rf build\"}", "status": "approval", "approvalId": "ap-1"}]), "requires-action")],
            "run": {"state": "waiting_approval", "runId": "run-3"},
            "approval": {"runId": "run-3", "approvalId": "ap-1", "toolCallId": "c1", "toolName": "shell", "summary": "delete the build folder", "risk": "high", "options": []},
        });
        r.show(1, "t1", body);
        let allow = r.node("Allow").expect("an Allow control");
        assert!(allow.actions[0].enabled);
        assert_eq!(allow.actions[0].id.as_str(), "approval.allow");
        let fx = update(
            &mut r.m,
            Msg::Action {
                id: ActionId::new("approval.deny"),
                actor: Actor::Human,
            },
        );
        let effects = conversation_effects(&fx);
        let EffectBody::ConversationApproval(a) = &effects[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(
            (a.run_id.as_str(), a.approval_id.as_str(), a.decision),
            ("run-3", "ap-1", ApprovalDecision::Deny)
        );
        // Asking again before the owner answers sends nothing more.
        let again = update(
            &mut r.m,
            Msg::Action {
                id: ActionId::new("approval.allow"),
                actor: Actor::Human,
            },
        );
        assert!(conversation_effects(&again).is_empty());
    }

    #[test]
    fn a_model_origin_approval_is_refused_by_the_registry_before_the_panel_sees_it() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({
                "messages": [user("m1", "go")],
                "run": {"state": "waiting_approval", "runId": "run-3"},
                "approval": {"runId": "run-3", "approvalId": "ap-1", "toolCallId": "c1", "toolName": "shell", "summary": "x", "risk": "low", "options": []},
            }),
        );
        let fx = update(
            &mut r.m,
            Msg::Action {
                id: ActionId::new("approval.allow"),
                actor: Actor::Agent {
                    run_id: "agent-run".into(),
                },
            },
        );
        assert!(conversation_effects(&fx).is_empty(), "{fx:?}");
    }

    #[test]
    fn a_new_conversation_leaves_as_a_create_effect() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("/new");
        let fx = r.enter();
        assert!(matches!(
            conversation_effects(&fx)[0].body,
            EffectBody::ConversationCreate
        ));
    }

    #[test]
    fn a_paste_into_the_composer_never_becomes_terminal_input() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        let fx = r.send(Msg::Paste("rm -rf /\nsudo reboot\n".into()));
        // Nothing left the panel: no terminal write, no turn.
        assert!(fx.is_empty(), "{fx:?}");
        let draft = r.m.panel(&r.id()).unwrap().serialize()["draft"].clone();
        assert_eq!(draft, json!("rm -rf / sudo reboot "));
        // Only the person's Enter sends it, and as a conversation message.
        let fx = r.enter();
        assert_eq!(fx.len(), 1);
        assert_eq!(fx[0].kind(), EffectKind::ConversationSend);
        assert!(!r.seen.iter().any(|e| e.kind().owner() == Owner::Terminal));
    }

    #[test]
    fn the_branch_action_selects_the_next_branch_through_the_owner_and_wraps() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({
                "messages": [user("m1", "hi")],
                "history": {
                    "rootBranchId": "root",
                    "selectedBranchId": "b2",
                    "forks": [{"branchId": "b1"}, {"branchId": "b2"}]
                }
            }),
        );
        let fx = update(
            &mut r.m,
            Msg::Action {
                id: ActionId::new("theo.branch"),
                actor: Actor::Human,
            },
        );
        let effects = conversation_effects(&fx);
        let EffectBody::ConversationSwitchBranch(switch) = &effects[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(switch.thread_id, "t1");
        assert_eq!(
            switch.branch_id, "root",
            "the last branch wraps to the root"
        );
    }

    #[test]
    fn a_thread_with_forks_says_which_branch_is_selected() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({
                "messages": [user("m1", "hi"), assistant("m2", json!([{"type": "text", "text": "hello"}]), "complete")],
                "history": {
                    "rootBranchId": "root",
                    "selectedBranchId": "b2",
                    "forks": [{"branchId": "b1"}, {"branchId": "b2"}]
                }
            }),
        );
        assert!(r.drawn().contains("branch 3 of 3"), "{}", r.drawn());
        r.show(
            2,
            "t1",
            json!({"messages": [user("m1", "hi")], "history": {"rootBranchId": "root", "selectedBranchId": "root", "forks": []}}),
        );
        assert!(!r.drawn().contains("branch 1 of"), "{}", r.drawn());
    }

    #[test]
    fn tool_results_diffs_attachments_and_run_states_are_drawn_from_the_snapshot() {
        let mut r = rig();
        let mut asked = user("m1", "fix the build");
        asked["attachments"] = json!([{"id": "a1", "name": "build.log"}]);
        let reply = assistant(
            "m2",
            json!([
                {"type": "text", "text": "Reading the **log** first."},
                {"type": "tool", "id": "c1", "name": "read_file", "args": "{\"path\":\"build.log\"}", "status": "complete", "result": "error: missing semicolon\nat line 4"},
                {"type": "tool", "id": "c2", "name": "edit_file", "args": "{\"path\":\"src/a.rs\"}", "status": "complete",
                 "result": "ok",
                 "diff": [{"k": "hunk", "t": [{"t": "@@ -1 +1 @@"}]}, {"k": "del", "t": [{"t": "let a = 1"}]}, {"k": "add", "t": [{"t": "let a = 2;"}]}]},
            ]),
            "complete",
        );
        r.show(1, "t1", json!({"messages": [asked, reply]}));
        let drawn = r.drawn();
        assert!(drawn.contains("@build.log"), "{drawn}");
        assert!(drawn.contains("read_file"), "{drawn}");
        assert!(drawn.contains("let a = 2;"), "{drawn}");
        // The result of the first call waits behind its row.
        assert!(!drawn.contains("missing semicolon"), "{drawn}");
        let tool = r.node("Tool read_file: complete").expect("a tool node");
        assert_eq!(tool.state.expanded, Some(false));
        assert_eq!(
            tool.state.description.as_deref(),
            Some("error: missing semicolon\nat line 4")
        );
        for (revision, (state, shown)) in (2..).zip([
            ("streaming", "Running"),
            ("waiting_approval", "Waiting on your approval"),
            ("stopped", "Stopped"),
            ("failed", "Failed: out of tokens"),
            ("idle", "Idle"),
        ]) {
            let mut run = json!({"state": state, "runId": "r"});
            if state == "failed" {
                run["error"] = json!("out of tokens");
            }
            r.show(
                revision,
                "t1",
                json!({"messages": [user("m1", "x")], "run": run}),
            );
            assert!(r.node(shown).is_some(), "{state}: {:?}", r.tree());
        }
    }

    #[test]
    fn showing_one_tool_result_works_by_pointer() {
        let mut r = rig();
        let reply = assistant(
            "m2",
            json!([
                {"type": "tool", "id": "c1", "name": "read_file", "args": "{}", "status": "complete", "result": "first line\nsecond line"},
            ]),
            "complete",
        );
        r.show(1, "t1", json!({"messages": [user("m1", "x"), reply]}));
        assert!(!r.drawn().contains("second line"));
        let row = r
            .drawn()
            .lines()
            .position(|l| l.contains("read_file"))
            .expect("the tool row");
        let origin = main_body(&r);
        let click = |x, y| {
            Msg::Pointer(theorem_workbench_core::Pointer {
                kind: PointerKind::Down(theorem_workbench_core::Button::Left),
                x,
                y,
                mods: Mods::NONE,
                clicks: 1,
            })
        };
        let _ = r.drawn();
        r.send(click(origin.x + 6, row as u16));
        assert!(r.drawn().contains("second line"), "{}", r.drawn());
        r.send(click(origin.x + 6, row as u16));
        assert!(!r.drawn().contains("second line"));
    }

    #[test]
    fn showing_all_tool_output_works_by_key() {
        let mut r = rig();
        let reply = assistant(
            "m2",
            json!([{"type": "tool", "id": "c1", "name": "read_file", "args": "{}", "status": "complete", "result": "hidden words"}]),
            "complete",
        );
        r.show(1, "t1", json!({"messages": [user("m1", "x"), reply]}));
        assert!(!r.drawn().contains("hidden words"));
        r.key(Key::Char('o'), Mods::CTRL);
        assert!(r.drawn().contains("hidden words"));
    }

    #[test]
    fn opening_a_file_a_tool_worked_on_goes_through_the_core() {
        let mut r = rig();
        r.send(Msg::Host(HostMessage::WorkspaceChanged {
            workspace: "w".into(),
            environment: None,
        }));
        let reply = assistant(
            "m2",
            json!([{"type": "tool", "id": "c1", "name": "edit_file", "args": "{}", "status": "complete",
                    "open": {"path": "src/a.rs", "start": 3, "end": 5}}]),
            "complete",
        );
        r.show(1, "t1", json!({"messages": [user("m1", "x"), reply]}));
        let row = r
            .drawn()
            .lines()
            .position(|l| l.contains("edit_file"))
            .unwrap();
        let origin = main_body(&r);
        let fx = r.send(Msg::Pointer(theorem_workbench_core::Pointer {
            kind: PointerKind::Down(theorem_workbench_core::Button::Left),
            x: origin.x + 6,
            y: row as u16,
            mods: Mods::NONE,
            clicks: 1,
        }));
        // No document panel is registered in this rig, so the core opens its
        // own placeholder for the kind; what matters is that the request went
        // to the core's open path and not to a private channel.
        assert!(conversation_effects(&fx).is_empty());
        let opened = r.m.panel_ids().any(|(_, k)| k.as_str() == "document");
        assert!(opened, "the core was asked to open the file");
    }

    #[test]
    fn the_semantic_tree_names_the_transcript_the_run_the_controls_and_the_composer() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({"messages": [user("m1", "hello"), assistant("m2", json!([{"type": "text", "text": "hi"}]), "complete")]}),
        );
        let tree = r.tree();
        let find = |role| tree.nodes.iter().find(|n| n.role == role);
        assert!(find(Role::Log).is_some());
        assert!(find(Role::Status).is_some());
        assert!(find(Role::TextBox).is_some_and(|n| n.name == "Message to Theo"));
        let stop = r.node("Stop").expect("a Stop control");
        assert!(!stop.actions[0].enabled);
        assert_eq!(stop.actions[0].reason.as_deref(), Some("No run is working"));
        let you = r.node("You").expect("the person's message");
        assert_eq!(you.state.description.as_deref(), Some("hello"));
        assert_eq!(you.pos_in_set, Some(1));
        assert_eq!(you.set_size, Some(2));
    }

    #[test]
    fn the_conversation_scroll_anchor_expanded_results_and_draft_survive_a_save_and_restore() {
        let mut r = rig();
        let mut messages = Vec::new();
        for i in 0..40 {
            messages.push(user(&format!("u{i}"), &format!("question number {i}")));
            messages.push(assistant(
                &format!("a{i}"),
                json!([{"type": "tool", "id": format!("c{i}"), "name": "read_file", "args": "{}", "status": "complete", "result": "kept result"}]),
                "complete",
            ));
        }
        r.show(1, "t1", json!({"messages": messages.clone()}));
        let body = main_body(&r);
        r.send(Msg::Pointer(theorem_workbench_core::Pointer {
            kind: PointerKind::Wheel { dx: 0, dy: -30 },
            x: body.x + 10,
            y: body.y + 5,
            mods: Mods::NONE,
            clicks: 1,
        }));
        let _ = r.drawn();
        r.typed("half a thought");
        let saved = r.m.document();
        let before = r.m.panel(&r.id()).unwrap().serialize();
        assert_eq!(before["draft"], json!("half a thought"));
        assert!(before["anchor"].is_string(), "{before}");
        assert_eq!(before["conversation"], json!("t1"));

        let directory = Directory::default();
        let mut again = model(&directory);
        again.restore(saved).expect("the layout restores");
        let id = again
            .panel_ids()
            .find(|(_, k)| k.as_str() == "theo")
            .map(|(id, _)| id.clone())
            .unwrap();
        let after = again.panel(&id).unwrap().serialize();
        assert_eq!(after["draft"], before["draft"]);
        assert_eq!(after["anchor"], before["anchor"]);
        assert_eq!(after["conversation"], before["conversation"]);
        assert_eq!(after["project"], before["project"]);
    }

    #[test]
    fn a_disclosed_tool_result_is_saved_and_shown_again() {
        let p = TheoPanel::new(
            Kind::Main,
            Directory::default(),
            &json!({"expanded": ["c1"], "conversation": "t1", "project": "p1"}),
        );
        assert!(p.session.borrow().disclosed.contains("c1"));
        assert_eq!(p.serialize()["expanded"], json!(["c1"]));
        p.session.borrow_mut().toggle("c1");
        assert_eq!(p.serialize()["expanded"], json!([]));
    }

    #[test]
    fn choosing_side_chat_offers_a_new_chat_and_sends_nothing_to_the_main_one() {
        let mut r = rig();
        r.show(1, "t1", json!({"messages": [user("m1", "main talk")]}));
        update(
            &mut r.m,
            Msg::Action {
                id: ActionId::new("side-chat.choose"),
                actor: Actor::Human,
            },
        );
        let side =
            r.m.panel_ids()
                .find(|(_, k)| k.as_str() == "side-chat")
                .map(|(id, _)| id.clone())
                .expect("the picker's row opens a Side chat panel");
        assert!(!r.m.is_unavailable(&side), "no placeholder");
        let before = r.seen.len();
        // Typing and pasting into an unbound side chat goes nowhere.
        r.typed("hello?");
        r.send(Msg::Paste("hello?".into()));
        let fx = r.enter();
        // Enter asks the owner for a new side chat, and only that.
        let effects = conversation_effects(&fx);
        assert_eq!(effects.len(), 1, "{fx:?}");
        assert!(matches!(
            effects[0].body,
            EffectBody::ConversationSideChat(_)
        ));
        assert!(r.seen[before..].iter().all(|e| !matches!(
            e.kind(),
            EffectKind::ConversationSend | EffectKind::ConversationInput
        )));
        let drawn = r.drawn();
        assert!(drawn.contains("New side chat"), "{drawn}");
    }

    #[test]
    fn the_side_chat_chooser_asks_for_the_scope_the_person_chose() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.send(Msg::Action {
            id: ActionId::new("side-chat.choose"),
            actor: Actor::Human,
        });
        r.key(Key::Down, Mods::NONE);
        let fx = r.enter();
        let effects = conversation_effects(&fx);
        let EffectBody::ConversationSideChat(open) = &effects[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(
            open.scope,
            Some(theorem_workbench_core::effect::SideChatScope::Continued)
        );
    }

    #[test]
    fn existing_side_chats_are_listed_by_the_owner_and_joined_by_choosing_one() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.send(Msg::Action {
            id: ActionId::new("side-chat.choose"),
            actor: Actor::Human,
        });
        r.send(Msg::Tick);
        let list = r
            .seen
            .iter()
            .find(|e| matches!(e.body, EffectBody::ConversationSideList))
            .cloned()
            .expect("the chooser asks which side chats exist");
        let mut done = Completion::new(list.id, list.resource.clone(), Outcome::Accepted);
        done.payload = Some(CompletionPayload::ConversationSideList(
            theorem_workbench_core::completion::ConversationSideList {
                chats: vec![theorem_workbench_core::completion::SideChatInfo {
                    conversation_id: "side-9".into(),
                    scope: theorem_workbench_core::effect::SideChatScope::Forked,
                    from: Some("t1".into()),
                    thread_id: None,
                }],
            },
        ));
        r.send(Msg::Completion(done));
        assert!(r.drawn().contains("Join side-9"), "{}", r.drawn());
        for _ in 0..3 {
            r.key(Key::Down, Mods::NONE);
        }
        r.enter();
        r.show(4, "side-9", json!({"messages": [user("s1", "side words")]}));
        assert!(r.drawn().contains("side words"), "{}", r.drawn());
    }

    #[test]
    fn a_host_without_side_chats_leaves_the_picker_row_unavailable_with_its_reason() {
        let directory = Directory::default();
        let mut m = model(&directory);
        update(
            &mut m,
            Msg::Host(HostMessage::CapabilitiesChanged {
                capabilities: Capabilities::of(["files", "conversation"]),
            }),
        );
        update(
            &mut m,
            Msg::Action {
                id: ActionId::new("side-chat.choose"),
                actor: Actor::Human,
            },
        );
        assert!(
            !m.panel_ids().any(|(_, k)| k.as_str() == "side-chat"),
            "no Side chat panel is opened for a host that cannot serve one"
        );
        assert!(
            m.take_notice().is_some(),
            "the refusal is told to the person"
        );
    }

    #[test]
    fn a_side_chat_binds_to_the_conversation_the_owner_opened_and_takes_its_snapshots() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        update(
            &mut r.m,
            Msg::Action {
                id: ActionId::new("side-chat.choose"),
                actor: Actor::Human,
            },
        );
        let fx = r.enter();
        let side = conversation_effects(&fx)[0];
        let mut done = Completion::new(side.id, side.resource.clone(), Outcome::Accepted);
        done.payload = Some(CompletionPayload::ConversationSideOpened(
            theorem_workbench_core::completion::ConversationOpened {
                conversation_id: "side-1".into(),
            },
        ));
        r.send(Msg::Completion(done));
        // Its snapshots reach it by the core's own routing, by id.
        r.send(snapshot(
            4,
            "side-1",
            json!({"messages": [user("s1", "side words")]}),
        ));
        let drawn = r.drawn();
        assert!(drawn.contains("side words"), "{drawn}");
        assert!(!drawn.contains("main talk"));
        // A send there names the side conversation, not the main one.
        r.typed("ask aside");
        let fx = r.enter();
        let effects = conversation_effects(&fx);
        assert_eq!(
            effects[0].resource,
            ResourceRef::Conversation {
                project: PROJECT.into(),
                thread: "side-1".into()
            }
        );
    }

    #[test]
    fn the_theo_panel_takes_a_conversation_message_while_a_shell_would_take_terminal_input() {
        let r = rig();
        let theo = r.m.panel(&r.id()).unwrap();
        // Its printable keys come to it as typed text for the composer.
        assert!(theo.text_entry());
    }
}
