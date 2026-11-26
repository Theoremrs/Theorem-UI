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
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

use keybinds::{Key, KeyInput, Mods};
use ratatui::{
    buffer::Buffer,
    layout::{Constraint, Layout, Position, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Widget},
};
use ratzilla::event::{KeyCode, KeyEvent};
use serde::Deserialize;
use serde_json::{Value, json};
use theorem_workbench_changes::{Groups, Head, LineKind, Parsed, REPOSITORY, RowKey, parse};
use theorem_workbench_composer::{
    Composer, ComposerStatus, Draft, Event as ComposerEvent, Input as ComposerInput, Policy,
    Response as ComposerResponse, SubmitMode,
};
use theorem_workbench_core::{
    ActionId, Actor, Capability, Completion, Ctx, Effect, EffectBody, EffectId, HostMessage, ModelChoice,
    Msg, OpenTarget, Outcome, Panel, PanelMsg, PanelPointer, PointerKind, ResourceRef, Revision,
    SourceReference, ViewCtx,
    completion::{CompletionPayload, FileKind, SideChatInfo},
    draft::EXCERPT_LIMIT,
    effect::{
        ApprovalDecision, AttachRemove, AttachmentRef, ClipboardWrite, ConversationApproval,
        ConversationCancel, ConversationDismissInput, ConversationEdit, ConversationInput,
        ConversationRetry,
        ConversationSend, ConversationSwitch, ConversationSwitchBranch, FilesSearch, SetEffort,
        SetModel, SideChatOpen, SideChatScope,
    },
    panel::{Caret, CaretPhase, CaretShape},
    semantics::{Node, NodeAction, Role},
    stale::Binding,
};
use theorem_workbench_text::visible::visible;

use crate::blocks::{Activity, BlockKind};
use crate::{
    Approval, Branches, DiffLine, Message, Open, Output, Part, Sent, Session, Snapshot, Token, now,
    palette,
};

// ---- the transcript as text, for the semantic tree ----------------------------------------

/// The most recent messages the transcript node's text carries.
const RECENT_MESSAGES: usize = 12;
/// The most bytes of transcript text the node carries, kept from the end.
const RECENT_BYTES: usize = 8 * 1024;

/// The end of the conversation as plain lines, for the semantic tree: who
/// spoke, their words, and each tool call with its state. Every line goes
/// through `visible`, and the whole is cut from the front to a bound, so the
/// newest words are the ones kept.
fn recent_transcript(messages: &[OwnerMessage]) -> String {
    let from = messages.len().saturating_sub(RECENT_MESSAGES);
    let mut lines = Vec::new();
    for message in &messages[from..] {
        let who = match message.role.as_str() {
            "user" => "You",
            "assistant" => "Theo",
            other => other,
        };
        let words: Vec<&str> = message
            .parts
            .iter()
            .filter_map(|part| match part {
                OwnerPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        let mut said = words.join("\n");
        if message.status == "running" {
            said.push_str(" \u{2026}");
        }
        let mut text = said.lines();
        lines.push(format!(
            "{}: {}",
            visible(who),
            visible(text.next().unwrap_or(""))
        ));
        lines.extend(text.map(|l| format!("  {}", visible(l))));
        for part in &message.parts {
            if let OwnerPart::Tool { name, status, .. } = part {
                lines.push(format!("  [{} {}]", visible(name), visible(status)));
            }
        }
    }
    let all = lines.join("\n");
    if all.len() <= RECENT_BYTES {
        return all;
    }
    let mut start = all.len() - RECENT_BYTES;
    while !all.is_char_boundary(start) {
        start += 1;
    }
    format!("\u{2026}{}", &all[start..])
}

/// The run's state in words: working (and on what), waiting for a person,
/// stopped, failed, or idle.
fn run_words(owner: &Owner) -> String {
    let run = &owner.run;
    match run.state.as_str() {
        "streaming" => match run.activity.as_deref().filter(|a| !a.is_empty()) {
            Some(activity) => format!("Working: {}.", visible(activity)),
            None => "Working.".to_owned(),
        },
        "waiting_approval" => match &owner.approval {
            Some(approval) => format!(
                "Waiting for a person to approve {}.",
                visible(&approval.tool_name)
            ),
            None => "Waiting for a person's approval.".to_owned(),
        },
        "stopped" => "Stopped.".to_owned(),
        "failed" => match run.error.as_deref().filter(|e| !e.is_empty()) {
            Some(error) => format!("Failed: {}.", visible(error)),
            None => "Failed.".to_owned(),
        },
        _ if owner.loading => "Loading.".to_owned(),
        _ => "Idle.".to_owned(),
    }
}

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
    /// How much of the model's window the thread uses, when the owner says.
    context: Option<OwnerContext>,
    /// The owner's clock when it made this snapshot, so a running call's elapsed time is
    /// the snapshot's own and the panel reads no clock.
    now_ms: Option<f64>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OwnerContext {
    used_tokens: u64,
    window_tokens: u64,
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
        /// When the thinking began and ended, when the owner says.
        #[serde(default)]
        started_at_ms: Option<f64>,
        #[serde(default)]
        ended_at_ms: Option<f64>,
    },
    Tool {
        id: String,
        /// When the call began and ended, when the owner says.
        #[serde(default)]
        started_at_ms: Option<f64>,
        #[serde(default)]
        ended_at_ms: Option<f64>,
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
        /// The approval the call asked for, when it asked for one.
        #[serde(default)]
        approval_id: Option<String>,
        /// What became of it: awaiting, approved, declined, failed or unanswered.
        #[serde(default)]
        approval_outcome: Option<String>,
        /// What it asked, in the run's words.
        #[serde(default)]
        approval_summary: Option<String>,
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
    /// One delegation of a run (Theorem's `theorem-delegation` part). A later
    /// state of the same delegation replaces the earlier one.
    Delegation {
        #[serde(default)]
        delegation_id: String,
        /// The run the delegation was made in: where its changes are listed.
        #[serde(default)]
        run_id: String,
        #[serde(default)]
        label: String,
        #[serde(default)]
        objective: String,
        #[serde(default)]
        state: String,
        #[serde(default)]
        verdict: Option<String>,
    },
    #[serde(other)]
    Other,
}

/// A delegation row as the panel shows it, read from the snapshot.
struct DelegationRow<'a> {
    delegation_id: &'a str,
    run_id: &'a str,
    label: &'a str,
    objective: &'a str,
    state: &'a str,
    verdict: Option<&'a str>,
}

impl DelegationRow<'_> {
    /// Who, and where it stands, in the owner's words, made safe to show.
    fn words(&self) -> (String, String) {
        let who = if self.label.is_empty() {
            "Delegated work".to_owned()
        } else {
            visible(self.label)
        };
        let state = match self.verdict {
            Some(verdict) if !verdict.is_empty() => {
                format!("{} ({})", visible(self.state), visible(verdict))
            }
            _ => visible(self.state),
        };
        (who, state)
    }
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
    /// The tool call that asked, whose arguments are the command or change asked about.
    tool_call_id: String,
    tool_name: String,
    summary: String,
    /// The run's own word for how risky it is; `unknown` when it gave none.
    risk: String,
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

    /// The conversation's delegations in the order they first appeared, each
    /// as its latest record.
    fn delegations(&self) -> Vec<DelegationRow<'_>> {
        let mut rows: Vec<DelegationRow<'_>> = Vec::new();
        for part in self.messages.iter().flat_map(|m| &m.parts) {
            let OwnerPart::Delegation {
                delegation_id,
                run_id,
                label,
                objective,
                state,
                verdict,
            } = part
            else {
                continue;
            };
            if delegation_id.is_empty() || run_id.is_empty() {
                continue;
            }
            let row = DelegationRow {
                delegation_id,
                run_id,
                label,
                objective,
                state,
                verdict: verdict.as_deref(),
            };
            match rows
                .iter_mut()
                .find(|r| r.delegation_id == delegation_id && r.run_id == run_id)
            {
                Some(held) => *held = row,
                None => rows.push(row),
            }
        }
        rows
    }

    /// What the tool call an approval asks about would do, from its arguments: `$ ` and the
    /// command a call runs, else the path it changes, else the arguments as they came.
    fn asked(&self, approval: &OwnerApproval) -> Option<String> {
        let args = self
            .messages
            .iter()
            .flat_map(|m| &m.parts)
            .find_map(|part| match part {
                OwnerPart::Tool { id, args, .. } if *id == approval.tool_call_id => {
                    Some(args.as_str())
                }
                _ => None,
            })
            .filter(|args| !args.trim().is_empty())?;
        let read: Option<Value> = serde_json::from_str(args).ok();
        let field = |key: &str| match read.as_ref().and_then(|v| v.get(key)) {
            Some(Value::String(text)) => Some(text.clone()),
            Some(Value::Array(words)) => Some(
                words
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            _ => None,
        };
        let words = field("command")
            .or_else(|| field("cmd"))
            .map(|command| format!("$ {command}"))
            .or_else(|| field("path"))
            .unwrap_or_else(|| args.to_owned());
        Some(words.split_whitespace().collect::<Vec<_>>().join(" "))
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
fn drawn(project: &str, owner: &Owner) -> Snapshot {
    let working = owner.working();
    let messages = owner
        .messages
        .iter()
        .map(|message| Message {
            id: (!message.id.is_empty()).then(|| message.id.clone()),
            role: message.role.clone(),
            parts: message.parts.iter().flat_map(parts_of).collect(),
            attachments: message.attachments.iter().map(|a| a.name.clone()).collect(),
        })
        .collect();
    // What the person sent while the run works is the panel's own queue, over the
    // composer, where it can be retried and removed; the transcript shows what was taken.
    let outgoing = Vec::new();
    Snapshot {
        now_ms: owner.now_ms,
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

/// A part as the transcript draws it: an answered approval adds its receipt before the call
/// that asked.
fn parts_of(part: &OwnerPart) -> Vec<Part> {
    let receipt = match part {
        OwnerPart::Tool {
            name,
            args,
            approval_id: Some(approval),
            approval_outcome: Some(outcome),
            approval_summary,
            ..
        } if outcome != "awaiting" => {
            let asked = approval_summary
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    format!(
                        "{name} {}",
                        args.split_whitespace().collect::<Vec<_>>().join(" ")
                    )
                });
            Some(Part::Receipt {
                text: asked,
                outcome: outcome.clone(),
                approval: approval.clone(),
            })
        }
        _ => None,
    };
    receipt.into_iter().chain([part_of(part)]).collect()
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
        OwnerPart::Reasoning {
            text,
            started_at_ms,
            ended_at_ms,
        } => Part::Reasoning {
            text: text.clone(),
            started_at_ms: *started_at_ms,
            ended_at_ms: *ended_at_ms,
        },
        OwnerPart::Tool {
            id,
            started_at_ms,
            ended_at_ms,
            name,
            args,
            status,
            result,
            result_truncated,
            diff,
            open,
            ..
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
                started_at_ms: *started_at_ms,
                ended_at_ms: *ended_at_ms,
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
        // Drawn by the panel's own list below the transcript, not in it.
        OwnerPart::Delegation { .. } | OwnerPart::Other => Part::Other,
    }
}

// ---- the conversation the owner is showing ------------------------------------------------

/// Which conversation the first snapshot named. The core retains the latest
/// snapshot of each conversation and replays it to a panel when it binds, but
/// a panel with no conversation yet has no resource to be replayed against:
/// this tells it which one the owner opened, and the core does the rest.
#[derive(Clone, Default)]
pub(crate) struct Directory(Rc<RefCell<Option<Latest>>>, FaceLink);

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

    /// The link the page reads Theo's face rectangle through. Shared with every
    /// Theo panel the mount builds from this directory.
    pub(crate) fn face(&self) -> &FaceLink {
        &self.1
    }

    fn project(&self) -> Option<String> {
        self.0.borrow().as_ref().map(|l| l.project.clone())
    }
}

// ---- Theo's face ----------------------------------------------------------------------------

/// Cells at the start of the status row that the panel keeps for Theo's face
/// when the page has one: the row the activity already lives on, one row tall.
const FACE_COLUMNS: u16 = 3;
/// The narrowest status row that gives up its first cells to the face; below
/// this the text matters more.
const FACE_MIN_ROW: u16 = 24;

/// Where the face is, in workbench grid cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct FaceCells {
    x: u16,
    y: u16,
    w: u16,
    h: u16,
}

#[derive(Default)]
struct FaceShared {
    /// The page has a face to lay over the cells. Until it says so the panel
    /// draws exactly what it drew before.
    wanted: bool,
    /// Cells a panel reserved in the frame being drawn, and whether it is focused.
    frame: Option<(FaceCells, bool)>,
    epoch: u64,
    published: Option<FaceCells>,
}

/// The handle between the page (through the workbench handle) and the Theo
/// panels, in the shape of `CabinetLink`: panels report per frame, the mount
/// calls `frame_end` after drawing, and the page reads `geometry_json`.
/// Cloning shares it.
#[derive(Clone, Default)]
pub(crate) struct FaceLink(Rc<RefCell<FaceShared>>);

impl FaceLink {
    /// Whether the page has a face to lay over the reserved cells.
    pub(crate) fn set_wanted(&self, wanted: bool) {
        self.0.borrow_mut().wanted = wanted;
    }

    fn wanted(&self) -> bool {
        self.0.borrow().wanted
    }

    /// One panel's reserved cells this frame. Of several, the focused one is
    /// the one the page shows; otherwise the first drawn.
    fn report(&self, cells: FaceCells, focused: bool) {
        let mut shared = self.0.borrow_mut();
        let replace = shared
            .frame
            .as_ref()
            .is_none_or(|(_, held)| focused && !held);
        if replace {
            shared.frame = Some((cells, focused));
        }
    }

    /// Called by the mount after each frame it drew the workbench, so a panel
    /// that was not drawn in it (hidden, drawer closed, closed) is reported
    /// gone. Publishes a new epoch when the cells moved, appeared or went.
    pub(crate) fn frame_end(&self) {
        let mut shared = self.0.borrow_mut();
        let drawn = shared.frame.take().map(|(cells, _)| cells);
        let drawn = if shared.wanted { drawn } else { None };
        if shared.published != drawn {
            shared.published = drawn;
            shared.epoch += 1;
        }
    }

    /// The face's cells as JSON `{epoch, cells}` (`cells` is null when no
    /// panel shows one), or `None` when `since` is already the latest epoch.
    pub(crate) fn geometry_json(&self, since: u64) -> Option<String> {
        let shared = self.0.borrow();
        (shared.epoch != since)
            .then(|| json!({ "epoch": shared.epoch, "cells": shared.published }).to_string())
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
    /// The draft that went, so a refusal can put it back whole.
    draft: Option<Draft>,
    /// The message the draft was an edit of.
    editing: Option<String>,
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
    /// Another thread, from the Threads panel, under this project.
    Switch(String),
    /// A control the owner answers by a host message (attach, model, effort).
    Control,
    Copy,
    /// The text left the draft only if the write was accepted.
    Cut,
    Paste,
    /// A file-name search for the `@` popup, by the composer's token.
    Files(u64),
    /// The repository's status for the footer, by the read it belongs to.
    RepoStatus(u64),
    /// One changed file's diff for the footer's totals: the read, and the row's place.
    RepoDiff(u64, usize),
}

/// Where a message sent while the run works stands, as the queue over the composer shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum QueueState {
    /// On its way to the owner.
    Sending,
    /// The owner has it; the run takes it at its next step.
    Queued,
    /// Nothing was sent, and why.
    Failed(Option<String>),
    /// Whether the owner took it is not known; it is never sent again under a fresh key.
    Uncertain,
}

/// One row of the queue: the owner's kept entry or the panel's own pending send.
#[derive(Clone, Debug)]
struct QueueRow {
    id: String,
    text: String,
    state: QueueState,
    /// Whether the owner holds these words for the run, rather than only this panel.
    kept: bool,
}

impl QueueRow {
    /// A row the owner may be asked again for: one it certainly refused, and one whose result
    /// nobody can confirm. A replay names the row's own request key, so an uncertain row is
    /// played again as the same request, never as a second message.
    fn retries(&self) -> bool {
        matches!(self.state, QueueState::Failed(_) | QueueState::Uncertain)
    }

    /// A row nothing more will happen to can be taken off the queue. One the owner holds
    /// for the run, or one still on its way, is not the panel's to take back.
    fn removes(&self) -> bool {
        matches!(self.state, QueueState::Failed(_) | QueueState::Uncertain)
    }

    /// Where it stands, in the transcript's words for sent input.
    fn words(&self) -> (String, Style) {
        let (status, reason) = match &self.state {
            QueueState::Sending => ("sending", None),
            QueueState::Queued => ("queued", None),
            QueueState::Failed(reason) => ("failed", reason.clone()),
            QueueState::Uncertain => ("uncertain", None),
        };
        let (tag, style) = crate::sent_tag(&Sent {
            text: String::new(),
            status: status.to_owned(),
            reason: reason.map(|r| visible(&r)),
        });
        (tag.unwrap_or_default(), style)
    }
}

/// What the footer under the composer shows, left to right.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum FooterItem {
    Project,
    Branch,
    Totals,
    Effort,
    Model,
    Stop,
}

/// The repository as the footer reads it: the Changes panel's own reads (the status, then
/// each changed row's diff), counted the way its review counts them.
#[derive(Default)]
struct Repo {
    /// The scm capability was granted at the last tick.
    granted: bool,
    /// A read is wanted.
    due: bool,
    /// A status read is in flight.
    reading: bool,
    /// The diffs of the rows the last status listed are to be asked for at the next tick.
    asking: bool,
    /// The read the answers in flight belong to.
    generation: u64,
    head: Option<String>,
    keys: Vec<RowKey>,
    /// Lines added and removed per row, once its diff has arrived and could be read.
    counts: Vec<Option<(usize, usize)>>,
}

impl Repo {
    /// Lines added and removed over every changed row, once every diff behind them is in.
    fn totals(&self) -> Option<(usize, usize)> {
        if self.keys.is_empty() || self.counts.iter().any(Option::is_none) {
            return None;
        }
        Some(
            self.counts
                .iter()
                .flatten()
                .fold((0, 0), |(a, d), (x, y)| (a + x, d + y)),
        )
    }
}

/// Where a queued row was drawn: the row, its retry and its remove.
type QueueCells = (Rect, Option<Rect>, Option<Rect>);

/// The most queue rows shown over the composer at once; the rest scroll with the chosen row.
const MAX_QUEUE_ROWS: usize = 4;
/// Send a failed queued message again, by its client message id.
const ACTION_QUEUE_RETRY: &str = "theo.view.queue.retry.";
/// Take a failed or uncertain queued message off the queue, by its client message id.
const ACTION_QUEUE_REMOVE: &str = "theo.view.queue.remove.";

/// The most text rows the composer takes before its text scrolls.
const MAX_TEXT_ROWS: u16 = 8;
/// The most delegation rows listed under the transcript at once; the rest
/// scroll with the chosen row.
const MAX_LISTED_DELEGATIONS: usize = 4;

pub(crate) struct TheoPanel {
    /// A side chat that has no conversation yet offers these rows.
    choice: usize,
    /// The side chats the owner said exist, once it has said.
    existing: Vec<SideChatInfo>,
    /// The owner has been asked which side chats exist.
    listed: bool,
    /// The task `code.start` gave a side chat that is still being made, and
    /// the agent run that asked: sent as the first message once the owner
    /// names the conversation.
    first_task: Option<(String, Actor)>,
    /// Words for a working run the owner has not yet named, with the client
    /// id they are shown under and who sent them: they go once it is named.
    awaiting_run: Vec<(String, String, Actor)>,
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
    composer: RefCell<Composer>,
    /// Where the composer was last drawn, in frame cells.
    composer_area: Cell<Rect>,
    /// Whether the delegation list has the keys (Up and Down choose, Enter
    /// opens, Esc gives them back to the composer), and the row chosen.
    in_list: bool,
    picked: usize,
    /// Whether the transcript's blocks have the keys (Up and Down walk them, Enter opens or
    /// closes one, `o` opens a diff's file, Esc gives the keys back to the composer).
    in_blocks: bool,
    /// Where the list's rows were last drawn, in frame cells, and the index
    /// of the first one drawn.
    list_area: Cell<Rect>,
    list_first: Cell<usize>,
    models: Vec<ModelChoice>,
    selected_model: Option<String>,
    effort: Option<String>,
    efforts: Vec<String>,
    /// Failed or uncertain rows of the owner's outbox the person took off the queue here.
    dismissed: BTreeSet<String>,
    /// Whether the queue has the keys (Up and Down choose, Enter sends a failed one again,
    /// Delete removes, Esc gives them back), and the row chosen.
    in_queue: bool,
    queue_pick: usize,
    /// Where each shown queue row was drawn, with its retry and remove words, and the index
    /// of the first one shown.
    queue_cells: RefCell<Vec<QueueCells>>,
    queue_first: Cell<usize>,
    /// Where the approval region and its Allow and Deny buttons were drawn.
    approval_cells: Cell<(Rect, Rect, Rect)>,
    /// Where each footer item was drawn.
    footer_cells: RefCell<Vec<(FooterItem, Rect)>>,
    repo: Repo,
    /// The conversation the model list was last asked for, so the footer names the model and
    /// effort without waiting for the person to open the list.
    models_asked: Option<String>,
    /// The account's projects by id, as the host last listed them.
    project_names: BTreeMap<String, String>,
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
        let mut composer = Composer::new("composer");
        composer.set_label(match kind {
            Kind::Main => "Message to Theo",
            Kind::Side => "Message to the side chat",
        });
        composer.set_placeholder(match kind {
            Kind::Main => "Message Theo",
            Kind::Side => "Message the side chat",
        });
        composer.set_prompt('\u{276F}');
        composer.restore(&state["draft"]);
        session.expanded = state["allOutput"].as_bool().unwrap_or(false);
        // How much activity shows is kept with the layout, as the rest of the panel's view is.
        session.activity_control = true;
        if let Some(level) = state["activity"].as_str().and_then(Activity::named) {
            session.level = level;
        }
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
            first_task: None,
            awaiting_run: Vec::new(),
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
            composer: RefCell::new(composer),
            composer_area: Cell::new(Rect::default()),
            in_list: false,
            picked: 0,
            in_blocks: false,
            list_area: Cell::new(Rect::default()),
            list_first: Cell::new(0),
            models: Vec::new(),
            selected_model: None,
            effort: None,
            efforts: Vec::new(),
            dismissed: BTreeSet::new(),
            in_queue: false,
            queue_pick: 0,
            queue_cells: RefCell::new(Vec::new()),
            queue_first: Cell::new(0),
            approval_cells: Cell::new(Default::default()),
            footer_cells: RefCell::new(Vec::new()),
            repo: Repo::default(),
            models_asked: None,
            project_names: BTreeMap::new(),
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
        let was_working = self.owner.working();
        self.owner = owner;
        // A turn that ended may have changed the work tree: the footer reads it again.
        if was_working && !self.owner.working() {
            self.repo.due = true;
        }
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
        let snapshot = drawn(&self.project, &self.owner);
        self.session.borrow_mut().set_snapshot(snapshot);
        self.composer
            .borrow_mut()
            .set_status(self.composer_status());
    }

    /// What the composer is told: whether Enter sends, steers or does nothing,
    /// and the model, effort and context use the footer shows.
    fn composer_status(&self) -> ComposerStatus {
        let policy = if !self.bound() {
            Policy::Blocked {
                reason: "connecting to the conversation".to_owned(),
            }
        } else if self.unreadable {
            Policy::Blocked {
                reason: "a snapshot could not be read".to_owned(),
            }
        } else if self.owner.loading {
            Policy::Blocked {
                reason: "loading the conversation".to_owned(),
            }
        } else if self.owner.working() {
            Policy::Running {
                can_steer: self.owner.run.run_id.is_some(),
            }
        } else {
            Policy::Idle
        };
        let model = self.selected_model.as_ref().map(|m| {
            self.models
                .iter()
                .find(|c| c.model_ref == *m)
                .map_or_else(|| m.clone(), |c| c.label.clone())
        });
        let context_percent = self
            .owner
            .context
            .as_ref()
            .filter(|c| c.window_tokens > 0)
            .map(|c| (c.used_tokens.saturating_mul(100) / c.window_tokens).min(100) as u8);
        // The model and effort are the footer's under the box, where they are chosen; the
        // composer keeps how much of the window the thread uses.
        let _ = model;
        ComposerStatus {
            policy,
            model: None,
            effort: None,
            context_percent,
        }
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
        self.emit_to(resource, cx, body, tracked)
    }

    /// An effect of another owner (the clipboard, the files): it needs no
    /// conversation.
    fn emit_to(
        &mut self,
        resource: ResourceRef,
        cx: &mut Ctx,
        body: EffectBody,
        tracked: Tracked,
    ) -> bool {
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

    /// The composer's Enter: an edit if one is being made, input for a working
    /// run, else a new turn. The draft leaves the composer only when the effect
    /// was emitted; a refusal later puts it back whole.
    fn submit(
        &mut self,
        text: String,
        attachments: Vec<String>,
        references: Vec<SourceReference>,
        mode: SubmitMode,
        cx: &mut Ctx,
    ) {
        if mode != SubmitMode::Edit
            && attachments.is_empty()
            && references.is_empty()
            && self.slash(&text, cx)
        {
            self.composer.borrow_mut().take();
            self.composer.borrow_mut().push_history(&text);
            self.refresh();
            return;
        }
        let id = self.mint();
        let body = match mode {
            SubmitMode::Edit => {
                let Some(message_id) = self.editing.clone() else {
                    self.session
                        .borrow_mut()
                        .notify("the message being edited is not known");
                    return;
                };
                EffectBody::ConversationEdit(ConversationEdit {
                    message_id,
                    client_message_id: id.clone(),
                    text: text.clone(),
                    references,
                })
            }
            SubmitMode::Steer => {
                if !attachments.is_empty() || !references.is_empty() {
                    self.session.borrow_mut().notify(
                        "a working run takes words only; send files and references as a new turn",
                    );
                    return;
                }
                let Some(run_id) = self.owner.run.run_id.clone() else {
                    self.session
                        .borrow_mut()
                        .notify("the run has no id to send input to");
                    return;
                };
                EffectBody::ConversationInput(ConversationInput {
                    run_id,
                    client_message_id: id.clone(),
                    text: text.clone(),
                })
            }
            SubmitMode::Send => {
                let held: Vec<AttachmentRef> = self
                    .composer
                    .borrow()
                    .attachments()
                    .iter()
                    .filter(|a| attachments.contains(&a.id))
                    .map(|a| AttachmentRef {
                        id: a.id.clone(),
                        name: a.name.clone(),
                        content_type: a.content_type.clone(),
                    })
                    .collect();
                EffectBody::ConversationSend(ConversationSend {
                    client_message_id: id.clone(),
                    text: text.clone(),
                    attachments: held,
                    references,
                })
            }
        };
        // The draft a refusal put back is the same message: sending it again replaces its
        // failed row. Other failed rows stay until they are sent again or removed.
        self.pending
            .retain(|p| !matches!(p.state, PendingState::Refused(_)) || p.text != text);
        if self.emit(cx, body, Tracked::Turn(id.clone())) {
            let editing = self.editing.take();
            let draft = {
                let mut composer = self.composer.borrow_mut();
                composer.push_history(&text);
                composer.take()
            };
            self.pending.push(Pending {
                client_message_id: id,
                text,
                state: PendingState::Sending,
                draft: Some(draft),
                editing,
            });
        }
        self.refresh();
    }

    /// `/new` and `/help` are the drawer's words, and an unknown `/word` says
    /// so; none of them is a message. True when `text` was one.
    fn slash(&mut self, text: &str, cx: &mut Ctx) -> bool {
        if !text.starts_with('/') || text.contains(char::is_whitespace) {
            return false;
        }
        match text {
            "/new" => self.new_conversation(cx),
            "/help" => {
                let mut session = self.session.borrow_mut();
                session.help = !session.help;
                session.built_for = None;
            }
            command => self
                .session
                .borrow_mut()
                .notify(format!("{command} is not a command; /help lists them")),
        }
        true
    }

    /// What the composer asked for, as effects.
    fn run(&mut self, response: ComposerResponse, cx: &mut Ctx) {
        for event in response.events {
            match event {
                ComposerEvent::Submit {
                    text,
                    attachments,
                    references,
                    mode,
                } => self.submit(text, attachments, references, mode, cx),
                ComposerEvent::Copy { text } => {
                    self.emit_to(
                        ResourceRef::None,
                        cx,
                        EffectBody::ClipboardWrite(ClipboardWrite { text }),
                        Tracked::Copy,
                    );
                }
                ComposerEvent::Cut { text } => {
                    if !self.emit_to(
                        ResourceRef::None,
                        cx,
                        EffectBody::ClipboardWrite(ClipboardWrite { text }),
                        Tracked::Cut,
                    ) {
                        self.composer.borrow_mut().cut_finished(false);
                    }
                }
                ComposerEvent::ReadClipboard => {
                    self.emit_to(
                        ResourceRef::None,
                        cx,
                        EffectBody::ClipboardRead,
                        Tracked::Paste,
                    );
                }
                ComposerEvent::AttachPick => {
                    self.emit(cx, EffectBody::ConversationAttachPick, Tracked::Control);
                }
                ComposerEvent::AttachRemove { id } => {
                    self.emit(
                        cx,
                        EffectBody::ConversationAttachRemove(AttachRemove { id }),
                        Tracked::Control,
                    );
                }
                ComposerEvent::ModelChosen { model_ref } => {
                    self.emit(
                        cx,
                        EffectBody::ConversationSetModel(SetModel { model_ref }),
                        Tracked::Control,
                    );
                }
                ComposerEvent::WantFiles { query, token } => {
                    let workspace = cx.workspace().workspace.clone();
                    self.emit_to(
                        ResourceRef::Workspace { workspace },
                        cx,
                        EffectBody::FilesSearch(FilesSearch {
                            query,
                            limit: Some(20),
                            offset: None,
                        }),
                        Tracked::Files(token),
                    );
                }
                ComposerEvent::RecallLast => self.begin_edit(),
            }
        }
    }

    /// Give the composer an input and carry out what it asks for.
    /// Put a reference into the draft, and say so, or say why it was not.
    fn refer(&mut self, reference: SourceReference) {
        let name = reference
            .label
            .clone()
            .unwrap_or_else(|| reference.path.clone());
        let cut = reference.excerpt_cut;
        let said = if self.kind == Kind::Side && !self.bound() {
            Err("not connected to a conversation yet".to_owned())
        } else {
            self.composer.borrow_mut().add_reference(reference)
        };
        let text = match said {
            Ok(()) if cut => format!("added the first {EXCERPT_LIMIT} characters of {name}"),
            Ok(()) => format!("added {name} to the message"),
            Err(why) => format!("not added: {name}: {why}"),
        };
        self.session.borrow_mut().notify(text);
    }

    fn compose(&mut self, input: ComposerInput, cx: &mut Ctx) -> bool {
        let response = self.composer.borrow_mut().handle(input, now());
        let handled = response.handled;
        self.run(response, cx);
        handled
    }

    /// Whether `c` answers the approval that is waiting: one is, and the person
    /// has typed nothing. With any text in the draft, or an input method
    /// composing, `y` and `n` are letters.
    fn answers_approval(&self, c: char) -> bool {
        let composer = self.composer.borrow();
        matches!(c, 'y' | 'n')
            && self.owner.approval.is_some()
            && composer.is_empty()
            && !composer.is_composing()
    }

    /// Whether the conversation has delegations to choose from here.
    fn lists_delegations(&self) -> bool {
        self.bound() && !self.unreadable && !self.owner.delegations().is_empty()
    }

    /// The delegation list: a heading, then the rows from the first that keeps
    /// the chosen one in view.
    fn draw_delegations(
        &self,
        buf: &mut Buffer,
        area: Rect,
        rows: &[DelegationRow<'_>],
        focused: bool,
    ) {
        self.list_area.set(Rect::default());
        if area.height < 2 || rows.is_empty() {
            return;
        }
        let p = palette();
        let room = usize::from(area.height) - 1;
        let picked = self.picked.min(rows.len() - 1);
        let first = if picked < room { 0 } else { picked + 1 - room };
        let hint = if self.in_list && focused {
            "Up/Down choose, Enter opens, Esc leaves"
        } else {
            "Alt+D to choose"
        };
        let heading = format!(" Delegations ({})  {hint}", rows.len());
        buf.set_stringn(
            area.x,
            area.y,
            heading,
            usize::from(area.width),
            Style::new().fg(p.muted),
        );
        let list = Rect::new(area.x, area.y + 1, area.width, area.height - 1);
        for (offset, row) in rows.iter().skip(first).take(room).enumerate() {
            let chosen = self.in_list && first + offset == picked;
            let (who, state) = row.words();
            let mark = if chosen { "\u{25b8}" } else { " " };
            let line = format!(
                " {mark} {who}  {state}  {}",
                visible(
                    &row.objective
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                )
            );
            let style = if chosen {
                Style::new().fg(p.accent).add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(p.ink)
            };
            buf.set_stringn(
                list.x,
                list.y + offset as u16,
                line,
                usize::from(list.width),
                style,
            );
        }
        self.list_area.set(list);
        self.list_first.set(first);
    }

    /// Open the delegation's changes panel. Reading only: it lists what the
    /// delegation changed and shows each file before and after.
    fn open_delegation(&mut self, delegation_id: &str, cx: &mut Ctx) {
        let found = self
            .owner
            .delegations()
            .into_iter()
            .find(|d| d.delegation_id == delegation_id)
            .map(|d| (d.run_id.to_owned(), d.delegation_id.to_owned()));
        match found {
            Some((run_id, delegation_id)) => cx.open(OpenTarget::Delegation {
                run_id,
                delegation_id,
                path: String::new(),
            }),
            None => self
                .session
                .borrow_mut()
                .notify("that delegation is no longer in this conversation"),
        }
    }

    /// Alt+D takes the keys into the delegation list, and again gives them
    /// back. Within it: Up and Down, Home and End choose, Enter opens, Esc
    /// leaves. Any other key leaves the list and is the composer's.
    fn list_key(&mut self, input: &KeyInput, cx: &mut Ctx) -> bool {
        let mods = input.mods();
        if mods == Mods::ALT && input.key() == Key::Char('d') && self.lists_delegations() {
            self.in_list = !self.in_list;
            return true;
        }
        if !self.in_list {
            return false;
        }
        let rows = self.owner.delegations();
        if rows.is_empty() {
            self.in_list = false;
            return false;
        }
        let last = rows.len() - 1;
        self.picked = self.picked.min(last);
        match (input.key(), mods.is_empty()) {
            (Key::Up, true) => self.picked = self.picked.saturating_sub(1),
            (Key::Down, true) => self.picked = (self.picked + 1).min(last),
            (Key::Home, true) => self.picked = 0,
            (Key::End, true) => self.picked = last,
            (Key::Enter, true) => {
                let id = rows[self.picked].delegation_id.to_owned();
                drop(rows);
                self.open_delegation(&id, cx);
            }
            (Key::Esc, _) => self.in_list = false,
            _ => {
                self.in_list = false;
                return false;
            }
        }
        true
    }

    // ---- the queue ----

    /// What the person sent while the run works that the transcript does not show yet, in
    /// the order sent: the owner's outbox, then the sends the owner has not answered.
    fn queue(&self) -> Vec<QueueRow> {
        if !self.bound() || self.unreadable {
            return Vec::new();
        }
        let owned = self
            .owner
            .queued
            .iter()
            .filter(|q| !self.dismissed.contains(&q.client_message_id))
            .map(|q| QueueRow {
                id: q.client_message_id.clone(),
                text: q.text.clone(),
                kept: true,
                state: match q.state.as_str() {
                    "sending" => QueueState::Sending,
                    "failed" => QueueState::Failed(q.reason.clone()),
                    "uncertain" => QueueState::Uncertain,
                    _ => QueueState::Queued,
                },
            });
        let mine = self.pending.iter().map(|p| QueueRow {
            id: p.client_message_id.clone(),
            text: p.text.clone(),
            kept: false,
            state: match &p.state {
                PendingState::Sending => QueueState::Sending,
                PendingState::Refused(reason) => QueueState::Failed(Some(reason.clone())),
                PendingState::Unknown => QueueState::Uncertain,
            },
        });
        owned.chain(mine).collect()
    }

    /// Take a failed or uncertain row off the queue. True when one was.
    fn remove_queued(&mut self, id: &str, cx: &mut Ctx) -> bool {
        let Some(row) = self.queue().into_iter().find(|r| r.id == id) else {
            return false;
        };
        if !row.removes() {
            return false;
        }
        let before = self.pending.len();
        self.pending.retain(|p| p.client_message_id != id);
        if self.pending.len() == before {
            self.dismissed.insert(id.to_owned());
        }
        // The owner keeps its own record of a held row; ask it to drop that too, so the
        // removal survives a reload instead of the row coming back.
        if self.bound() {
            let resource = self.resource();
            if let Ok(effect) = cx.emit(|effect| {
                Effect::new(
                    effect,
                    resource,
                    EffectBody::ConversationDismissInput(ConversationDismissInput {
                        client_message_id: id.to_owned(),
                    }),
                )
            }) {
                self.tracked.insert(effect, Tracked::Turn(id.to_owned()));
            }
        }
        true
    }

    /// Send a queue row's words again, as the message it already is: the retry names the row's
    /// own id, so the owner replays that request instead of being asked the same words under a
    /// fresh one. What becomes of them is the owner's — a run that works takes them again, a
    /// settled row goes as the next turn — and the row stays listed meanwhile.
    fn retry_queued(&mut self, id: &str, cx: &mut Ctx) {
        let Some(row) = self.queue().into_iter().find(|r| r.id == id && r.retries()) else {
            self.session
                .borrow_mut()
                .notify("that message is not one to send again");
            return;
        };
        if let Err(reason) = self.replay_queued(&row, cx) {
            self.session.borrow_mut().notify(reason);
        }
        self.refresh();
    }

    /// Re-issue `row` under the id it carries. An edit keeps the message it edits: turning a
    /// refused edit into a plain new turn would lose the branch the words were asked for.
    fn replay_queued(&mut self, row: &QueueRow, cx: &mut Ctx) -> Result<(), String> {
        if !self.bound() {
            return Err("not connected to a conversation yet".into());
        }
        let body = if row.kept {
            if let Some(run_id) = self.owner.run.run_id.clone() {
                EffectBody::ConversationInput(ConversationInput {
                    run_id,
                    client_message_id: row.id.clone(),
                    text: row.text.clone(),
                })
            } else {
                EffectBody::ConversationSend(ConversationSend {
                    client_message_id: row.id.clone(),
                    text: row.text.clone(),
                    attachments: Vec::new(),
                    references: Vec::new(),
                })
            }
        } else {
            let editing = self
                .pending
                .iter()
                .find(|p| p.client_message_id == row.id)
                .and_then(|p| p.editing.clone());
            self.words_body(&row.id, &row.text, editing.as_deref())?
        };
        let resource = self.resource();
        let effect = cx
            .emit(|effect| Effect::new(effect, resource, body))
            .map_err(|error| error.to_string())?;
        self.tracked.insert(effect, Tracked::Turn(row.id.clone()));
        // The same message, so its row is not duplicated and not taken off: a panel row goes
        // back to sending, and a kept one the owner will announce again on its own.
        if let Some(at) = self
            .pending
            .iter()
            .position(|p| p.client_message_id == row.id)
        {
            self.pending[at].state = PendingState::Sending;
        }
        Ok(())
    }

    /// What `text` goes as under the id that names it: an edit keeps the message it edits;
    /// other words join a working run's inbox, or start a turn of their own.
    fn words_body(
        &self,
        id: &str,
        text: &str,
        editing: Option<&str>,
    ) -> Result<EffectBody, String> {
        if let Some(message_id) = editing {
            return Ok(EffectBody::ConversationEdit(ConversationEdit {
                message_id: message_id.to_owned(),
                client_message_id: id.to_owned(),
                text: text.to_owned(),
                references: Vec::new(),
            }));
        }
        if self.owner.working() {
            let Some(run_id) = self.owner.run.run_id.clone() else {
                return Err("the run has no id to send input to".into());
            };
            return Ok(EffectBody::ConversationInput(ConversationInput {
                run_id,
                client_message_id: id.to_owned(),
                text: text.to_owned(),
            }));
        }
        Ok(EffectBody::ConversationSend(ConversationSend {
            client_message_id: id.to_owned(),
            text: text.to_owned(),
            attachments: Vec::new(),
            references: Vec::new(),
        }))
    }

    /// Send `text` as a message of its own, never through the composer, so a
    /// draft the person is writing stays as it is: input for a working run,
    /// else a new turn. `actor` is the agent run an earlier action was for,
    /// when the words wait on an answer before they go; otherwise the call's
    /// own actor sends them. Says why when nothing was sent.
    fn send_words(&mut self, text: String, actor: Option<Actor>, cx: &mut Ctx) -> Result<(), String> {
        if !self.bound() {
            return Err("not connected to a conversation yet".into());
        }
        let id = self.mint();
        // Words for a run that is working but not yet named wait until it is: the side
        // chat's run answers with its id a moment after it starts. Otherwise the body is
        // the message these words are — an input to the working run, or a new turn.
        if self.owner.working() && self.owner.run.run_id.is_none() {
            let actor = actor.unwrap_or_else(|| cx.actor().clone());
            self.awaiting_run.push((id.clone(), text.clone(), actor));
            self.pending.push(Pending {
                client_message_id: id,
                text,
                state: PendingState::Sending,
                draft: None,
                editing: None,
            });
            return Ok(());
        }
        let body = self.words_body(&id, &text, None)?;
        let resource = self.resource();
        let build = |effect| Effect::new(effect, resource, body);
        let sent = match actor {
            Some(actor) => cx.emit_as(actor, build),
            None => cx.emit(build),
        };
        let effect = sent.map_err(|error| error.to_string())?;
        self.tracked.insert(effect, Tracked::Turn(id.clone()));
        self.pending.push(Pending {
            client_message_id: id,
            text,
            state: PendingState::Sending,
            draft: None,
            editing: None,
        });
        Ok(())
    }

    /// The words that waited for the run to be named go now: as input once it
    /// is, or as a new turn if it ended first. Each goes as whoever sent it.
    fn send_awaiting(&mut self, cx: &mut Ctx) {
        let run_id = match (self.owner.working(), self.owner.run.run_id.clone()) {
            (true, None) => return,
            (true, Some(run_id)) => Some(run_id),
            (false, _) => None,
        };
        for (id, text, actor) in std::mem::take(&mut self.awaiting_run) {
            let body = match &run_id {
                Some(run_id) => EffectBody::ConversationInput(ConversationInput {
                    run_id: run_id.clone(),
                    client_message_id: id.clone(),
                    text,
                }),
                None => EffectBody::ConversationSend(ConversationSend {
                    client_message_id: id.clone(),
                    text,
                    attachments: Vec::new(),
                    references: Vec::new(),
                }),
            };
            let resource = self.resource();
            match cx.emit_as(actor, |effect| Effect::new(effect, resource, body)) {
                Ok(effect) => {
                    self.tracked.insert(effect, Tracked::Turn(id));
                }
                Err(error) => {
                    if let Some(p) = self.pending.iter_mut().find(|p| p.client_message_id == id) {
                        p.state = PendingState::Refused(error.to_string());
                    }
                }
            }
        }
    }

    /// `code.start` on a side chat that has no conversation yet: ask for a
    /// fresh one, and send the task as its first message once it exists.
    fn start_coding(&mut self, cx: &mut Ctx) {
        let Some(task) = cx.args().input().map(str::to_owned) else {
            cx.refuse("code.start needs the task as input.");
            return;
        };
        if self.kind != Kind::Side || self.bound() || self.first_task.is_some() {
            cx.refuse("code.start makes a new side chat; this one already has a conversation.");
            return;
        }
        if self.directory.project().is_none() && self.project.is_empty() {
            cx.refuse("The project is not known yet, so no side chat can be made.");
            return;
        }
        match self.new_side_chat(SideChatScope::Fresh, cx) {
            Ok(()) => self.first_task = Some((task, cx.actor().clone())),
            Err(reason) => cx.refuse(format!("No side chat was made: {reason}.")),
        }
    }

    /// `code.send`: the words go to this side chat as a message, or as input
    /// for its working run. The composer and its draft are not touched.
    fn send_coding(&mut self, cx: &mut Ctx) {
        let Some(text) = cx.args().input().map(str::to_owned) else {
            cx.refuse("code.send needs the words to send as input.");
            return;
        };
        if self.kind == Kind::Side && !self.bound() {
            cx.refuse(if self.first_task.is_some() {
                "The side chat is still being made; send again once it has its conversation."
            } else {
                "This side chat has no conversation yet."
            });
            return;
        }
        if let Err(reason) = self.send_words(text, None, cx) {
            cx.refuse(format!("Not sent: {reason}."));
        }
    }

    /// `code.stop`: stop this side chat's working run.
    fn stop_coding(&mut self, cx: &mut Ctx) {
        if !self.owner.working() {
            cx.refuse("No run is working in this side chat.");
            return;
        }
        self.stop(cx);
    }

    /// The side chat a `code.start` asked for now exists (or was refused):
    /// its task goes as the first message, for the run that asked.
    fn send_first_task(&mut self, cx: &mut Ctx) {
        let Some((task, actor)) = self.first_task.take() else {
            return;
        };
        if !self.bound() {
            self.session
                .borrow_mut()
                .notify("no side chat was made, so the coding task was not sent");
            return;
        }
        if let Err(reason) = self.send_words(task, Some(actor), cx) {
            self.session
                .borrow_mut()
                .notify(format!("the coding task was not sent: {reason}"));
        }
    }

    /// Alt+Q takes the keys into the queue, and again gives them back. Within it: Up and
    /// Down, Home and End choose, Enter sends a failed row again, Delete or Backspace
    /// removes a failed or uncertain one, Esc leaves. Any other key leaves and is the composer's.
    fn queue_key(&mut self, input: &KeyInput, cx: &mut Ctx) -> bool {
        let mods = input.mods();
        let rows = self.queue();
        if mods == Mods::ALT && input.key() == Key::Char('q') && !rows.is_empty() {
            self.in_queue = !self.in_queue;
            if self.in_queue {
                self.queue_pick = rows.iter().position(QueueRow::removes).unwrap_or(0);
            }
            return true;
        }
        if !self.in_queue {
            return false;
        }
        if rows.is_empty() {
            self.in_queue = false;
            return false;
        }
        let last = rows.len() - 1;
        self.queue_pick = self.queue_pick.min(last);
        let row = rows[self.queue_pick].clone();
        match (input.key(), mods.is_empty()) {
            (Key::Up, true) => self.queue_pick = self.queue_pick.saturating_sub(1),
            (Key::Down, true) => self.queue_pick = (self.queue_pick + 1).min(last),
            (Key::Home, true) => self.queue_pick = 0,
            (Key::End, true) => self.queue_pick = last,
            (Key::Enter, true) => {
                if row.retries() {
                    self.retry_queued(&row.id, cx);
                } else {
                    self.session
                        .borrow_mut()
                        .notify("only a message that was not sent goes again");
                }
            }
            (Key::Delete | Key::Backspace, true) => {
                if !self.remove_queued(&row.id, cx) {
                    self.session
                        .borrow_mut()
                        .notify("the owner holds this one for the run");
                }
            }
            (Key::Esc, _) => self.in_queue = false,
            _ => {
                self.in_queue = false;
                return false;
            }
        }
        if self.queue().is_empty() {
            self.in_queue = false;
        }
        true
    }

    /// The queue over the composer: one row per message, its words, where it stands, and
    /// what can be done with it.
    fn draw_queue(&self, buf: &mut Buffer, area: Rect, rows: &[QueueRow], focused: bool) {
        self.queue_cells.borrow_mut().clear();
        if area.height == 0 || rows.is_empty() {
            return;
        }
        let p = palette();
        let room = usize::from(area.height);
        let picked = self.queue_pick.min(rows.len() - 1);
        let first = if !self.in_queue || picked < room {
            0
        } else {
            picked + 1 - room
        };
        self.queue_first.set(first);
        let mut cells = Vec::new();
        for (offset, row) in rows.iter().skip(first).take(room).enumerate() {
            let y = area.y + offset as u16;
            let line = Rect::new(area.x, y, area.width, 1);
            let chosen = self.in_queue && first + offset == picked;
            if chosen {
                buf.set_style(line, Style::new().bg(p.selected_row.unwrap_or(p.selection)));
            }
            // The controls sit at the right: what can be done with this row.
            let mut right: Vec<(&str, bool)> = Vec::new();
            if row.retries() {
                right.push(("retry", true));
            }
            if row.removes() {
                right.push(("remove", false));
            }
            let controls: u16 = right.iter().map(|(w, _)| w.len() as u16 + 3).sum();
            let mut x = area.right().saturating_sub(controls + 1);
            let (mut retry, mut remove) = (None, None);
            for (word, is_retry) in &right {
                let text = format!("[{word}]");
                let w = text.len() as u16;
                if x >= area.x + 8 {
                    buf.set_stringn(
                        x,
                        y,
                        &text,
                        usize::from(w),
                        Style::new().fg(if *is_retry { p.accent } else { p.muted }),
                    );
                    let at = Rect::new(x, y, w, 1);
                    if *is_retry {
                        retry = Some(at);
                    } else {
                        remove = Some(at);
                    }
                }
                x += w + 1;
            }
            let (tag, tag_style) = row.words();
            let words = visible(&row.text.split_whitespace().collect::<Vec<_>>().join(" "));
            let mark = if chosen { "\u{25b8} " } else { "\u{276F} " };
            let room_for_text = usize::from(
                area.width
                    .saturating_sub(controls + 2)
                    .saturating_sub(tag.chars().count() as u16 + 5),
            );
            let shown = clip_words(&words, room_for_text.max(8));
            let spans = vec![
                Span::styled(
                    format!(" {mark}"),
                    Style::new().fg(if chosen { p.accent } else { p.muted }),
                ),
                Span::styled(shown, Style::new().fg(p.ink)),
                Span::styled(format!("  \u{b7} {tag}"), tag_style),
            ];
            let text_area = Rect::new(area.x, y, area.width.saturating_sub(controls + 1).max(1), 1);
            Line::from(spans).render(text_area, buf);
            cells.push((line, retry, remove));
        }
        let _ = focused;
        *self.queue_cells.borrow_mut() = cells;
    }

    /// A click on a queued row's retry or remove, an approval's Allow or Deny, or a
    /// footer item. True when it was one of them.
    fn click_controls(&mut self, cell: Position, cx: &mut Ctx) -> bool {
        let rows = self.queue();
        let cells = self.queue_cells.borrow().clone();
        let first = self.queue_first.get();
        for (at, (line, retry, remove)) in cells.into_iter().enumerate() {
            let Some(row) = rows.get(first + at) else {
                continue;
            };
            if retry.is_some_and(|r| r.contains(cell)) {
                self.retry_queued(&row.id, cx);
                return true;
            }
            if remove.is_some_and(|r| r.contains(cell)) {
                self.remove_queued(&row.id, cx);
                return true;
            }
            if line.contains(cell) {
                self.in_queue = true;
                self.queue_pick = first + at;
                return true;
            }
        }
        let (region, allow, deny) = self.approval_cells.get();
        if allow.contains(cell) {
            self.approve(true, cx);
            return true;
        }
        if deny.contains(cell) {
            self.approve(false, cx);
            return true;
        }
        if region.contains(cell) {
            return true;
        }
        let item = self
            .footer_cells
            .borrow()
            .iter()
            .find(|(_, r)| r.contains(cell))
            .map(|(i, _)| *i);
        match item {
            Some(FooterItem::Effort) => self.next_effort(cx),
            Some(FooterItem::Model) => self.choose_model(cx),
            Some(FooterItem::Stop) if self.owner.working() => self.stop(cx),
            Some(_) => {}
            None => return false,
        }
        true
    }

    // ---- the approval ----

    /// Rows the approval region takes: what is asked and the tool's risk, the summary, the
    /// command or change when the call carries one, and the two answers.
    fn approval_rows(&self) -> u16 {
        match &self.owner.approval {
            Some(approval) if self.bound() && !self.unreadable => {
                3 + u16::from(self.owner.asked(approval).is_some())
            }
            _ => 0,
        }
    }

    /// The waiting approval, pinned over the composer: an approval-coloured edge and
    /// heading on the conversation's own canvas, with no band behind it (owner, 2026-11-22).
    fn draw_approval(&self, buf: &mut Buffer, area: Rect) {
        self.approval_cells.set(Default::default());
        let Some(approval) = &self.owner.approval else {
            return;
        };
        if area.height < 3 {
            return;
        }
        let p = palette();
        for y in area.y..area.bottom() {
            buf.set_stringn(area.x, y, "\u{258E}", 1, Style::new().fg(p.approval));
        }
        let inner = Rect::new(
            area.x + 2,
            area.y,
            area.width.saturating_sub(3),
            area.height,
        );
        let width = usize::from(inner.width);
        let mut y = inner.y;
        let risk = visible(&approval.risk);
        let mut heading = vec![
            Span::styled(
                "? ",
                Style::new().fg(p.approval).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("{} needs your approval", visible(&approval.tool_name)),
                Style::new().fg(p.bright).add_modifier(Modifier::BOLD),
            ),
        ];
        if !risk.is_empty() && risk != "unknown" {
            heading.push(Span::styled(
                format!("  \u{b7} {risk} risk"),
                Style::new().fg(p.warning),
            ));
        }
        Line::from(heading).render(Rect::new(inner.x, y, inner.width, 1), buf);
        y += 1;
        let summary = visible(
            &approval
                .summary
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
        );
        buf.set_stringn(
            inner.x,
            y,
            clip_words(&summary, width),
            width,
            Style::new().fg(p.ink),
        );
        y += 1;
        if let Some(asked) = self.owner.asked(approval)
            && y + 1 < inner.bottom()
        {
            let command = visible(&asked.split_whitespace().collect::<Vec<_>>().join(" "));
            buf.set_stringn(
                inner.x,
                y,
                clip_words(&command, width),
                width,
                Style::new().fg(p.sage),
            );
            y += 1;
        }
        let sent = self.answered.as_deref() == Some(approval.approval_id.as_str());
        if sent {
            buf.set_stringn(inner.x, y, "answer sent", width, Style::new().fg(p.muted));
            self.approval_cells
                .set((area, Rect::default(), Rect::default()));
            return;
        }
        let allow = "[ Allow  y ]";
        let deny = "[ Deny  n ]";
        let allow_at = Rect::new(inner.x, y, allow.len() as u16, 1);
        let deny_at = Rect::new(allow_at.right() + 2, y, deny.len() as u16, 1);
        buf.set_stringn(
            allow_at.x,
            y,
            allow,
            width,
            Style::new().fg(p.success).add_modifier(Modifier::BOLD),
        );
        if deny_at.right() <= inner.right() {
            buf.set_stringn(
                deny_at.x,
                y,
                deny,
                usize::from(deny_at.width),
                Style::new().fg(p.error).add_modifier(Modifier::BOLD),
            );
        }
        self.approval_cells.set((area, allow_at, deny_at));
    }

    // ---- the footer ----

    /// What the footer would show, in order, and each item's words.
    fn footer_items(&self) -> Vec<(FooterItem, String)> {
        let mut items = Vec::new();
        if let Some(name) = self.project_names.get(&self.project) {
            items.push((FooterItem::Project, visible(name)));
        }
        if let Some(head) = &self.repo.head {
            items.push((FooterItem::Branch, visible(head)));
        }
        if let Some((added, removed)) = self.repo.totals() {
            items.push((FooterItem::Totals, format!("+{added} \u{2212}{removed}")));
        }
        if let Some(effort) = &self.effort {
            items.push((FooterItem::Effort, format!("{} effort", visible(effort))));
        }
        if let Some(model) = &self.selected_model {
            let label = self
                .models
                .iter()
                .find(|c| c.model_ref == *model)
                .map_or_else(|| model.clone(), |c| c.label.clone());
            items.push((FooterItem::Model, visible(&label)));
        }
        items.push((FooterItem::Stop, "\u{25A0} stop".to_owned()));
        items
    }

    /// The footer under the box, left to right as room allows: the project and branch and
    /// the diff totals at the left, effort, model and stop at the right. Too narrow for all
    /// of them, whole items go, in this order: the project, the totals, the branch, the
    /// effort, the model; stop goes first while no run works, and never while one does.
    fn draw_footer_row(&self, buf: &mut Buffer, area: Rect) {
        self.footer_cells.borrow_mut().clear();
        if area.height == 0 || area.width < 4 {
            return;
        }
        let p = palette();
        let working = self.owner.working();
        let mut items = self.footer_items();
        let order: &[FooterItem] = if working {
            &[
                FooterItem::Project,
                FooterItem::Totals,
                FooterItem::Branch,
                FooterItem::Effort,
                FooterItem::Model,
            ]
        } else {
            &[
                FooterItem::Stop,
                FooterItem::Project,
                FooterItem::Totals,
                FooterItem::Branch,
                FooterItem::Effort,
                FooterItem::Model,
            ]
        };
        let cols = |t: &str| unicode_width::UnicodeWidthStr::width(t) as u16;
        let left_of = |i: &FooterItem| {
            matches!(
                i,
                FooterItem::Project | FooterItem::Branch | FooterItem::Totals
            )
        };
        // Each side's items are joined by " · "; the sides stand two cells apart.
        let needed = |items: &[(FooterItem, String)]| -> u16 {
            let side = |left: bool| {
                let words: Vec<u16> = items
                    .iter()
                    .filter(|(i, _)| left_of(i) == left)
                    .map(|(_, t)| cols(t))
                    .collect();
                words.iter().sum::<u16>() + 3 * words.len().saturating_sub(1) as u16
            };
            2 + side(true) + 2 + side(false)
        };
        for drop in order {
            if needed(&items) <= area.width {
                break;
            }
            items.retain(|(i, _)| i != drop);
        }
        if needed(&items) > area.width {
            items.retain(|(i, _)| *i == FooterItem::Stop && working);
        }
        let style_of = |item: FooterItem| match item {
            FooterItem::Project => Style::new().fg(p.ink),
            FooterItem::Branch => Style::new().fg(p.muted),
            FooterItem::Totals => Style::new().fg(p.muted),
            FooterItem::Effort | FooterItem::Model => Style::new().fg(p.muted),
            FooterItem::Stop if working => Style::new().fg(p.error).add_modifier(Modifier::BOLD),
            FooterItem::Stop => Style::new().fg(p.text_disabled()),
        };
        let mut cells = Vec::new();
        let sep = Style::new().fg(p.text_disabled());
        let y = area.y;
        let mut x = area.x + 1;
        let left: Vec<_> = items.iter().filter(|(i, _)| left_of(i)).collect();
        for (at, (item, text)) in left.iter().enumerate() {
            if at > 0 {
                buf.set_stringn(x, y, " \u{b7} ", 3, sep);
                x += 3;
            }
            if *item == FooterItem::Totals {
                // The Changes panel's colours for added and removed lines.
                let (plus, minus) = text.split_once(' ').unwrap_or((text, ""));
                buf.set_stringn(
                    x,
                    y,
                    plus,
                    usize::from(cols(plus)),
                    Style::new().fg(p.diff_added_mark()),
                );
                buf.set_stringn(
                    x + cols(plus) + 1,
                    y,
                    minus,
                    usize::from(cols(minus)),
                    Style::new().fg(p.diff_removed_mark()),
                );
            } else {
                buf.set_stringn(x, y, text, usize::from(cols(text)), style_of(*item));
            }
            cells.push((*item, Rect::new(x, y, cols(text), 1)));
            x += cols(text);
        }
        let right: Vec<_> = items.iter().filter(|(i, _)| !left_of(i)).collect();
        let width: u16 = right.iter().map(|(_, t)| cols(t)).sum::<u16>()
            + 3 * right.len().saturating_sub(1) as u16;
        let mut x = area.right().saturating_sub(width + 1);
        for (at, (item, text)) in right.iter().enumerate() {
            if at > 0 {
                buf.set_stringn(x, y, " \u{b7} ", 3, sep);
                x += 3;
            }
            buf.set_stringn(x, y, text, usize::from(cols(text)), style_of(*item));
            cells.push((*item, Rect::new(x, y, cols(text), 1)));
            x += cols(text);
        }
        *self.footer_cells.borrow_mut() = cells;
    }

    /// The model list in the composer, or the owner asked for it first.
    fn choose_model(&mut self, cx: &mut Ctx) {
        self.control("conversation.model", cx, |me, cx| {
            if me.models.is_empty() {
                me.session.borrow_mut().notify("loading the models");
                me.emit(cx, EffectBody::ConversationModels, Tracked::Control);
            } else {
                let at = me
                    .models
                    .iter()
                    .position(|m| Some(&m.model_ref) == me.selected_model.as_ref())
                    .unwrap_or(0);
                me.composer.borrow_mut().open_models(me.models.clone(), at);
            }
        });
    }

    /// The next effort level the model offers, through the owner.
    fn next_effort(&mut self, cx: &mut Ctx) {
        self.control("conversation.model", cx, |me, cx| {
            if me.efforts.is_empty() {
                me.session
                    .borrow_mut()
                    .notify("this model has no effort levels");
                return;
            }
            let at = me
                .efforts
                .iter()
                .position(|e| Some(e) == me.effort.as_ref())
                .map_or(0, |i| i + 1);
            let level = me.efforts[at % me.efforts.len()].clone();
            me.emit(
                cx,
                EffectBody::ConversationSetEffort(SetEffort { level }),
                Tracked::Control,
            );
        });
    }

    // ---- the repository, for the footer ----

    fn repository(cx: &Ctx) -> ResourceRef {
        ResourceRef::Repository {
            workspace: cx.workspace().workspace.clone(),
            repository: REPOSITORY.to_owned(),
        }
    }

    /// Ask for what the footer reads of the repository, where the host grants scm: the
    /// status when a read is due, then the diff of each row it lists.
    fn read_repo(&mut self, cx: &mut Ctx) {
        let scm = self.bound() && cx.capabilities().has(&Capability::new("scm"));
        if scm && !self.repo.granted {
            self.repo.due = true;
        }
        self.repo.granted = scm;
        if !scm {
            return;
        }
        if self.repo.due && !self.repo.reading {
            self.repo.generation += 1;
            let generation = self.repo.generation;
            let resource = Self::repository(cx);
            if self.emit_to(
                resource,
                cx,
                EffectBody::ScmStatus,
                Tracked::RepoStatus(generation),
            ) {
                self.repo.due = false;
                self.repo.reading = true;
                self.repo.asking = false;
            }
        }
        if self.repo.asking {
            self.repo.asking = false;
            let generation = self.repo.generation;
            for (at, key) in self.repo.keys.clone().into_iter().enumerate() {
                let resource = Self::repository(cx);
                self.emit_to(
                    resource,
                    cx,
                    EffectBody::ScmDiff(theorem_workbench_core::effect::ScmDiff {
                        path: Some(key.path.clone()),
                        staged: key.section.diff_staged(),
                    }),
                    Tracked::RepoDiff(generation, at),
                );
            }
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
        self.composer.borrow_mut().load_for_edit(&text, Vec::new());
        self.editing = Some(id);
    }

    /// Open `thread` as the conversation, asked for by the Threads panel. The
    /// effect is stamped with the conversation this panel is bound to now, so
    /// its answer is judged against it; the target is in the payload.
    fn switch_to(&mut self, project: &str, thread: &str, cx: &mut Ctx) {
        if thread == self.thread && (project.is_empty() || project == self.project) {
            return;
        }
        let body = EffectBody::ConversationSwitch(ConversationSwitch {
            thread_id: thread.to_owned(),
            project_id: (!project.is_empty() && project != self.project)
                .then(|| project.to_owned()),
        });
        self.emit(cx, body, Tracked::Switch(project.to_owned()));
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
    fn new_side_chat(&mut self, scope: SideChatScope, cx: &mut Ctx) -> Result<(), String> {
        self.open_side_chat(SideChatOpen { scope: Some(scope), reopen: None }, cx)
    }

    /// Ask the owner to show a closed side chat's thread again. Its run, if
    /// one still works there, was never stopped by the close.
    fn reopen_side_chat(&mut self, chat: &SideChatInfo, cx: &mut Ctx) -> Result<(), String> {
        let Some(thread) = chat.thread_id.clone() else {
            return Err("that side chat has no stored thread to reopen".into());
        };
        self.open_side_chat(
            SideChatOpen {
                scope: Some(chat.scope),
                reopen: Some(thread),
            },
            cx,
        )
    }

    fn open_side_chat(&mut self, open: SideChatOpen, cx: &mut Ctx) -> Result<(), String> {
        if self.side_project().is_none() {
            return Err("the project is not known yet".into());
        }
        let resource = self.resource();
        match cx.emit(|id| Effect::new(id, resource, EffectBody::ConversationSideChat(open))) {
            Ok(id) => {
                self.tracked.insert(id, Tracked::NewSideChat);
                Ok(())
            }
            Err(error) => {
                let reason = error.to_string();
                self.session.borrow_mut().notify(reason.clone());
                Err(reason)
            }
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
            Some(ChooserRow::New(scope)) => {
                let _ = self.new_side_chat(scope, cx);
            }
            Some(ChooserRow::Existing(at)) => {
                let Some(chat) = self.existing.get(at).cloned() else {
                    return;
                };
                if chat.detached {
                    let _ = self.reopen_side_chat(&chat, cx);
                    return;
                }
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

    /// Esc, which the composer left to the panel: it leaves an edit, else
    /// stops the run (the composer's footer says so).
    fn escape(&mut self, cx: &mut Ctx) {
        if self.editing.take().is_some() {
            self.composer.borrow_mut().take();
        } else if self.owner.working() {
            self.stop(cx);
        }
    }

    /// Ctrl+C with nothing selected: stop a working run, else clear the draft.
    fn interrupt(&mut self, cx: &mut Ctx) {
        if self.owner.working() {
            self.stop(cx);
        } else {
            self.editing = None;
            self.composer.borrow_mut().take();
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
        let switched = match &tracked {
            Tracked::Switch(project) => Some(project.clone()),
            _ => None,
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
                        self.pending[at].state = PendingState::Refused(reason);
                        // The draft comes back whole, unless the person has
                        // already begun another. The row keeps what it was, so
                        // retrying it is still the same kind of message.
                        let editing = self.pending[at].editing.clone();
                        if let Some(draft) = self.pending[at].draft.take()
                            && self.composer.borrow_mut().put_back(draft)
                        {
                            self.editing = editing;
                        }
                    }
                }
                // Whatever the answer, the draft is not needed again.
                if let Some(p) = self.pending.get_mut(at) {
                    p.draft = None;
                }
            }
            Tracked::Copy => match said(&c.outcome) {
                Some(reason) => self
                    .session
                    .borrow_mut()
                    .notify(format!("not copied: {reason}")),
                None => self.session.borrow_mut().notify("copied"),
            },
            Tracked::Cut => {
                let accepted = matches!(c.outcome, Outcome::Accepted);
                self.composer.borrow_mut().cut_finished(accepted);
                if let Some(reason) = said(&c.outcome) {
                    self.session
                        .borrow_mut()
                        .notify(format!("not cut: {reason}"));
                }
            }
            Tracked::Paste => match (&c.outcome, c.payload) {
                (Outcome::Accepted, Some(CompletionPayload::Clipboard(text))) => {
                    self.composer
                        .borrow_mut()
                        .handle(ComposerInput::Paste(text.text), now());
                }
                (outcome, _) => {
                    let why = said(outcome).unwrap_or_else(|| "the clipboard sent no text".into());
                    self.session
                        .borrow_mut()
                        .notify(format!("not pasted: {why}"));
                }
            },
            Tracked::RepoStatus(generation) => {
                if generation != self.repo.generation {
                    return;
                }
                self.repo.reading = false;
                match (&c.outcome, c.payload) {
                    (Outcome::Accepted, Some(CompletionPayload::Scm(status))) => {
                        let head = Head::of(&status);
                        self.repo.head = (head != Head::NotReported).then(|| head.label());
                        self.repo.keys = Groups::classify(&status.changes)
                            .keys()
                            .filter(|k| k.section.can_diff())
                            .take(theorem_workbench_changes::LISTED)
                            .collect();
                        self.repo.counts = vec![None; self.repo.keys.len()];
                        self.repo.asking = !self.repo.keys.is_empty();
                    }
                    // A status the host could not read leaves the footer without the
                    // branch and the totals until the next read.
                    _ => {
                        self.repo.head = None;
                        self.repo.keys.clear();
                        self.repo.counts.clear();
                    }
                }
            }
            Tracked::RepoDiff(generation, at) => {
                if generation != self.repo.generation {
                    return;
                }
                let counted = match (&c.outcome, c.payload) {
                    (Outcome::Accepted, Some(CompletionPayload::ScmDiff(diff))) => {
                        match parse(&diff.text) {
                            Ok(Parsed::Hunks(hunks)) => {
                                Some(hunks.iter().flat_map(|h| &h.lines).fold(
                                    (0, 0),
                                    |(a, d), line| match line.kind {
                                        LineKind::Added => (a + 1, d),
                                        LineKind::Removed => (a, d + 1),
                                        _ => (a, d),
                                    },
                                ))
                            }
                            Ok(_) => Some((0, 0)),
                            Err(_) => None,
                        }
                    }
                    _ => None,
                };
                if let Some(slot) = self.repo.counts.get_mut(at) {
                    *slot = counted;
                }
            }
            Tracked::Files(token) => {
                if let (Outcome::Accepted, Some(CompletionPayload::FileSearchPage(page))) =
                    (&c.outcome, c.payload)
                {
                    let paths = page
                        .rows
                        .into_iter()
                        .filter(|r| r.kind != FileKind::Directory)
                        .map(|r| r.path)
                        .collect();
                    self.composer.borrow_mut().files_found(token, paths);
                } else if let Some(reason) = said(&c.outcome) {
                    self.session
                        .borrow_mut()
                        .notify(format!("files not found: {reason}"));
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
            Tracked::Control
            | Tracked::Stop
            | Tracked::Retry
            | Tracked::NewConversation
            | Tracked::NewSideChat
            | Tracked::ListSideChats
            | Tracked::SwitchBranch
            | Tracked::Switch(_) => {
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
                        // A switch from the Threads panel may change the project too.
                        if let Some(project) = switched.filter(|p| !p.is_empty()) {
                            self.project = project;
                        }
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

    /// Run a composer control only where the host grants its capability; a
    /// panel never offers what the host cannot do.
    fn control(
        &mut self,
        capability: &'static str,
        cx: &mut Ctx,
        run: impl FnOnce(&mut Self, &mut Ctx),
    ) {
        if !self.bound() || !cx.capabilities().has(&Capability::new(capability)) {
            self.session
                .borrow_mut()
                .notify("the host does not offer this here");
            return;
        }
        run(self, cx);
    }

    /// How far Alt+[ (back) or Alt+] (forward) steps through the thread's
    /// branches, for `on_key` to do and `takes_chord` to ask. An unbound side
    /// chat has only its list, which takes no Alt chord.
    fn branch_step(&self, input: &KeyInput) -> Option<isize> {
        if (self.kind == Kind::Side && !self.bound()) || !input.mods().contains(Mods::ALT) {
            return None;
        }
        match input.key() {
            Key::Char('[') => Some(-1),
            Key::Char(']') => Some(1),
            _ => None,
        }
    }

    /// Whether Option and this key changes the branch now. Where `on_key` would
    /// only say "this conversation has only one branch" or "a run is working",
    /// the character is left to be typed.
    fn takes_chord(&self, input: &KeyInput) -> bool {
        (input.mods() == Mods::ALT && input.key() == Key::Char('v'))
            || (input.mods() == Mods::ALT
                && input.key() == Key::Char('q')
                && !self.queue().is_empty())
            || (input.mods() == Mods::ALT
                && matches!(input.key(), Key::Char('m' | 't'))
                && self.bound())
            || (input.mods() == Mods::ALT
                && input.key() == Key::Up
                && !self.session.borrow().stops().is_empty())
            || (input.mods() == Mods::ALT
                && input.key() == Key::Char('d')
                && self.lists_delegations())
            || (self.branch_step(input).is_some()
                && !self.owner.working()
                && self
                    .owner
                    .history
                    .as_ref()
                    .is_some_and(|h| !h.forks.is_empty()))
    }

    fn on_key(&mut self, input: &KeyInput, cx: &mut Ctx) {
        if self.kind == Kind::Side && !self.bound() {
            let Some(event) = event_of(input) else {
                return;
            };
            let last = self.rows().len().saturating_sub(1);
            match event.code {
                KeyCode::Up => self.choice = self.choice.saturating_sub(1),
                KeyCode::Down => self.choice = (self.choice + 1).min(last),
                KeyCode::Enter => self.choose_row(self.choice, cx),
                _ => {}
            }
            return;
        }
        let mods = input.mods();
        if self.list_key(input, cx) {
            return;
        }
        // Alt+[ and Alt+] select the previous and the next branch of the thread.
        if let Some(step) = self.branch_step(input) {
            return self.branch(step, cx);
        }
        if self.queue_key(input, cx) {
            return;
        }
        // Alt+M opens the model list and Alt+T takes the next effort, as the footer's do.
        if mods == Mods::ALT && input.key() == Key::Char('m') {
            return self.choose_model(cx);
        }
        if mods == Mods::ALT && input.key() == Key::Char('t') {
            return self.next_effort(cx);
        }
        // `y` and `n` answer a waiting approval while nothing is typed; they
        // are checked before the composer so they are never taken as text.
        if let Key::Char(c) = input.key()
            && !mods.intersects(Mods::CTRL | Mods::CMD | Mods::ALT)
            && self.answers_approval(c)
        {
            return self.approve(c == 'y', cx);
        }
        if self.block_key(input, cx) {
            return;
        }
        if self.compose(ComposerInput::Key(*input), cx) {
            return;
        }
        // The keys the composer left: the run's and the transcript's.
        match (input.key(), mods.contains(Mods::CTRL)) {
            (Key::Esc, _) => self.escape(cx),
            (Key::Char('c'), true) => self.interrupt(cx),
            (Key::Tab, _) => {}
            _ => {
                if let Some(event) = event_of(input) {
                    self.session.borrow_mut().transcript_key(event);
                }
            }
        }
    }

    /// Alt+V changes how much activity shows; Alt+Up gives the keys to the transcript's
    /// blocks, where Up and Down walk them, Enter opens or closes one and `o` opens the file a
    /// diff wrote. Any other key gives them back and goes on to the composer.
    fn block_key(&mut self, input: &KeyInput, cx: &mut Ctx) -> bool {
        let mods = input.mods();
        if mods == Mods::ALT && input.key() == Key::Char('v') {
            self.cycle_level();
            return true;
        }
        if mods == Mods::ALT && input.key() == Key::Up {
            let mut session = self.session.borrow_mut();
            if session.stops().is_empty() {
                return false;
            }
            let step = if self.in_blocks { -1 } else { 0 };
            self.in_blocks = true;
            session.step_cursor(step);
            return true;
        }
        if !self.in_blocks {
            return false;
        }
        if !mods.intersects(Mods::CTRL | Mods::CMD | Mods::ALT) {
            match input.key() {
                Key::Up => {
                    self.session.borrow_mut().step_cursor(-1);
                    return true;
                }
                Key::Down => {
                    self.session.borrow_mut().step_cursor(1);
                    return true;
                }
                Key::Enter | Key::Char(' ') => {
                    let key = self.session.borrow().cursor.clone();
                    if let Some(key) = key {
                        self.toggle_block(&key);
                    }
                    return true;
                }
                Key::Char('o') => {
                    let key = self.session.borrow().cursor.clone();
                    if let Some(key) = key {
                        self.open_block(&key, cx);
                    }
                    return true;
                }
                Key::Esc => {
                    self.leave_blocks();
                    return true;
                }
                _ => {}
            }
        }
        self.leave_blocks();
        false
    }

    fn leave_blocks(&mut self) {
        self.in_blocks = false;
        self.session.borrow_mut().cursor = None;
    }

    /// The next activity level: headers, then summary only, then everything.
    fn cycle_level(&mut self) {
        let next = self.session.borrow().level.next();
        self.set_level(next);
    }

    fn set_level(&mut self, level: Activity) {
        let mut session = self.session.borrow_mut();
        session.set_level(level);
        session.notify(format!("activity shows {}", level.word()));
    }

    /// Open or close a block by its key, if it opens.
    fn toggle_block(&mut self, key: &str) {
        let mut session = self.session.borrow_mut();
        if session
            .blocks
            .iter()
            .any(|b| b.key == key && b.expanded.is_some())
        {
            session.toggle(key);
        }
    }

    /// Open the file a block names, in the editor, at the lines it touched.
    fn open_block(&mut self, key: &str, cx: &mut Ctx) {
        let open = {
            let session = self.session.borrow();
            session
                .blocks
                .iter()
                .find(|b| b.key == key)
                .and_then(|b| b.open.clone())
        };
        match open {
            Some(open) => open_file(open, cx),
            None => self
                .session
                .borrow_mut()
                .notify("this block names no file to open"),
        }
    }

    fn on_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        let (x, y, kind, clicks) = (p.x, p.y, p.kind, p.clicks);
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
        // The composer takes a pointer over its cells, and a drag it began
        // wherever it goes. It works in frame cells.
        let area = self.area.get();
        let (fx, fy) = (x + i32::from(area.x), y + i32::from(area.y));
        let over = {
            let r = self.composer_area.get();
            fx >= i32::from(r.x)
                && fx < i32::from(r.right())
                && fy >= i32::from(r.y)
                && fy < i32::from(r.bottom())
        };
        let dragging = self.composer.borrow().is_dragging();
        if over || (dragging && !matches!(kind, PointerKind::Down(_))) {
            let framed = PanelPointer { x: fx, y: fy, ..p };
            if self.compose(ComposerInput::Pointer(framed), cx) {
                return;
            }
            if over && !matches!(kind, PointerKind::Wheel { .. }) {
                return;
            }
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
                // A click on a delegation row chooses it and opens it.
                let list = self.list_area.get();
                if fx >= i32::from(list.x)
                    && fx < i32::from(list.right())
                    && fy >= i32::from(list.y)
                    && fy < i32::from(list.bottom())
                {
                    let at = self.list_first.get()
                        + usize::try_from(fy - i32::from(list.y)).unwrap_or(0);
                    let id = self
                        .owner
                        .delegations()
                        .get(at)
                        .map(|d| d.delegation_id.to_owned());
                    if let Some(id) = id {
                        self.picked = at;
                        self.open_delegation(&id, cx);
                    }
                    return;
                }
                let area = self.area.get();
                let (Ok(x), Ok(y)) = (u16::try_from(x), u16::try_from(y)) else {
                    return;
                };
                let cell = Position::new(area.x + x, area.y + y);
                if self.click_controls(cell, cx) {
                    return;
                }
                // The status row's activity level: a click takes the next one.
                if self.session.borrow().level_area.contains(cell) {
                    self.cycle_level();
                    return;
                }
                // A thinking, summary or diff header opens or closes; a diff's path opens its
                // file.
                let block = {
                    let session = self.session.borrow();
                    session
                        .block_at(cell)
                        .filter(|(b, _)| b.kind != BlockKind::Tool && b.kind != BlockKind::Running)
                        .map(|(b, on_path)| (b.key.clone(), b.open.clone(), on_path))
                };
                if let Some((key, open, on_path)) = block {
                    match open {
                        Some(open) if on_path => open_file(open, cx),
                        _ => self.toggle_block(&key),
                    }
                    return;
                }
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
                    (_, Some(open)) => open_file(open, cx),
                    (None, None) => {}
                }
            }
            _ => {}
        }
    }
}

/// The view's own actions (under `theo.view.`, which the core hands to this panel): the next
/// activity level, one level by name, a block opened or closed, a block's file opened.
const ACTION_ACTIVITY: &str = "theo.view.activity";
const ACTION_ACTIVITY_LEVEL: &str = "theo.view.activity.";
const ACTION_BLOCK: &str = "theo.view.block.";
const ACTION_BLOCK_OPEN: &str = "theo.view.open.";

/// Open a file a tool worked on in the editor, at its first touched line when known: the
/// same open the Changes panel makes.
fn open_file(open: Open, cx: &mut Ctx) {
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

/// `text` in at most `width` columns, cut at a word's end with an ellipsis, never in a word.
fn clip_words(text: &str, width: usize) -> String {
    let cols = |t: &str| unicode_width::UnicodeWidthStr::width(t);
    if cols(text) <= width {
        return text.to_owned();
    }
    let mut out = String::new();
    for word in text.split(' ') {
        let next = if out.is_empty() {
            word.to_owned()
        } else {
            format!("{out} {word}")
        };
        if cols(&next) + 1 > width {
            break;
        }
        out = next;
    }
    if out.is_empty() {
        // One word wider than the room: its first characters, marked as cut.
        let mut cut = String::new();
        for c in text.chars() {
            if cols(&cut) + unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) + 1 > width {
                break;
            }
            cut.push(c);
        }
        out = cut;
    }
    format!("{out}\u{2026}")
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
                let mut chars = text.chars();
                let walking = self.in_blocks;
                match (chars.next(), chars.next()) {
                    (Some(c), None) if self.answers_approval(c) => self.approve(c == 'y', cx),
                    // In the browser a bare character arrives as typed text, not as a key: while
                    // the keys walk the blocks, `o` and space are theirs as `block_key` reads them.
                    (Some(c @ ('o' | ' ')), None) if walking => {
                        let key = self.session.borrow().cursor.clone();
                        if let Some(key) = key {
                            if c == 'o' {
                                self.open_block(&key, cx);
                            } else {
                                self.toggle_block(&key);
                            }
                        }
                    }
                    _ => {
                        // Any other typing gives the keys back to the composer.
                        self.leave_blocks();
                        self.in_queue = false;
                        self.compose(ComposerInput::Text(text), cx);
                    }
                }
            }
            PanelMsg::Paste(text) => {
                if self.kind == Kind::Main || self.bound() {
                    self.compose(ComposerInput::Paste(text), cx);
                }
            }
            PanelMsg::Composition(c) => {
                if self.kind == Kind::Main || self.bound() {
                    self.compose(ComposerInput::Composition(c), cx);
                }
            }
            PanelMsg::Motion { reduced } => self.composer.borrow_mut().set_reduced_motion(reduced),
            // "Add selection to chat" from another panel: the same reference
            // the person's own `@` insertion makes, at the draft's caret. The
            // keyboard stays where it is; the pane says what happened.
            PanelMsg::Reference(reference) => self.refer(reference),
            PanelMsg::Focus(focused) => self.composer.borrow_mut().set_window_focused(focused),
            PanelMsg::Pointer(p) => self.on_pointer(p, cx),
            PanelMsg::Completion(c) => {
                let opening = matches!(self.tracked.get(&c.effect), Some(Tracked::NewSideChat));
                self.completed(c);
                if opening {
                    self.send_first_task(cx);
                }
            }
            PanelMsg::Host(HostMessage::ConversationSnapshot {
                resource: ResourceRef::Conversation { project, thread },
                revision: Revision::Seq(revision),
                snapshot,
                ..
            }) => {
                self.adopt(&project, &thread, revision, &snapshot);
                self.send_awaiting(cx);
            }
            PanelMsg::Host(HostMessage::ConversationAttachments {
                resource: ResourceRef::Conversation { thread, .. },
                attachments,
                ..
            }) if thread == self.thread => {
                self.composer.borrow_mut().set_attachments(attachments);
            }
            PanelMsg::Host(HostMessage::ConversationModels {
                resource: ResourceRef::Conversation { thread, .. },
                models,
                selected,
                effort,
                efforts,
                ..
            }) if thread == self.thread => {
                self.models = models;
                self.selected_model = selected;
                self.effort = effort;
                self.efforts = efforts;
            }
            PanelMsg::Host(HostMessage::ThreadsChanged { listing }) => {
                self.project_names = listing
                    .projects
                    .into_iter()
                    .map(|p| (p.id, p.name))
                    .collect();
            }
            // The work tree may have changed: the footer's branch and totals are read again.
            PanelMsg::Host(HostMessage::FileChanged { .. } | HostMessage::Resync { .. }) => {
                self.repo.due = true;
            }
            PanelMsg::Action(id) => match id.as_str() {
                "theo.stop" => self.stop(cx),
                "approval.allow" => self.approve(true, cx),
                "approval.deny" => self.approve(false, cx),
                "theo.new" => self.new_conversation(cx),
                "theo.retry" => self.retry(cx),
                "theo.edit" => self.begin_edit(),
                // The same Enter the person presses: the composer decides whether
                // the draft goes, and how.
                "theo.send" => {
                    self.compose(
                        ComposerInput::Key(KeyInput::new(Key::Enter, Mods::empty())),
                        cx,
                    );
                }
                "theo.attach" => self.control("conversation.attach", cx, |me, cx| {
                    let response = me.composer.borrow_mut().attach();
                    me.run(response, cx);
                }),
                "theo.model" => self.choose_model(cx),
                "theo.effort" => self.next_effort(cx),
                name if name.starts_with(ACTION_QUEUE_RETRY) => {
                    let id = name[ACTION_QUEUE_RETRY.len()..].to_owned();
                    self.retry_queued(&id, cx);
                }
                name if name.starts_with(ACTION_QUEUE_REMOVE) => {
                    let id = name[ACTION_QUEUE_REMOVE.len()..].to_owned();
                    if !self.remove_queued(&id, cx) {
                        self.session
                            .borrow_mut()
                            .notify("the owner holds this one for the run");
                    }
                }
                "theo.switch" => self
                    .session
                    .borrow_mut()
                    .notify("pick a conversation in the Threads panel"),
                "theo.branch" => self.branch(1, cx),
                ACTION_ACTIVITY => self.cycle_level(),
                name if name.starts_with(ACTION_ACTIVITY_LEVEL) => {
                    match Activity::named(&name[ACTION_ACTIVITY_LEVEL.len()..]) {
                        Some(level) => self.set_level(level),
                        None => self.session.borrow_mut().notify("no such activity level"),
                    }
                }
                name if name.starts_with(ACTION_BLOCK_OPEN) => {
                    let key = name[ACTION_BLOCK_OPEN.len()..].to_owned();
                    self.open_block(&key, cx);
                }
                name if name.starts_with(ACTION_BLOCK) => {
                    let key = name[ACTION_BLOCK.len()..].to_owned();
                    self.toggle_block(&key);
                }
                name if name
                    .starts_with(theorem_workbench_core::panels::ACTION_DELEGATION_OPEN) =>
                {
                    let id = name[theorem_workbench_core::panels::ACTION_DELEGATION_OPEN.len()..]
                        .to_owned();
                    self.open_delegation(&id, cx);
                }
                "side-chat.create" if self.kind == Kind::Side && !self.bound() => {
                    self.choose_row(self.choice, cx);
                }
                "side-chat.create" => {}
                "code.start" => self.start_coding(cx),
                "code.send" => self.send_coding(cx),
                "code.stop" => self.stop_coding(cx),
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
                let reading = self.repo.reading || self.repo.counts.iter().any(Option::is_none);
                self.read_repo(cx);
                if self.bound()
                    && self.models.is_empty()
                    && self.models_asked.as_deref() != Some(self.thread.as_str())
                    && cx
                        .capabilities()
                        .has(&Capability::new("conversation.model"))
                {
                    self.models_asked = Some(self.thread.clone());
                    self.emit(cx, EffectBody::ConversationModels, Tracked::Control);
                }
                let live = {
                    let session = self.session.borrow();
                    session.snapshot.running
                        || session.notice.is_some()
                        || self
                            .pending
                            .iter()
                            .any(|p| p.state == PendingState::Sending)
                };
                if moved || live || reading {
                    cx.invalidate();
                }
            }
            // A name search is for the workspace, not for the conversation this
            // panel is bound to, so the core hands its answer over as cached;
            // it is the answer to the `@` popup all the same.
            PanelMsg::Cached(c) => {
                if matches!(
                    self.tracked.get(&c.effect),
                    Some(Tracked::Files(_) | Tracked::RepoStatus(_) | Tracked::RepoDiff(..))
                ) {
                    self.completed(c);
                }
            }
            PanelMsg::Switch { project, thread } => self.switch_to(&project, &thread, cx),
            PanelMsg::Resize { .. }
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
        // The conversation sits on the canvas, a step below the panels it stands between.
        Block::new()
            .style(Style::new().bg(p.canvas()).fg(p.ink))
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
        // The delegations a run made list under the transcript: a heading and
        // up to MAX_LISTED_DELEGATIONS rows, only while the transcript keeps
        // three rows and the box four.
        let delegations = if self.bound() && !self.unreadable && !self.owner.loading {
            self.owner.delegations()
        } else {
            vec![]
        };
        // Over the box, the messages sent while the run works and a waiting approval;
        // under it, the footer. The transcript keeps three rows and the box four; the
        // footer goes in first, then the approval, then as many queued rows as fit.
        let live = self.bound() && !self.unreadable && !self.owner.loading;
        let queue = if live { self.queue() } else { Vec::new() };
        let available = area
            .height
            .saturating_sub(1 + u16::from(referenced) + 4 + 3);
        let footer_rows = u16::from(live && available >= 1);
        let approval_rows = {
            let wanted = if live { self.approval_rows() } else { 0 };
            if footer_rows + wanted <= available {
                wanted
            } else {
                0
            }
        };
        let queue_rows = (queue.len().min(MAX_QUEUE_ROWS) as u16)
            .min(available.saturating_sub(footer_rows + approval_rows));
        let extra = footer_rows + approval_rows + queue_rows;
        let strip = {
            let wanted = if delegations.is_empty() {
                0
            } else {
                1 + delegations.len().min(MAX_LISTED_DELEGATIONS) as u16
            };
            let spare = area
                .height
                .saturating_sub(1 + u16::from(referenced) + 4 + 3 + extra);
            let strip = wanted.min(spare);
            if strip < 2 { 0 } else { strip }
        };
        // The box grows with the draft, to a bounded share of the panel, and
        // never takes the transcript's last three rows.
        let room = area
            .height
            .saturating_sub(1 + u16::from(referenced) + strip + 3 + extra);
        let wanted = {
            let composer = self.composer.borrow();
            // Two borders and a margin each side.
            composer.desired_height(area.width.saturating_sub(4), MAX_TEXT_ROWS) + 2
        };
        let box_height = wanted.min(room).min(area.height / 2).max(4.min(room));
        let [
            body,
            list,
            status,
            references,
            queued,
            asking,
            prompt,
            footer,
        ] = Layout::vertical([
            Constraint::Fill(1),
            Constraint::Length(strip),
            Constraint::Length(1),
            Constraint::Length(u16::from(referenced)),
            Constraint::Length(queue_rows),
            Constraint::Length(approval_rows),
            Constraint::Length(box_height),
            Constraint::Length(footer_rows),
        ])
        .areas(area);
        // The approval is asked over the box, so the status row does not ask it again.
        session.approval_elsewhere = approval_rows > 0;
        session.draw_body(buf, body);
        let empty_state = if !self.bound() {
            Some("Connecting to the conversation…")
        } else if self.unreadable {
            Some("Conversation unavailable. Reopen the thread to retry.")
        } else if self.owner.loading {
            Some("Loading conversation…")
        } else if self.owner.messages.is_empty() {
            Some("Start a message or open a thread from Threads.")
        } else {
            None
        };
        if let Some(text) = empty_state.filter(|_| body.height > 0) {
            let note = body.inner(ratatui::layout::Margin::new(1, 0));
            ratatui::widgets::Paragraph::new(text)
                .style(Style::new().fg(p.muted))
                .wrap(ratatui::widgets::Wrap { trim: true })
                .render(note, buf);
        }
        self.draw_delegations(buf, list, &delegations, cx.focused);
        // The face takes the first cells of the status row when the page has
        // one; the row's own text starts after them, in the row it already was.
        let status = {
            let row = status.intersection(buf.area);
            let face = self.directory.face();
            if face.wanted() && row.height == 1 && row.width >= FACE_MIN_ROW {
                face.report(
                    FaceCells {
                        x: row.x,
                        y: row.y,
                        w: FACE_COLUMNS,
                        h: 1,
                    },
                    cx.focused,
                );
                Rect::new(
                    status.x + FACE_COLUMNS,
                    status.y,
                    status.width - FACE_COLUMNS,
                    status.height,
                )
            } else {
                status
            }
        };
        // The composer's footer says why the box cannot send and what Enter
        // and Esc do, editing included; the row keeps what only it knows: a
        // waiting approval, the run's activity, the branch, a notice.
        if self.bound() && !self.unreadable && !self.owner.loading {
            session.hint_in_footer = true;
            session.draw_status(buf, status);
        }
        if referenced {
            session.draw_references(buf, references);
        }
        drop(session);
        self.draw_queue(buf, queued, &queue, cx.focused);
        self.draw_approval(buf, asking);
        self.draw_footer_row(buf, footer);
        // The prompt is the composer's, in the drawer's rounded box. The
        // caret is the root's overlay (`Panel::caret`), never a cell of this grid.
        let block = Block::new()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(if cx.focused { p.sage } else { p.line }));
        let inner = block.inner(prompt);
        block.render(prompt, buf);
        let inner = inner.inner(ratatui::layout::Margin::new(1, 0));
        self.composer_area.set(inner);
        let mut composer = self.composer.borrow_mut();
        composer.set_focused(cx.focused);
        composer.resize(inner);
        composer.draw(inner, buf, cx.theme);
    }

    /// Where the text caret is, for the root's hollow overlay. The root times
    /// the blink; this says only that it may.
    fn caret(&self, area: Rect) -> Option<Caret> {
        if self.kind == Kind::Side && !self.bound() {
            return None;
        }
        let at = self.composer.borrow().caret(now());
        let (x, y) = at.cell?;
        let phase = match at.phase {
            theorem_workbench_composer::CaretPhase::Steady => CaretPhase::Steady,
            theorem_workbench_composer::CaretPhase::Blinking => CaretPhase::Blinking,
            theorem_workbench_composer::CaretPhase::Hidden => return None,
        };
        (area.contains(Position::new(x, y))).then_some(Caret {
            x,
            y,
            shape: CaretShape::HollowBlock,
            phase,
        })
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
                        title: None,
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
        let mut log = Node::new("log", Role::Log, "Conversation", body)
            .with_text(&recent_transcript(&self.owner.messages));
        log.binding = resource.clone();
        log.state.busy = self.owner.working();
        // What the run is doing, first, so an agent reading the tree knows
        // whether to wait, steer or stop before it reads the transcript.
        log.state.description = Some(run_words(&self.owner));
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
            // A block's header row on screen, clamped to the body when it is scrolled off.
            let header = |line: usize| {
                session.rows.get(line).map_or(rect, |&row| {
                    Rect::new(body.x, edge(row, session.top), body.width, 1)
                })
            };
            let act = |id: String, title: &str| NodeAction {
                id: ActionId::new(id),
                enabled: true,
                reason: None,
                title: Some(title.to_owned()),
            };
            let blocks: Vec<_> = session
                .blocks
                .iter()
                .filter(|b| b.message == index)
                .collect();
            // Thinking and the summary of a folded turn: headers that open and close.
            for block in blocks
                .iter()
                .filter(|b| matches!(b.kind, BlockKind::Thinking | BlockKind::Summary))
            {
                let mut kid = Node::new(
                    &format!("b:{}", block.key),
                    Role::Button,
                    &block.name,
                    header(block.line),
                );
                kid.state.expanded = block.expanded;
                kid.state.selected = session.cursor.as_ref() == Some(&block.key);
                kid.state.description = block.holds.clone();
                kid.actions = vec![act(
                    format!("{ACTION_BLOCK}{}", block.key),
                    if block.expanded == Some(true) {
                        "Close"
                    } else {
                        "Open"
                    },
                )];
                kids.push(kid);
            }
            for part in &message.parts {
                let OwnerPart::Tool {
                    id,
                    name,
                    args,
                    status,
                    result,
                    approval_id,
                    approval_outcome,
                    approval_summary,
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
                // A call drawn as its own header (not folded into a summary) says where that
                // row is, whether it is open, and what opens it.
                let keys = [id.clone(), format!("diff:{id}"), format!("run:{id}")];
                let own = blocks.iter().find(|b| keys.contains(&b.key));
                // A call folded into its turn's summary has no row of its own: it sits on the
                // summary's row, the header that opens to it.
                if own.is_none()
                    && let Some(summary) = blocks.iter().find(|b| b.kind == BlockKind::Summary)
                {
                    tool.rect = Some(theorem_workbench_core::semantics::CellRect::of(header(
                        summary.line,
                    )));
                    tool.state.expanded = Some(false);
                }
                if let Some(block) = own {
                    let at = header(block.line);
                    tool.rect = Some(theorem_workbench_core::semantics::CellRect::of(at));
                    tool.state.expanded = block.expanded;
                    tool.state.selected = session.cursor.as_ref() == Some(&block.key);
                    if block.expanded.is_some() {
                        tool.role = Role::Button;
                        tool.actions = vec![act(
                            format!("{ACTION_BLOCK}{}", block.key),
                            if block.expanded == Some(true) {
                                "Close"
                            } else {
                                "Open"
                            },
                        )];
                    }
                    if block.open.is_some() {
                        tool.actions.push(act(
                            format!("{ACTION_BLOCK_OPEN}{}", block.key),
                            "Open the file in the editor",
                        ));
                    }
                    match (block.kind, block.counts) {
                        (BlockKind::Diff, Some((added, removed))) => {
                            tool.state.description = Some(format!(
                                "{}, {added} line{} added, {removed} removed",
                                block.name,
                                if added == 1 { "" } else { "s" }
                            ));
                        }
                        (BlockKind::Running, _) => {
                            tool.role = Role::Status;
                            tool.state.description = Some(block.name.clone());
                        }
                        _ => {}
                    }
                }
                // An answered approval: its receipt, on the row it is drawn on.
                if let (Some(approval), Some(outcome)) = (approval_id, approval_outcome)
                    && outcome != "awaiting"
                {
                    let asked = approval_summary
                        .clone()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| format!("{name} {args}"));
                    let answer = match outcome.as_str() {
                        "approved" => "Allowed",
                        "declined" => "Denied",
                        "failed" => "The answer failed",
                        _ => "Not answered",
                    };
                    let at = session
                        .receipts
                        .iter()
                        .find(|(_, of)| of == approval)
                        .map_or(rect, |&(line, _)| header(line));
                    let mut receipt = Node::new(
                        &format!("r:{approval}"),
                        Role::Status,
                        &format!("{answer}: {}", visible(asked.trim())),
                        at,
                    );
                    receipt.binding = resource.clone();
                    kids.push(receipt);
                }
                kids.push(tool);
            }
            node.children = kids.iter().map(|k| k.id.clone()).collect();
            log.children.push(node.id.clone());
            nodes.push(node);
            nodes.extend(kids);
        }
        children.push(log.id.clone());
        nodes.insert(0, log);

        // The delegations the conversation shows, one row each, with the
        // action that opens its changes panel.
        let delegations = if self.bound() && !self.unreadable {
            self.owner.delegations()
        } else {
            vec![]
        };
        if !delegations.is_empty() {
            let list = self.list_area.get();
            let first = self.list_first.get();
            let picked = self.picked.min(delegations.len() - 1);
            let mut group = Node::new(
                "delegations",
                Role::List,
                "Delegations",
                Rect::new(
                    list.x,
                    list.y.saturating_sub(1),
                    list.width,
                    list.height + 1,
                ),
            );
            group.binding = resource.clone();
            group.state.description =
                Some("Alt+D chooses a delegation, Enter opens its changes, Esc leaves.".to_owned());
            let count = delegations.len();
            for (index, row) in delegations.iter().enumerate() {
                let (who, state) = row.words();
                let drawn = index >= first && index - first < usize::from(list.height);
                let rect = if drawn && !list.is_empty() {
                    Rect::new(list.x, list.y + (index - first) as u16, list.width, 1)
                } else {
                    Rect::default()
                };
                let mut item = Node::new(
                    &format!("d:{}", row.delegation_id),
                    Role::ListItem,
                    &format!("{who}: {state}"),
                    rect,
                );
                item.binding = ResourceRef::Delegation {
                    run_id: row.run_id.to_owned(),
                    delegation_id: row.delegation_id.to_owned(),
                    path: String::new(),
                };
                item.pos_in_set = u16::try_from(index + 1).ok();
                item.set_size = u16::try_from(count).ok();
                item.state.selected = self.in_list && index == picked;
                item.state.focused = cx.focused && self.in_list && index == picked;
                let objective = visible(
                    &row.objective
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" "),
                );
                item.state.description = (!objective.is_empty()).then_some(objective);
                item.actions = vec![NodeAction {
                    id: ActionId::new(format!(
                        "{}{}",
                        theorem_workbench_core::panels::ACTION_DELEGATION_OPEN,
                        row.delegation_id
                    )),
                    enabled: true,
                    reason: None,
                    title: None,
                }];
                group.children.push(item.id.clone());
                nodes.push(item);
            }
            children.push(group.id.clone());
            nodes.push(group);
        }

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
                title: None,
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
        // How much of the agent's activity shows; the action takes the next level, and each
        // level can be asked for by name.
        let level = session.level;
        let mut activity = control(
            "activity",
            &format!("Activity: {}", level.word()),
            ACTION_ACTIVITY,
            true,
            "",
        );
        activity.actions[0].title = Some("Show the next activity level".to_owned());
        activity.state.description = Some(format!(
            "Shows {}; alt+v takes the next level",
            match level {
                Activity::All => "every thinking, tool call and diff open",
                Activity::Headers =>
                    "one header per thinking and tool call, a finished turn folded to its summary",
                Activity::Summary => "each turn's activity as its summary line",
            }
        ));
        activity.shortcut = Some("Alt+V".to_owned());
        activity
            .actions
            .extend(Activity::ALL.iter().map(|l| NodeAction {
                id: ActionId::new(format!("{ACTION_ACTIVITY_LEVEL}{}", l.word())),
                enabled: *l != level,
                reason: (*l == level).then(|| "This is the level shown".to_owned()),
                title: Some(format!("Show {}", l.word())),
            }));
        if let Some(area) = Some(session.level_area).filter(|a| a.width > 0) {
            activity.rect = Some(theorem_workbench_core::semantics::CellRect::of(area));
        }
        buttons.push(activity);
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
            // Where the region over the box drew it, when it did.
            let (region, allow_at, deny_at) = self.approval_cells.get();
            let at = |r: Rect| if r.is_empty() { bar_rect } else { r };
            let mut dialog = Node::new(
                "approval",
                Role::Alert,
                &format!(
                    "{} needs approval: {}",
                    approval.tool_name, approval.summary
                ),
                at(region),
            );
            let mut said = Vec::new();
            if !approval.risk.is_empty() && approval.risk != "unknown" {
                said.push(format!("{} risk", approval.risk));
            }
            if let Some(asked) = self.owner.asked(approval) {
                said.push(asked.to_owned());
            }
            dialog.state.description = (!said.is_empty()).then(|| said.join("\n"));
            let mut allow = control("approval:allow", "Allow", "approval.allow", open, why);
            allow.rect = Some(theorem_workbench_core::semantics::CellRect::of(at(
                allow_at,
            )));
            allow.shortcut = Some("Y".to_owned());
            let mut deny = control("approval:deny", "Deny", "approval.deny", open, why);
            deny.rect = Some(theorem_workbench_core::semantics::CellRect::of(at(deny_at)));
            deny.shortcut = Some("N".to_owned());
            dialog.children = vec![allow.id.clone(), deny.id.clone()];
            children.push(dialog.id.clone());
            nodes.push(dialog);
            nodes.push(allow);
            nodes.push(deny);
        } else {
            let _ = waiting;
        }
        // The composer's controls exist only where the host grants them.
        let granted = |word: &'static str| cx.capabilities().has(&Capability::new(word));
        if granted("conversation.attach") {
            buttons.push(control(
                "attach",
                "Attach files",
                "theo.attach",
                self.bound(),
                "Not connected to a conversation",
            ));
        }
        if granted("conversation.model") {
            buttons.push(control(
                "model",
                "Choose model",
                "theo.model",
                self.bound(),
                "Not connected to a conversation",
            ));
            if !self.efforts.is_empty() {
                buttons.push(control(
                    "effort",
                    "Set effort",
                    "theo.effort",
                    self.bound(),
                    "Not connected to a conversation",
                ));
            }
        }
        bar.children = buttons.iter().map(|b| b.id.clone()).collect();
        children.push(bar.id.clone());
        nodes.push(bar);
        nodes.append(&mut buttons);

        // The messages sent while the run works, in the order sent, each with what can be
        // done with it.
        let queue = if self.bound() && !self.unreadable {
            self.queue()
        } else {
            Vec::new()
        };
        if !queue.is_empty() {
            let cells = self.queue_cells.borrow();
            let first = self.queue_first.get();
            let whole = cells.iter().fold(Rect::default(), |u, (line, ..)| {
                if u.is_empty() { *line } else { u.union(*line) }
            });
            let mut list = Node::new("queue", Role::List, "Sent while the run works", whole);
            list.binding = resource.clone();
            list.state.description = Some(
                "Alt+Q chooses a message, Enter sends a failed one again, Delete removes it, Esc leaves."
                    .to_owned(),
            );
            let count = queue.len();
            for (index, row) in queue.iter().enumerate() {
                let (state, _) = row.words();
                let drawn = index.checked_sub(first).and_then(|at| cells.get(at));
                let mut item = Node::new(
                    &format!("q:{}", row.id),
                    Role::ListItem,
                    &format!("{}: {state}", visible(row.text.trim())),
                    drawn.map_or_else(Rect::default, |(line, ..)| *line),
                );
                item.pos_in_set = u16::try_from(index + 1).ok();
                item.set_size = u16::try_from(count).ok();
                item.state.selected = self.in_queue && index == self.queue_pick;
                item.state.focused = cx.focused && item.state.selected;
                if row.retries() {
                    item.actions.push(NodeAction {
                        id: ActionId::new(format!("{ACTION_QUEUE_RETRY}{}", row.id)),
                        enabled: true,
                        reason: None,
                        title: Some("Send it again".to_owned()),
                    });
                }
                item.actions.push(NodeAction {
                    id: ActionId::new(format!("{ACTION_QUEUE_REMOVE}{}", row.id)),
                    enabled: row.removes(),
                    reason: (!row.removes()).then(|| "The owner holds it for the run".to_owned()),
                    title: Some("Remove it".to_owned()),
                });
                list.children.push(item.id.clone());
                nodes.push(item);
            }
            children.push(list.id.clone());
            nodes.push(list);
        }

        // The footer under the box: what it shows, and the items that act.
        let footer = self.footer_cells.borrow();
        if !footer.is_empty() {
            let whole =
                footer.iter().fold(
                    Rect::default(),
                    |u, (_, r)| {
                        if u.is_empty() { *r } else { u.union(*r) }
                    },
                );
            let mut bar = Node::new("footer", Role::Toolbar, "Thread footer", whole);
            let words: BTreeMap<_, _> = self.footer_items().into_iter().collect();
            for (item, rect) in footer.iter() {
                let text = words.get(item).cloned().unwrap_or_default();
                let (id, role, name) = match item {
                    FooterItem::Project => {
                        ("footer:project", Role::Status, format!("Project: {text}"))
                    }
                    FooterItem::Branch => {
                        ("footer:branch", Role::Status, format!("Branch: {text}"))
                    }
                    FooterItem::Totals => {
                        let (added, removed) = self.repo.totals().unwrap_or_default();
                        (
                            "footer:totals",
                            Role::Status,
                            format!("{added} lines added, {removed} removed"),
                        )
                    }
                    FooterItem::Effort => {
                        ("footer:effort", Role::Button, format!("Effort: {text}"))
                    }
                    FooterItem::Model => ("footer:model", Role::Button, format!("Model: {text}")),
                    FooterItem::Stop => ("footer:stop", Role::Button, "Stop the run".to_owned()),
                };
                let mut node = Node::new(id, role, &name, *rect);
                let act = |action: &str, title: &str, enabled: bool, why: &str| NodeAction {
                    id: ActionId::new(action),
                    enabled,
                    reason: (!enabled).then(|| why.to_owned()),
                    title: Some(title.to_owned()),
                };
                match item {
                    FooterItem::Effort => {
                        node.shortcut = Some("Alt+T".to_owned());
                        node.actions = vec![act("theo.effort", "Take the next effort", true, "")];
                    }
                    FooterItem::Model => {
                        node.shortcut = Some("Alt+M".to_owned());
                        node.actions = vec![act("theo.model", "Choose the model", true, "")];
                    }
                    FooterItem::Stop => {
                        node.shortcut = Some("Esc".to_owned());
                        node.state.disabled = !working;
                        node.actions = vec![act(
                            "theo.stop",
                            "Stop the run",
                            working,
                            "No run is working",
                        )];
                    }
                    _ => {}
                }
                bar.children.push(node.id.clone());
                nodes.push(node);
            }
            children.push(bar.id.clone());
            nodes.push(bar);
        }
        drop(footer);

        // The composer: its own nodes (one text field, the chips, the popup,
        // the footer), joined here. The draft is the field's value and nowhere
        // else.
        let mut composer_nodes = self.composer.borrow().semantics(self.composer_area.get());
        if !composer_nodes.is_empty() {
            let field = composer_nodes.remove(0);
            children.push(field.id.clone());
            nodes.push(field);
            nodes.append(&mut composer_nodes);
        }

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
            "activity": session.level.word(),
            "draft": self.composer.borrow().serialize(),
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

    fn takes_chord(&self, key: &KeyInput) -> bool {
        TheoPanel::takes_chord(self, key)
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
                    format!(
                        "{} {}",
                        if chat.detached { "Reopen" } else { "Join" },
                        visible(&chat.conversation_id)
                    ),
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
    use theorem_workbench_core::{Actor, Composition, PanelFactories, PanelInstanceId, Theme};
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
        model_with(
            directory,
            &[
                "files",
                "conversation",
                "conversation.side",
                "conversation.attach",
                "conversation.model",
            ],
        )
    }

    fn model_with(directory: &Directory, caps: &[&'static str]) -> Model {
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
            Capabilities::of(caps.iter().copied()),
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

        fn typed_effects(&mut self, text: &str) -> Vec<Effect> {
            self.send(Msg::Text(text.to_owned()))
        }

        fn enter(&mut self) -> Vec<Effect> {
            self.send(Msg::Key(KeyInput::new(Key::Enter, Mods::NONE)))
        }

        fn key(&mut self, key: Key, mods: Mods) -> Vec<Effect> {
            self.send(Msg::Key(KeyInput::new(key, mods)))
        }

        /// Run one of the view's own actions, as the tree names it.
        fn act(&mut self, id: &str) -> Vec<Effect> {
            // The blocks are the ones on screen, so the frame is drawn first.
            let _ = self.drawn();
            self.send(Msg::Action {
                id: ActionId::new(id),
                actor: Actor::Human,
            })
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
                        | EffectKind::ConversationDismissInput
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

    fn face_json(r: &Rig, since: u64) -> Option<Value> {
        r.directory
            .face()
            .geometry_json(since)
            .map(|json| serde_json::from_str(&json).unwrap())
    }

    /// Draws a frame the way the mount does: the workbench, then `frame_end`.
    fn frame(r: &Rig) -> String {
        let text = r.drawn();
        r.directory.face().frame_end();
        text
    }

    #[test]
    fn the_face_reserves_the_first_cells_of_the_status_row_and_nothing_else_moves() {
        let mut r = rig();
        // A waiting approval gives the status row its text, and no spinner
        // that would turn between the two frames.
        r.show(
            1,
            "t1",
            json!({
                "run": {"state": "waiting_approval", "runId": "run-1"},
                "approval": {"runId": "run-1", "approvalId": "ap-1", "toolName": "shell", "summary": "list the build folder"}
            }),
        );
        let before = frame(&r);
        // Without a face the page has nothing to place: no cells, no epoch.
        assert!(face_json(&r, 0).is_none());

        r.directory.face().set_wanted(true);
        let with = frame(&r);
        let face = face_json(&r, 0).expect("the cells are published");
        let cells = &face["cells"];
        let body = main_body(&r);
        let (x, y, w, h) = (
            cells["x"].as_u64().unwrap() as u16,
            cells["y"].as_u64().unwrap() as u16,
            cells["w"].as_u64().unwrap() as u16,
            cells["h"].as_u64().unwrap() as u16,
        );
        assert_eq!((w, h), (FACE_COLUMNS, 1), "three cells wide, one row tall");
        assert!(
            x >= body.x && x + w <= body.right() && y >= body.y && y < body.bottom(),
            "{cells} is inside the panel {body:?}"
        );
        // Only that row differs, and only after the reserved cells: the text
        // that was at the row's start is now after them; every other row is
        // the same cells it was.
        let (old, new): (Vec<_>, Vec<_>) = (before.lines().collect(), with.lines().collect());
        assert_eq!(old.len(), new.len(), "no row was added or removed");
        for (row, (a, b)) in old.iter().zip(&new).enumerate() {
            if row as u16 != y {
                assert_eq!(a, b, "row {row} moved");
            }
        }
        let was: String = old[y as usize].chars().skip(x as usize).collect();
        let now: String = new[y as usize].chars().skip((x + w) as usize).collect();
        assert!(
            !was.trim().is_empty()
                && now.trim_start().starts_with(
                    was.trim_start()
                        .split_at(
                            was.trim_start()
                                .char_indices()
                                .nth(8)
                                .map_or(was.trim_start().len(), |(i, _)| i)
                        )
                        .0
                ),
            "the status text starts after the face: {was:?} then {now:?}"
        );
        let reserved: String = new[y as usize]
            .chars()
            .skip(x as usize)
            .take(w as usize)
            .collect();
        assert_eq!(
            reserved.trim(),
            "",
            "the panel draws nothing in the reserved cells"
        );
    }

    #[test]
    fn the_face_cells_change_epoch_when_the_panel_moves_and_go_when_it_is_not_drawn() {
        let mut r = rig();
        r.directory.face().set_wanted(true);
        frame(&r);
        let first = face_json(&r, 0).expect("published");
        assert_eq!(first["epoch"], 1);
        // The same frame again is not news.
        frame(&r);
        assert!(face_json(&r, 1).is_none());

        // The workbench is resized: the panel's status row moves.
        r.send(Msg::Resize {
            area: Rect::new(0, 0, 160, 40),
            metrics: CellMetrics::new(8.0, 16.0),
        });
        r.send(Msg::Tick);
        let smaller = Rect::new(0, 0, 160, 40);
        theorem_workbench_core::view(&r.m, smaller, &mut Buffer::empty(smaller), &Theme::plain());
        r.directory.face().frame_end();
        let moved = face_json(&r, 1).expect("a new epoch");
        assert_eq!(moved["epoch"], 2);
        assert_ne!(moved["cells"], first["cells"]);

        // A frame in which no Theo panel was drawn reports the face gone.
        r.directory.face().frame_end();
        let gone = face_json(&r, 2).expect("a new epoch");
        assert_eq!(gone["epoch"], 3);
        assert!(gone["cells"].is_null());

        // Drawn again, it is back with another epoch.
        frame(&r);
        assert_eq!(face_json(&r, 3).unwrap()["epoch"], 4);
    }

    #[test]
    fn a_page_that_withdraws_its_face_gets_the_row_back_whole() {
        let r = rig();
        let before = frame(&r);
        r.directory.face().set_wanted(true);
        frame(&r);
        r.directory.face().set_wanted(false);
        let after = frame(&r);
        assert_eq!(before, after);
        assert!(face_json(&r, 0).unwrap()["cells"].is_null());
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
        let draft = r.m.panel(&r.id()).unwrap().serialize()["draft"]["text"].clone();
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
        let draft = r.m.panel(&r.id()).unwrap().serialize()["draft"]["text"].clone();
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
        let draft = r.m.panel(&r.id()).unwrap().serialize()["draft"]["text"].clone();
        assert_eq!(draft, json!("rm -rf /\nsudo reboot\n"));
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
    fn takes_chord_answers_for_the_branch_chords_only_where_they_change_the_branch() {
        let option = |c: char| KeyInput::new(Key::Char(c), Mods::ALT);
        let mut r = rig();
        r.show(1, "t1", json!({"messages": [user("m1", "hi")]}));
        assert!(
            !r.m.takes_chord(&option('[')) && !r.m.takes_chord(&option(']')),
            "one branch: the character is typed"
        );
        r.show(
            2,
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
        assert!(r.m.takes_chord(&option('[')) && r.m.takes_chord(&option(']')));
        for c in ['q', 'e', 'n', '1', 'p'] {
            assert!(!r.m.takes_chord(&option(c)), "{c}");
        }
        assert!(!r.m.takes_chord(&KeyInput::new(Key::Char('['), Mods::NONE)));
    }

    #[test]
    fn takes_chord_leaves_the_branch_characters_to_type_while_a_run_is_working() {
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
                },
                "run": {"state": "streaming"}
            }),
        );
        assert!(!r.m.takes_chord(&KeyInput::new(Key::Char('['), Mods::ALT)));
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
        // The finished turn's activity is its summary line; the edit keeps its diff block.
        let drawn = r.drawn();
        assert!(drawn.contains("Read a file"), "{drawn}");
        assert!(!drawn.contains("read_file"), "{drawn}");
        r.act("theo.view.block.sum:m2:1");
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
        r.act("theo.view.block.sum:m2:0");
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
        r.act("theo.view.block.sum:m2:0");
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
        r.act("theo.view.block.sum:m2:0");
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
        assert_eq!(before["draft"]["text"], json!("half a thought"));
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
                    detached: false,
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
    fn a_closed_side_chat_is_reopened_on_its_own_thread_when_chosen() {
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
                    scope: theorem_workbench_core::effect::SideChatScope::Fresh,
                    from: None,
                    thread_id: Some("thread-side".into()),
                    detached: true,
                }],
            },
        ));
        r.send(Msg::Completion(done));
        assert!(r.drawn().contains("Reopen side-9"), "{}", r.drawn());
        let before = r.seen.len();
        for _ in 0..3 {
            r.key(Key::Down, Mods::NONE);
        }
        r.enter();
        let open = r.seen[before..]
            .iter()
            .find_map(|e| match &e.body {
                EffectBody::ConversationSideChat(open) => Some(open.clone()),
                _ => None,
            })
            .expect("choosing a closed side chat asks to reopen it");
        assert_eq!(open.reopen.as_deref(), Some("thread-side"));
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

    // ---- the coding actions, for an agent ----

    /// An agent run's action, as the wasm handle runs it.
    fn agent_act(
        r: &mut Rig,
        action: &str,
        panel: Option<&str>,
        args: Option<&str>,
    ) -> (theorem_workbench_core::agent::AgentOutcome, Vec<Effect>) {
        use theorem_workbench_core::agent::{agent_outcome, agent_request};
        let msg = agent_request(action, "run-a", panel, args).expect("a request");
        r.m.capture_notices();
        let fx = r.send(msg);
        let notices = r.m.take_captured();
        let acted = r.m.take_acted_panel();
        (agent_outcome(&notices, fx.len(), acted.as_ref()), fx)
    }

    fn the_agent() -> Actor {
        Actor::Agent {
            run_id: "run-a".into(),
        }
    }

    fn refusal(outcome: &theorem_workbench_core::agent::AgentOutcome) -> Option<String> {
        match outcome {
            theorem_workbench_core::agent::AgentOutcome::Refused { reason, .. } => {
                Some(reason.clone())
            }
            theorem_workbench_core::agent::AgentOutcome::Accepted { .. } => None,
        }
    }

    /// `code.start` for Theorem's own agent, and the owner's answer naming
    /// `side-1`: the side chat's panel id.
    fn started_side_chat(r: &mut Rig, task: &str) -> String {
        r.show(1, "t1", json!({"messages": [user("m1", "main talk")]}));
        let args = json!({ "input": task }).to_string();
        let (outcome, fx) = agent_act(r, "code.start", None, Some(&args));
        let theorem_workbench_core::agent::AgentOutcome::Accepted {
            panel: Some(panel), ..
        } = outcome
        else {
            panic!("{outcome:?}")
        };
        let open = fx
            .iter()
            .find(|e| matches!(e.body, EffectBody::ConversationSideChat(_)))
            .cloned()
            .expect("a side chat is asked for");
        let mut done = Completion::new(open.id, open.resource.clone(), Outcome::Accepted);
        done.payload = Some(CompletionPayload::ConversationSideOpened(
            theorem_workbench_core::completion::ConversationOpened {
                conversation_id: "side-1".into(),
            },
        ));
        r.send(Msg::Completion(done));
        panel
    }

    #[test]
    fn code_start_makes_a_fresh_side_chat_and_sends_the_task_first_for_the_agent() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        let (outcome, fx) = agent_act(
            &mut r,
            "code.start",
            None,
            Some(r#"{"input":"fix the flaky test"}"#),
        );
        let theorem_workbench_core::agent::AgentOutcome::Accepted {
            panel: Some(panel), ..
        } = &outcome
        else {
            panic!("{outcome:?}")
        };
        let kind = r
            .m
            .panel_ids()
            .find(|(id, _)| id.as_str() == panel)
            .map(|(_, k)| k.as_str().to_owned());
        assert_eq!(kind.as_deref(), Some("side-chat"));
        assert_eq!(fx.len(), 1, "{fx:?}");
        let EffectBody::ConversationSideChat(open) = &fx[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(open.scope, Some(SideChatScope::Fresh));
        assert_eq!(fx[0].actor, the_agent());
        // Nothing is said until the chat exists.
        assert!(fx.iter().all(|e| !matches!(
            e.kind(),
            EffectKind::ConversationSend | EffectKind::ConversationInput
        )));

        let mut done = Completion::new(fx[0].id, fx[0].resource.clone(), Outcome::Accepted);
        done.payload = Some(CompletionPayload::ConversationSideOpened(
            theorem_workbench_core::completion::ConversationOpened {
                conversation_id: "side-1".into(),
            },
        ));
        let fx = r.send(Msg::Completion(done));
        let sent = conversation_effects(&fx);
        assert_eq!(sent.len(), 1, "{fx:?}");
        let EffectBody::ConversationSend(send) = &sent[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(send.text, "fix the flaky test");
        assert_eq!(sent[0].actor, the_agent(), "the run that asked sends it");
        assert_eq!(
            sent[0].resource,
            ResourceRef::Conversation {
                project: PROJECT.into(),
                thread: "side-1".into()
            }
        );
        // And only once.
        r.send(Msg::Tick);
        assert_eq!(
            r.seen
                .iter()
                .filter(|e| matches!(e.body, EffectBody::ConversationSend(_)))
                .count(),
            1
        );
    }

    #[test]
    fn a_side_chat_the_owner_would_not_make_sends_no_task() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        let (_, fx) = agent_act(&mut r, "code.start", None, Some(r#"{"input":"x"}"#));
        let done = Completion::new(
            fx[0].id,
            fx[0].resource.clone(),
            Outcome::Failed {
                reason: "no side chats today".into(),
            },
        );
        let fx = r.send(Msg::Completion(done));
        assert!(conversation_effects(&fx).is_empty(), "{fx:?}");
    }

    #[test]
    fn code_send_steers_a_working_side_chat_and_leaves_the_persons_draft() {
        let mut r = rig();
        let side = started_side_chat(&mut r, "start");
        r.send(snapshot(
            5,
            "side-1",
            json!({"messages": [user("s1", "start")], "run": {"state": "streaming", "runId": "r-9"}}),
        ));
        // The person has begun a draft in the side chat.
        r.send(Msg::Action {
            id: ActionId::new(&format!("tab.focus.{side}")),
            actor: Actor::Human,
        });
        r.typed("half a thought");
        let before = r.m.panel(&PanelInstanceId::new(&side)).unwrap().serialize()["draft"].clone();
        let (outcome, fx) = agent_act(
            &mut r,
            "code.send",
            Some(&side),
            Some(r#"{"input":"also cover the docs"}"#),
        );
        assert_eq!(refusal(&outcome), None);
        let sent = conversation_effects(&fx);
        let EffectBody::ConversationInput(input) = &sent[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!((input.run_id.as_str(), input.text.as_str()), ("r-9", "also cover the docs"));
        assert_eq!(sent[0].actor, the_agent());
        let after = r.m.panel(&PanelInstanceId::new(&side)).unwrap().serialize()["draft"].clone();
        assert_eq!(before, after, "the draft is the person's");
        assert!(before.to_string().contains("half a thought"), "{before}");

        // Idle, the words are a new turn.
        r.send(snapshot(
            6,
            "side-1",
            json!({"messages": [user("s1", "start")], "run": {"state": "idle"}}),
        ));
        let (_, fx) = agent_act(&mut r, "code.send", Some(&side), Some(r#"{"input":"next"}"#));
        assert!(matches!(
            conversation_effects(&fx)[0].body,
            EffectBody::ConversationSend(_)
        ));
    }

    #[test]
    fn code_send_to_a_run_that_has_no_id_yet_waits_for_it_and_goes_as_the_agent() {
        // code.send right after code.start: the side chat's run is working
        // but the owner has not yet said which run it is.
        let mut r = rig();
        let side = started_side_chat(&mut r, "start");
        r.send(snapshot(
            5,
            "side-1",
            json!({"messages": [user("s1", "start")], "run": {"state": "streaming"}}),
        ));
        let (outcome, fx) = agent_act(
            &mut r,
            "code.send",
            Some(&side),
            Some(r#"{"input":"also cover the docs"}"#),
        );
        assert_eq!(refusal(&outcome), None);
        assert!(conversation_effects(&fx).is_empty(), "nothing to send to yet: {fx:?}");
        // The run's id arrives: the words go to it, for the agent that sent them.
        let fx = r.send(snapshot(
            6,
            "side-1",
            json!({"messages": [user("s1", "start")], "run": {"state": "streaming", "runId": "r-9"}}),
        ));
        let sent = conversation_effects(&fx);
        let EffectBody::ConversationInput(input) = &sent[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!((input.run_id.as_str(), input.text.as_str()), ("r-9", "also cover the docs"));
        assert_eq!(sent[0].actor, the_agent());
        // Sent once.
        let fx = r.send(snapshot(
            7,
            "side-1",
            json!({"messages": [user("s1", "start")], "run": {"state": "streaming", "runId": "r-9"}}),
        ));
        assert!(conversation_effects(&fx).is_empty(), "{fx:?}");
    }

    #[test]
    fn words_waiting_for_a_run_that_ends_unnamed_go_as_a_new_turn() {
        let mut r = rig();
        let side = started_side_chat(&mut r, "start");
        r.send(snapshot(5, "side-1", json!({"run": {"state": "streaming"}})));
        agent_act(&mut r, "code.send", Some(&side), Some(r#"{"input":"next"}"#));
        let fx = r.send(snapshot(6, "side-1", json!({"run": {"state": "idle"}})));
        let sent = conversation_effects(&fx);
        let EffectBody::ConversationSend(send) = &sent[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(send.text, "next");
        assert_eq!(sent[0].actor, the_agent());
    }

    #[test]
    fn code_stop_stops_a_working_side_chat_and_refuses_an_idle_one() {
        let mut r = rig();
        let side = started_side_chat(&mut r, "start");
        let (outcome, fx) = agent_act(&mut r, "code.stop", Some(&side), None);
        assert!(refusal(&outcome).is_some_and(|r| r.contains("No run is working")), "{outcome:?}");
        assert!(fx.is_empty());
        r.send(snapshot(
            5,
            "side-1",
            json!({"run": {"state": "streaming", "runId": "r-9"}}),
        ));
        let (outcome, fx) = agent_act(&mut r, "code.stop", Some(&side), None);
        assert_eq!(refusal(&outcome), None);
        let EffectBody::ConversationCancel(cancel) = &conversation_effects(&fx)[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(cancel.run_id.as_deref(), Some("r-9"));
        assert_eq!(fx[0].actor, the_agent());
    }

    #[test]
    fn code_send_to_a_side_chat_still_being_made_is_refused_with_why() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        let (outcome, _) = agent_act(&mut r, "code.start", None, Some(r#"{"input":"x"}"#));
        let theorem_workbench_core::agent::AgentOutcome::Accepted {
            panel: Some(side), ..
        } = outcome
        else {
            panic!("{outcome:?}")
        };
        let (outcome, fx) = agent_act(&mut r, "code.send", Some(&side), Some(r#"{"input":"y"}"#));
        assert!(
            refusal(&outcome).is_some_and(|r| r.contains("still being made")),
            "{outcome:?}"
        );
        assert!(fx.is_empty());
    }

    #[test]
    fn code_start_without_a_project_is_refused_and_leaves_no_empty_side_chat() {
        let mut r = rig();
        let (outcome, fx) = agent_act(&mut r, "code.start", None, Some(r#"{"input":"x"}"#));
        assert!(
            refusal(&outcome).is_some_and(|r| r.contains("project is not known")),
            "{outcome:?}"
        );
        assert!(fx.is_empty());
        assert!(!r.m.panel_ids().any(|(_, k)| k.as_str() == "side-chat"));
    }

    #[test]
    fn the_tree_carries_a_side_chats_recent_words_and_run_state_as_plain_text() {
        let mut r = rig();
        let side = started_side_chat(&mut r, "start");
        r.send(snapshot(
            5,
            "side-1",
            json!({
                "messages": [
                    user("s1", "fix it"),
                    assistant("s2", json!([
                        {"type": "text", "text": "on it\u{1b}[31m red\u{202e}"},
                        {"type": "tool", "id": "c1", "name": "run_command", "status": "running"}
                    ]), "running"),
                ],
                "run": {"state": "streaming", "runId": "r-9", "activity": "running tests"},
            }),
        ));
        let tree = r.tree();
        let log = tree
            .nodes
            .iter()
            .find(|n| {
                n.role == Role::Log
                    && n.binding
                        == ResourceRef::Conversation {
                            project: PROJECT.into(),
                            thread: "side-1".into(),
                        }
            })
            .unwrap_or_else(|| panic!("the side chat {side} has a transcript node"));
        let text = log.text.clone().unwrap_or_default();
        assert!(text.contains("You: fix it"), "{text}");
        assert!(text.contains("Theo: on it"), "{text}");
        assert!(text.contains("[run_command running]"), "{text}");
        assert!(
            !text.chars().any(|c| c == '\u{1b}' || c == '\u{202e}'),
            "control characters are spelled out: {text:?}"
        );
        assert_eq!(
            log.state.description.as_deref(),
            Some("Working: running tests.")
        );
    }

    #[test]
    fn the_transcript_text_keeps_the_newest_words_within_its_bound() {
        let many: Vec<OwnerMessage> = (0..40)
            .map(|i| OwnerMessage {
                id: format!("m{i}"),
                role: "user".into(),
                parts: vec![OwnerPart::Text {
                    text: format!("{i}: {}", "word ".repeat(400)),
                }],
                ..Default::default()
            })
            .collect();
        let text = recent_transcript(&many);
        assert!(text.len() <= RECENT_BYTES + '\u{2026}'.len_utf8());
        assert!(text.contains("39: word"), "the newest is kept");
        assert!(!text.contains("27: word"), "only the last few messages");
    }

    #[test]
    fn the_theo_panel_takes_a_conversation_message_while_a_shell_would_take_terminal_input() {
        let r = rig();
        let theo = r.m.panel(&r.id()).unwrap();
        // Its printable keys come to it as typed text for the composer.
        assert!(theo.text_entry());
    }

    // ---- the composer ----

    fn send_effect(fx: &[Effect]) -> &ConversationSend {
        match fx.iter().map(|e| &e.body).next() {
            Some(EffectBody::ConversationSend(send)) => send,
            other => panic!("expected a send, got {other:?}"),
        }
    }

    fn shift_enter(r: &mut Rig) -> Vec<Effect> {
        r.key(Key::Enter, Mods::SHIFT)
    }

    fn draft_json(r: &Rig) -> Value {
        r.m.panel(&r.id()).unwrap().serialize()["draft"].clone()
    }

    fn attachments_msg(thread: &str, list: Value) -> Msg {
        Msg::Host(HostMessage::ConversationAttachments {
            resource: ResourceRef::Conversation {
                project: PROJECT.into(),
                thread: thread.into(),
            },
            conversation_id: thread.into(),
            attachments: serde_json::from_value(list).unwrap(),
        })
    }

    /// A rig with the editor registered too, and `a.txt` open in it with
    /// `text`: the editor refers to the conversation panel for real.
    fn with_open_editor(text: &str) -> Rig {
        use theorem_workbench_core::completion::{DocumentOpened, FileEntry, FileListing};
        let directory = Directory::default();
        let mut factories = PanelFactories::new();
        register(&mut factories, &directory);
        theorem_workbench_panels::register(&mut factories);
        theorem_workbench_editor::register(&mut factories);
        let mut registry = builtin::registry();
        theorem_workbench_editor::extend_registry(&mut registry).expect("editor actions");
        let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
        assert!(issues.is_empty(), "{issues:?}");
        let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
        let mut m = Model::new(
            registry,
            factories,
            keys,
            Capabilities::of([
                "files",
                "documents",
                "conversation",
                "conversation.side",
                "conversation.attach",
                "conversation.model",
            ]),
            dock,
        );
        update(
            &mut m,
            Msg::Resize {
                area: Rect::new(0, 0, 160, 50),
                metrics: CellMetrics::new(8.0, 16.0),
            },
        );
        let ws = ResourceRef::Workspace {
            workspace: "w".into(),
        };
        update(
            &mut m,
            Msg::Host(HostMessage::WorkspaceChanged {
                workspace: "w".into(),
                environment: None,
            }),
        );
        let mut r = Rig {
            m,
            directory,
            seen: Vec::new(),
        };
        r.send(Msg::Action {
            id: ActionId::new("theo.focus"),
            actor: Actor::Human,
        });
        r.show(1, "t1", json!({}));
        r.send(Msg::Action {
            id: ActionId::new("files.focus"),
            actor: Actor::Human,
        });
        let fx = r.send(Msg::Tick);
        let list = fx
            .iter()
            .find(|e| e.kind() == EffectKind::FilesList)
            .expect("the Files panel lists")
            .id;
        let mut c = Completion::new(list, ws, Outcome::Accepted);
        c.payload = Some(CompletionPayload::Files(FileListing {
            entries: vec![FileEntry::new("a.txt", FileKind::File)],
            partial: false,
        }));
        r.send(Msg::Completion(c));
        for ch in "a.txt".chars() {
            r.key(Key::Char(ch), Mods::NONE);
        }
        r.enter();
        let fx = r.send(Msg::Tick);
        let open = fx
            .into_iter()
            .find(|e| e.kind() == EffectKind::DocumentOpen)
            .expect("the editor asks the owner for the document");
        let c = Completion::new(open.id, open.resource.clone(), Outcome::Accepted).with_payload(
            CompletionPayload::DocumentOpened(DocumentOpened {
                text: text.into(),
                revision: Revision::Seq(1),
                saved_revision: None,
                dirty: false,
                read_only: None,
                pending: vec![],
            }),
        );
        r.send(Msg::Completion(c));
        r
    }

    fn add_selection(r: &mut Rig) -> Vec<Effect> {
        r.key(Key::Char('q'), Mods::ALT)
    }

    #[test]
    fn a_reference_from_the_editor_lands_in_the_draft_and_the_pane_says_so_without_moving_focus() {
        let mut r = with_open_editor("hello\nworld\n");
        let focus = r.m.focus();
        let fx = add_selection(&mut r);
        assert!(fx.is_empty(), "no effect: {fx:?}");
        assert_eq!(r.m.focus(), focus, "the keyboard stayed in the editor");
        let draft = draft_json(&r);
        assert_eq!(draft["text"], json!("@a.txt:1 "), "{draft}");
        assert_eq!(draft["references"].as_array().map(Vec::len), Some(1));
        assert_eq!(draft["references"][0]["reference"]["path"], json!("a.txt"));
        let screen = r.drawn();
        assert!(screen.contains("added a.txt:1 to the message"), "{screen}");
        assert!(
            !screen.contains("not added"),
            "a placed reference is not a refusal: {screen}"
        );
    }

    #[test]
    fn a_selection_over_the_excerpt_limit_says_only_the_first_part_was_added() {
        let mut r = with_open_editor(&format!("{}\n", "x".repeat(EXCERPT_LIMIT + 10)));
        r.key(Key::Char('a'), Mods::CTRL);
        add_selection(&mut r);
        let screen = r.drawn();
        assert!(
            screen.contains(&format!(
                "added the first {EXCERPT_LIMIT} characters of a.txt"
            )),
            "{screen}"
        );
    }

    #[test]
    fn a_second_identical_reference_follows_the_composers_own_rule_for_the_persons_insertion() {
        // The composer takes the same reference twice, as it does when the
        // person picks the same file twice with `@`: two held tokens.
        let mut r = with_open_editor("hello\nworld\n");
        add_selection(&mut r);
        add_selection(&mut r);
        let draft = draft_json(&r);
        assert_eq!(draft["text"], json!("@a.txt:1 @a.txt:1 "), "{draft}");
        assert_eq!(draft["references"].as_array().map(Vec::len), Some(2));
        // The person's own insertion of the same token through the popup gives
        // the same draft, so the two paths agree.
        let mut composer = Composer::new("c");
        let reference = SourceReference {
            path: "a.txt".into(),
            range: None,
            label: None,
            excerpt: None,
            excerpt_cut: false,
        };
        composer.add_reference(reference.clone()).expect("first");
        composer.add_reference(reference).expect("second");
        assert_eq!(composer.serialize()["text"], json!("@a.txt @a.txt "));
    }

    #[test]
    fn a_reference_the_conversation_panel_cannot_take_is_shown_as_a_notice_not_dropped() {
        // A side chat that is not bound to a conversation refuses it and says so.
        let directory = Directory::default();
        let mut m = model(&directory);
        update(
            &mut m,
            Msg::Action {
                id: ActionId::new("theo.focus"),
                actor: Actor::Human,
            },
        );
        let mut panel = TheoPanel::new(Kind::Side, directory, &Value::Null);
        panel.refer(SourceReference {
            path: "a.txt".into(),
            range: None,
            label: Some("a.txt:1".into()),
            excerpt: Some("secret".into()),
            excerpt_cut: false,
        });
        assert!(panel.composer.borrow().is_empty(), "nothing was added");
        let said = panel
            .session
            .borrow()
            .notice
            .as_ref()
            .map(|(t, _)| t.clone());
        let said = said.expect("a notice");
        assert!(said.contains("not added"), "{said}");
        assert!(said.contains("a.txt:1"), "{said}");
        assert!(!said.contains("secret"), "the text is not repeated: {said}");
    }

    #[test]
    fn a_three_line_draft_sends_with_its_newlines_and_shift_enter_does_not_send() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("first");
        assert!(shift_enter(&mut r).is_empty(), "Shift+Enter is a newline");
        r.typed("second");
        assert!(shift_enter(&mut r).is_empty());
        r.typed("third");
        assert_eq!(draft_json(&r)["text"], json!("first\nsecond\nthird"));
        let fx = r.enter();
        assert_eq!(fx.len(), 1, "{fx:?}");
        assert_eq!(send_effect(&fx).text, "first\nsecond\nthird");
        assert_eq!(draft_json(&r)["text"], json!(""), "the draft left with it");
    }

    #[test]
    fn the_composer_grows_with_the_draft_and_keeps_the_prompt_glyph_and_box() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        let one = r.drawn();
        assert!(
            one.contains('\u{256D}') && one.contains('\u{276F}'),
            "{one}"
        );
        r.typed("a");
        shift_enter(&mut r);
        r.typed("b");
        shift_enter(&mut r);
        r.typed("c");
        let three = r.drawn();
        // The box runs from its top border to its bottom one.
        let height = |s: &str| {
            let top = s.lines().position(|l| l.contains('\u{256D}')).unwrap();
            let bottom = s.lines().position(|l| l.contains('\u{2570}')).unwrap();
            bottom - top
        };
        assert_eq!(height(&three), height(&one) + 2, "{three}");
        // All three lines are on show.
        assert!(three.contains("\u{276F} a"), "{three}");
        let has = |word: &str| {
            three
                .lines()
                .any(|l| l.split('\u{2502}').any(|p| p.trim() == word))
        };
        assert!(has("b") && has("c"), "{three}");
    }

    #[test]
    fn enter_during_a_composition_does_not_send_and_the_commit_arrives_once() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.send(Msg::Composition(Composition::Start));
        r.send(Msg::Composition(Composition::Update { text: "ni".into() }));
        let fx = r.enter();
        assert!(fx.is_empty(), "{fx:?}");
        r.send(Msg::Composition(Composition::End {
            text: "\u{4F60}".into(),
        }));
        r.typed("\u{4F60}");
        assert_eq!(draft_json(&r)["text"], json!("\u{4F60}"));
        let fx = r.enter();
        assert_eq!(send_effect(&fx).text, "\u{4F60}");
    }

    #[test]
    fn attachment_ids_and_references_go_out_on_the_send() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.send(attachments_msg(
            "t1",
            json!([
                {"id": "a1", "name": "notes.md", "contentType": "text/markdown", "state": "ready"},
                {"id": "a2", "name": "bad.exe", "state": "refused", "reason": "not allowed"}
            ]),
        ));
        r.typed("see @src/ma");
        // The popup asked the files owner by name.
        let ask = r
            .seen
            .iter()
            .rev()
            .find(|e| e.kind() == EffectKind::FilesSearch)
            .cloned()
            .expect("a name search went out");
        let EffectBody::FilesSearch(search) = &ask.body else {
            panic!()
        };
        assert_eq!(search.query, "src/ma");
        r.send(Msg::Completion(
            Completion::new(ask.id, ask.resource.clone(), Outcome::Accepted).with_payload(
                CompletionPayload::FileSearchPage(
                    theorem_workbench_core::completion::FileSearchPage {
                        rows: vec![theorem_workbench_core::completion::FileSearchRow {
                            path: "src/main.rs".into(),
                            name: "main.rs".into(),
                            kind: FileKind::File,
                            size: None,
                            modified: None,
                            ignored: None,
                            hidden: None,
                        }],
                        partial: false,
                        next: None,
                    },
                ),
            ),
        ));
        let fx = r.enter();
        assert!(fx.is_empty(), "Enter inserts the chosen file: {fx:?}");
        assert_eq!(draft_json(&r)["text"], json!("see @src/main.rs "));
        let fx = r.enter();
        let send = send_effect(&fx);
        assert_eq!(send.text, "see @src/main.rs");
        assert_eq!(
            send.attachments
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a1"],
            "only a ready attachment goes"
        );
        assert_eq!(send.references.len(), 1);
        assert_eq!(send.references[0].path, "src/main.rs");
    }

    #[test]
    fn a_working_run_takes_steering_and_the_policy_says_so() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({"run": {"state": "streaming", "runId": "run-1"}}),
        );
        r.typed("also check the tests");
        assert!(r.drawn().contains("steers"), "{}", r.drawn());
        let fx = r.enter();
        assert_eq!(fx[0].kind(), EffectKind::ConversationInput);
        // Files cannot ride along on input: the draft stays and says why.
        r.typed("x @a");
        r.send(attachments_msg(
            "t1",
            json!([{"id": "a1", "name": "n.md", "state": "ready"}]),
        ));
        r.show(
            2,
            "t1",
            json!({"run": {"state": "streaming", "runId": "run-1"}}),
        );
        let fx = r.enter();
        assert!(fx.is_empty(), "{fx:?}");
        assert!(!draft_json(&r)["text"].as_str().unwrap().is_empty());
    }

    #[test]
    fn an_edit_sends_as_an_edit_and_esc_leaves_it() {
        let mut r = rig();
        r.show(1, "t1", json!({"messages": [user("m1", "first draft")]}));
        r.send(Msg::Action {
            id: ActionId::new("theo.edit"),
            actor: Actor::Human,
        });
        assert_eq!(draft_json(&r)["text"], json!("first draft"));
        r.typed("!");
        let fx = r.enter();
        let EffectBody::ConversationEdit(edit) = &fx[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(
            (edit.message_id.as_str(), edit.text.as_str()),
            ("m1", "first draft!")
        );
        // Esc on an edit leaves it without sending.
        r.send(Msg::Action {
            id: ActionId::new("theo.edit"),
            actor: Actor::Human,
        });
        r.typed("changed");
        let before = r.seen.len();
        r.key(Key::Esc, Mods::NONE);
        assert_eq!(draft_json(&r)["text"], json!(""));
        assert!(conversation_effects(&r.seen[before..]).is_empty());
    }

    #[test]
    fn a_refused_multiline_send_with_files_comes_back_whole() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.send(attachments_msg(
            "t1",
            json!([{"id": "a1", "name": "n.md", "state": "ready"}]),
        ));
        r.typed("one");
        shift_enter(&mut r);
        r.typed("two");
        let fx = r.enter();
        r.send(Msg::Completion(Completion::new(
            fx[0].id,
            fx[0].resource.clone(),
            Outcome::Refused {
                code: "unavailable".into(),
                reason: "no".into(),
            },
        )));
        let draft = draft_json(&r);
        assert_eq!(draft["text"], json!("one\ntwo"));
        // The attachment is back in the draft, so a second Enter sends it again.
        let fx = r.enter();
        let send = send_effect(&fx);
        assert_eq!(send.attachments.len(), 1, "{send:?}");
    }

    /// The status row above the box and the footer inside it, as drawn in the
    /// main panel's columns.
    fn rows_of(r: &Rig) -> (String, String) {
        let body = main_body(r);
        let text = r.drawn();
        let lines: Vec<String> = text
            .lines()
            .map(|l| {
                l.chars()
                    .skip(body.x as usize)
                    .take(body.width as usize)
                    .collect::<String>()
                    .trim()
                    .to_owned()
            })
            .collect();
        let top = lines
            .iter()
            .position(|l| l.starts_with('\u{256D}'))
            .expect("the box's top border");
        let bottom = lines
            .iter()
            .position(|l| l.starts_with('\u{2570}'))
            .expect("the box's bottom border");
        (
            lines[top - 1].clone(),
            lines[bottom - 1]
                .trim_matches(|c: char| c == '\u{2502}' || c.is_whitespace())
                .to_owned(),
        )
    }

    #[test]
    fn the_status_row_and_the_footer_never_say_the_same_thing() {
        // Idle: the row names only the activity level, and the footer has the hint.
        let mut r = rig();
        r.show(1, "t1", json!({"messages": [user("m1", "hi")]}));
        let (status, footer) = rows_of(&r);
        eprintln!("idle: {status:?} | {footer:?}");
        assert_eq!(status, "activity: headers");
        assert!(footer.starts_with("Enter sends"), "{footer}");

        // Working: the row has the activity, the footer has the hint.
        r.show(
            2,
            "t1",
            json!({
                "messages": [user("m1", "hi")],
                "run": {"state": "streaming", "runId": "run-7"},
            }),
        );
        let (status, footer) = rows_of(&r);
        eprintln!("working: {status:?} | {footer:?}");
        assert!(status.contains("working"), "{status}");
        assert!(
            !status.contains("enter sends") && !status.contains("ctrl+c"),
            "{status}"
        );
        assert!(
            footer.starts_with("Enter steers the run, Esc stops"),
            "{footer}"
        );

        // Waiting for approval: the row has the approval and its keys.
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({
                "run": {"state": "waiting_approval", "runId": "run-1"},
                "approval": {"runId": "run-1", "approvalId": "ap-1", "toolName": "shell", "summary": "ls"}
            }),
        );
        // The approval is asked once, in the region pinned over the box, with its keys on
        // its buttons; the status row keeps the activity and does not ask it again.
        let (asked, footer) = rows_of(&r);
        eprintln!("approval: {asked:?} | {footer:?}");
        assert!(asked.contains("[ Allow  y ]  [ Deny  n ]"), "{asked}");
        let drawn = r.drawn();
        assert_eq!(
            drawn.matches("shell needs your approval").count(),
            1,
            "{drawn}"
        );
        let status = drawn
            .lines()
            .find(|l| l.contains("activity: headers"))
            .expect("the status row");
        assert!(
            !status.contains("allow") && !status.contains("? shell"),
            "{status}"
        );
        assert!(!footer.contains("allow"), "{footer}");

        // Blocked: the reason is the footer's alone.
        for (r, reason) in [
            (rig(), "connecting to the conversation"),
            (
                {
                    let mut r = rig();
                    r.show(1, "t1", json!({"loading": true}));
                    r
                },
                "loading the conversation",
            ),
        ] {
            let (status, footer) = rows_of(&r);
            eprintln!("blocked: {status:?} | {footer:?}");
            assert_eq!(status, "", "the row does not repeat the reason");
            assert_eq!(footer, reason);
            assert_eq!(r.drawn().matches(reason).count(), 1, "said once");
        }

        // Editing: the footer says it; the row does not.
        let mut r = rig();
        r.show(1, "t1", json!({"messages": [user("m1", "hi")]}));
        r.key(Key::Up, Mods::NONE);
        let (status, footer) = rows_of(&r);
        eprintln!("editing: {status:?} | {footer:?}");
        assert_eq!(status, "activity: headers");
        assert!(
            footer.starts_with("Enter sends the edit, Esc cancels"),
            "{footer}"
        );
    }

    #[test]
    fn approval_keys_answer_only_while_nothing_is_typed() {
        let approval = json!({
            "run": {"state": "waiting_approval", "runId": "run-1"},
            "approval": {"runId": "run-1", "approvalId": "ap-1", "toolName": "shell", "summary": "ls"}
        });
        // Nothing typed: y answers, as a key and as text.
        let mut r = rig();
        r.show(1, "t1", approval.clone());
        let fx = r.key(Key::Char('y'), Mods::NONE);
        assert_eq!(fx[0].kind(), EffectKind::ConversationApproval);
        assert_eq!(draft_json(&r)["text"], json!(""), "never taken as text");
        let mut r = rig();
        r.show(1, "t1", approval.clone());
        let fx = r.typed_effects("n");
        assert_eq!(fx[0].kind(), EffectKind::ConversationApproval);
        assert_eq!(draft_json(&r)["text"], json!(""));
        // Typing: the same letters are text.
        let mut r = rig();
        r.show(1, "t1", approval.clone());
        r.typed("ok");
        let fx = r.key(Key::Char('y'), Mods::NONE);
        assert!(fx.is_empty(), "{fx:?}");
        let fx = r.typed_effects("n");
        assert!(fx.is_empty(), "{fx:?}");
        assert_eq!(draft_json(&r)["text"], json!("okyn"));
        // Other letters with nothing typed are text too.
        let mut r = rig();
        r.show(1, "t1", approval);
        r.key(Key::Char('x'), Mods::NONE);
        assert_eq!(draft_json(&r)["text"], json!("x"));
        // No approval waiting: y is text.
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.key(Key::Char('y'), Mods::NONE);
        assert_eq!(draft_json(&r)["text"], json!("y"));
    }

    #[test]
    fn up_and_down_walk_the_prompts_sent_in_this_session() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("one");
        r.enter();
        r.typed("two");
        r.enter();
        r.key(Key::Up, Mods::NONE);
        assert_eq!(draft_json(&r)["text"], json!("two"));
        r.key(Key::Up, Mods::NONE);
        assert_eq!(draft_json(&r)["text"], json!("one"));
        r.key(Key::Down, Mods::NONE);
        r.key(Key::Down, Mods::NONE);
        assert_eq!(draft_json(&r)["text"], json!(""));
    }

    #[test]
    fn the_draft_selection_and_undo_survive_a_theme_change_and_a_layout_move() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("alpha beta");
        r.key(Key::Char('a'), Mods::CMD);
        let before = draft_json(&r);
        assert_eq!(
            (before["anchor"].as_u64(), before["caret"].as_u64()),
            (Some(0), Some(10))
        );
        // A new theme, a resize, a move of the panel to another group: the panel
        // is not rebuilt for any of them.
        let mut other = Theme::plain();
        other.text = Style::new().fg(ratatui::style::Color::Red);
        let area = Rect::new(0, 0, 160, 50);
        let mut buf = Buffer::empty(area);
        theorem_workbench_core::view(&r.m, area, &mut buf, &other);
        r.send(Msg::Resize {
            area: Rect::new(0, 0, 120, 40),
            metrics: CellMetrics::new(8.0, 16.0),
        });
        let panel = r.id();
        let to =
            r.m.frame()
                .unwrap()
                .groups
                .iter()
                .filter(|g| g.role != theorem_workbench_dock::Role::Main)
                .map(|g| g.id)
                .next()
                .expect("another group");
        r.send(Msg::Dock(theorem_workbench_core::msg::DockMsg::MoveTab {
            panel: panel.clone(),
            to,
            index: None,
        }));
        assert_eq!(r.id(), panel, "the same panel instance");
        assert_eq!(draft_json(&r), before, "the draft and its selection");
        // Undo history is still there: typing over the selection, then undo.
        r.typed("Z");
        assert_eq!(draft_json(&r)["text"], json!("Z"));
        r.key(Key::Char('z'), Mods::CMD);
        assert_eq!(draft_json(&r)["text"], json!("alpha beta"));
    }

    #[test]
    fn a_saved_draft_comes_back_with_its_caret_and_the_old_plain_string_still_restores() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("one");
        shift_enter(&mut r);
        r.typed("two");
        r.key(Key::Left, Mods::NONE);
        let saved = r.m.document();
        let before = draft_json(&r);
        let directory = Directory::default();
        let mut again = model(&directory);
        again.restore(saved).expect("restores");
        let id = again
            .panel_ids()
            .find(|(_, k)| k.as_str() == "theo")
            .map(|(id, _)| id.clone())
            .unwrap();
        assert_eq!(again.panel(&id).unwrap().serialize()["draft"], before);
        let old = TheoPanel::new(
            Kind::Main,
            Directory::default(),
            &json!({"draft": "an old draft", "conversation": "t1", "project": "p1"}),
        );
        assert_eq!(old.serialize()["draft"]["text"], json!("an old draft"));
    }

    /// A turn that is still working: thinking, a finished search, a running command with
    /// output, and a file edit streaming.
    fn working_turn() -> Value {
        json!({
            "nowMs": 13_000.0,
            "run": {"state": "streaming", "runId": "r1"},
            "messages": [
                user("m1", "tidy the merge"),
                assistant("m2", json!([
                    {"type": "reasoning", "text": "the merge keeps the older entry", "startedAtMs": 0.0, "endedAtMs": 4_000.0},
                    {"type": "tool", "id": "c1", "name": "grep", "args": "merge_state", "status": "complete",
                     "result": "src/merge.rs:41", "startedAtMs": 4_000.0, "endedAtMs": 5_000.0},
                    {"type": "tool", "id": "c2", "name": "run_command", "args": "cargo test", "status": "running",
                     "result": "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8", "startedAtMs": 1_000.0},
                    {"type": "tool", "id": "c3", "name": "edit_file", "args": "src/merge.rs", "status": "running",
                     "open": {"path": "src/merge.rs", "start": 40},
                     "diff": [{"k": "del", "t": [{"t": "    out.insert(key, entry);"}]},
                              {"k": "add", "t": [{"t": "    if newer { out.insert(key, entry); }"}]}]},
                ]), "running"),
            ],
        })
    }

    #[test]
    fn thinking_is_one_header_line_that_opens_by_enter_and_by_click() {
        let mut r = rig();
        r.show(1, "t1", working_turn());
        let drawn = r.drawn();
        let header = drawn
            .lines()
            .position(|l| l.contains("Thinking") && l.contains("4s"))
            .unwrap_or_else(|| panic!("one header with its duration: {drawn}"));
        assert!(
            !drawn.contains("older entry"),
            "closed at the headers level"
        );
        let node = r.node("Thinking, 4s").expect("a node for the header");
        assert_eq!(node.role, Role::Button);
        assert_eq!(node.state.expanded, Some(false));
        // Alt+Up gives the keys to the blocks; Up walks to the thinking; Enter opens it.
        r.key(Key::Up, Mods::ALT);
        for _ in 0..4 {
            r.key(Key::Up, Mods::NONE);
        }
        r.enter();
        assert!(r.drawn().contains("older entry"), "{}", r.drawn());
        assert!(
            conversation_effects(&r.seen).is_empty(),
            "Enter sent nothing"
        );
        r.key(Key::Esc, Mods::NONE);
        // A click on the header closes it again.
        let origin = main_body(&r);
        r.send(Msg::Pointer(theorem_workbench_core::Pointer {
            kind: PointerKind::Down(theorem_workbench_core::Button::Left),
            x: origin.x + 4,
            y: header as u16,
            mods: Mods::NONE,
            clicks: 1,
        }));
        assert!(!r.drawn().contains("older entry"), "{}", r.drawn());
        assert_eq!(r.node("Thinking, 4s").unwrap().state.expanded, Some(false));
    }

    #[test]
    fn a_running_command_is_an_outlined_block_with_its_tail_and_how_long_it_has_run() {
        let mut r = rig();
        r.show(1, "t1", working_turn());
        let drawn = r.drawn();
        assert!(drawn.contains("run_command"), "{drawn}");
        assert!(
            drawn.contains("12s"),
            "elapsed from the snapshot's own clock: {drawn}"
        );
        assert!(
            drawn.contains("line 8") && drawn.contains("line 3"),
            "{drawn}"
        );
        assert!(!drawn.contains("line 2"), "only the tail: {drawn}");
        assert!(
            drawn.contains('\u{256D}') && drawn.contains('\u{2570}'),
            "outlined"
        );
        // A later snapshot moves the time on.
        let mut later = working_turn();
        later["nowMs"] = json!(75_000.0);
        r.show(2, "t1", later);
        assert!(r.drawn().contains("1m 14s"), "{}", r.drawn());
        // Once it ends, it folds to a header row like any finished call.
        let mut done = working_turn();
        done["messages"][1]["parts"][2]["status"] = json!("complete");
        done["messages"][1]["parts"][2]["endedAtMs"] = json!(20_000.0);
        r.show(3, "t1", done);
        let drawn = r.drawn();
        assert!(!drawn.contains("line 8"), "{drawn}");
        let row = drawn.lines().find(|l| l.contains("run_command")).unwrap();
        assert!(row.contains('\u{2713}') && row.contains("19s"), "{row}");
    }

    #[test]
    fn code_the_agent_writes_is_a_diff_block_that_closes_and_opens_its_file() {
        let mut r = rig();
        r.send(Msg::Host(HostMessage::WorkspaceChanged {
            workspace: "w".into(),
            environment: None,
        }));
        r.show(1, "t1", working_turn());
        let drawn = r.drawn();
        let row = drawn.lines().find(|l| l.contains("edit_file")).unwrap();
        assert!(
            row.contains("src/merge.rs") && row.contains("+1") && row.contains("\u{2212}1"),
            "{row}"
        );
        assert!(drawn.contains("if newer"), "open while it streams: {drawn}");
        let node = r.node("Tool edit_file: running").expect("the diff's node");
        assert_eq!(node.state.expanded, Some(true));
        assert!(
            node.state
                .description
                .as_deref()
                .is_some_and(|d| d.contains("src/merge.rs, 1 line added, 1 removed")),
            "{:?}",
            node.state.description
        );
        r.act("theo.view.block.diff:c3");
        assert!(!r.drawn().contains("if newer"), "{}", r.drawn());
        r.act("theo.view.block.diff:c3");
        assert!(r.drawn().contains("if newer"));
        let fx = r.act("theo.view.open.diff:c3");
        assert!(conversation_effects(&fx).is_empty());
        assert!(
            r.m.panel_ids().any(|(_, k)| k.as_str() == "document"),
            "the editor open went to the core"
        );
    }

    #[test]
    fn typed_o_and_space_belong_to_the_blocks_while_the_keys_walk_them() {
        let mut r = rig();
        r.send(Msg::Host(HostMessage::WorkspaceChanged {
            workspace: "w".into(),
            environment: None,
        }));
        r.show(1, "t1", working_turn());
        r.drawn();
        let selected = |r: &Rig| r.node("Tool edit_file: running").unwrap().state.selected;
        // Any other typing gives the keys back and is typed into the composer.
        r.key(Key::Up, Mods::ALT);
        assert!(selected(&r), "Alt+Up lands on the last block, the diff");
        r.send(Msg::Text("x".into()));
        assert!(!selected(&r));
        r.key(Key::Backspace, Mods::NONE);
        let placeholder = r.drawn().contains("Message Theo");
        assert!(placeholder, "the composer is empty again: {}", r.drawn());
        // The browser sends a bare key as text: space closes the diff, o opens its file.
        r.key(Key::Up, Mods::ALT);
        r.send(Msg::Text(" ".into()));
        assert!(!r.drawn().contains("if newer"), "space closed it");
        r.send(Msg::Text("o".into()));
        assert!(
            r.m.panel_ids().any(|(_, k)| k.as_str() == "document"),
            "o opened the file"
        );
        assert_eq!(
            r.drawn().contains("Message Theo"),
            placeholder,
            "nothing was typed into the composer"
        );
    }

    #[test]
    fn a_finished_turn_folds_to_one_summary_that_opens_to_its_headers() {
        let mut r = rig();
        let mut done = working_turn();
        done["run"] = json!({"state": "idle"});
        done["messages"][1]["status"] = json!("complete");
        done["messages"][1]["parts"][2]["status"] = json!("complete");
        done["messages"][1]["parts"][3]["status"] = json!("complete");
        done["messages"][1]["parts"].as_array_mut().unwrap().insert(
            1,
            json!({"type": "reasoning", "text": "and a second thought"}),
        );
        r.show(1, "t1", done);
        let drawn = r.drawn();
        assert!(
            drawn.contains("Thought twice, ran a command, searched once"),
            "{drawn}"
        );
        assert!(!drawn.contains("grep"), "{drawn}");
        // The edit keeps its own header, open, at this level.
        assert!(drawn.contains("edit_file"), "{drawn}");
        let summary = r
            .tree()
            .nodes
            .into_iter()
            .find(|n| n.id.as_str().ends_with("b:sum:m2:0"))
            .expect("the summary's node");
        assert_eq!(summary.role, Role::Button);
        assert_eq!(summary.state.expanded, Some(false));
        r.act("theo.view.block.sum:m2:0");
        let drawn = r.drawn();
        assert!(
            drawn.contains("grep") && drawn.contains("run_command"),
            "{drawn}"
        );
        assert_eq!(drawn.matches("Thinking").count(), 2, "{drawn}");
    }

    #[test]
    fn a_block_opened_while_the_transcript_follows_its_end_stays_where_it_was() {
        let mut r = rig();
        let mut done = working_turn();
        done["run"] = json!({"state": "idle"});
        done["messages"][1]["status"] = json!("complete");
        done["messages"][1]["parts"][2]["status"] = json!("complete");
        done["messages"][1]["parts"][3]["status"] = json!("complete");
        r.show(1, "t1", done.clone());
        r.drawn();
        // A reply below it just long enough that the transcript scrolls, following its end,
        // with the summary still on screen.
        let row = |r: &Rig| {
            r.node("Thought once, ran a command, searched once")
                .and_then(|n| n.rect)
        };
        let mut before = None;
        for n in 1..main_body(&r).height as usize {
            let lines: Vec<String> = (0..n).map(|i| format!("line {i}")).collect();
            let mut long = done.clone();
            let messages = long["messages"].as_array_mut().unwrap();
            messages.push(user("m3", "and then"));
            messages.push(assistant(
                "m4",
                json!([{"type": "text", "text": lines.join("\n\n")}]),
                "complete",
            ));
            r.show(n as u64 + 1, "t1", long);
            let drawn = r.drawn();
            if !drawn.contains("tidy the merge") {
                before = row(&r).filter(|_| drawn.contains("Thought once"));
                break;
            }
        }
        let before = before.expect("the transcript scrolled with the summary on screen");
        r.act("theo.view.block.sum:m2:0");
        r.drawn();
        assert_eq!(row(&r), Some(before), "the header stayed under the pointer");
        assert!(r.drawn().contains("grep"), "it opened below its header");
    }

    #[test]
    fn fenced_code_in_an_answer_is_drawn_without_its_fences() {
        let mut r = rig();
        let reply = assistant(
            "m2",
            json!([{"type": "text", "text": "Run this:\n\n```sh\ncargo test --workspace\n```\n\nThen look."}]),
            "complete",
        );
        r.show(1, "t1", json!({"messages": [user("m1", "x"), reply]}));
        let drawn = r.drawn();
        assert!(drawn.contains("cargo test --workspace"), "{drawn}");
        assert!(drawn.contains("Then look."), "{drawn}");
        assert!(!drawn.contains("```"), "{drawn}");
    }

    #[test]
    fn the_three_activity_levels_change_the_drawing_and_survive_a_reload() {
        let mut r = rig();
        r.show(1, "t1", working_turn());
        // Headers (the default): one header each while the turn works.
        assert!(r.drawn().contains("grep") && !r.drawn().contains("older entry"));
        // Alt+V: summary only, even for the working turn.
        r.key(Key::Char('v'), Mods::ALT);
        let drawn = r.drawn();
        assert!(drawn.contains("activity: summary"), "{drawn}");
        assert!(
            !drawn.contains("grep") && !drawn.contains("Thinking"),
            "{drawn}"
        );
        assert!(
            drawn.contains("edit_file") && !drawn.contains("if newer"),
            "the diff is its header: {drawn}"
        );
        // Again: everything open.
        r.key(Key::Char('v'), Mods::ALT);
        let drawn = r.drawn();
        assert!(drawn.contains("activity: everything"), "{drawn}");
        assert!(
            drawn.contains("older entry") && drawn.contains("src/merge.rs:41"),
            "{drawn}"
        );
        // The level is kept with the layout and comes back with it.
        let saved = r.m.document();
        let directory = Directory::default();
        let mut again = model(&directory);
        again.restore(saved).expect("restores");
        let id = again
            .panel_ids()
            .find(|(_, k)| k.as_str() == "theo")
            .map(|(id, _)| id.clone())
            .unwrap();
        assert_eq!(
            again.panel(&id).unwrap().serialize()["activity"],
            json!("everything")
        );
        // By name, as the activity control's actions offer.
        r.act("theo.view.activity.headers");
        assert!(r.drawn().contains("activity: headers"));
        let control = r.node("Activity: headers").expect("the activity control");
        assert_eq!(control.role, Role::Button);
        assert!(
            control
                .actions
                .iter()
                .any(|a| a.id.as_str() == "theo.view.activity.summary")
        );
    }

    #[test]
    fn the_caret_is_reported_for_the_root_and_never_drawn_as_a_character() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("hi");
        let drawn = r.drawn();
        let caret = r.m.caret().expect("the composer owns the caret");
        assert_eq!(caret.shape, CaretShape::HollowBlock);
        let line = drawn.lines().nth(usize::from(caret.y)).unwrap();
        assert!(line.contains("hi"), "{line}");
        // Two cells after the prompt glyph and the draft: nothing stands in the
        // caret's cell but the grid's own blank.
        let cell: String = line.chars().skip(usize::from(caret.x)).take(1).collect();
        assert!(cell.trim().is_empty(), "{cell:?} in {line:?}");
        // Another panel owning the keyboard hides it.
        r.send(Msg::Focus(false));
        assert!(r.m.caret().is_none());
    }

    #[test]
    fn attach_model_and_effort_are_offered_only_where_the_host_grants_them() {
        let granted = rig();
        assert!(granted.node("Attach files").is_some());
        assert!(granted.node("Choose model").is_some());
        let directory = Directory::default();
        let mut m = model_with(&directory, &["files", "conversation"]);
        update(
            &mut m,
            Msg::Action {
                id: ActionId::new("theo.focus"),
                actor: Actor::Human,
            },
        );
        let tree = semantics(&m);
        assert!(!tree.nodes.iter().any(|n| n.name == "Attach files"));
        assert!(!tree.nodes.iter().any(|n| n.name == "Choose model"));
    }

    #[test]
    fn attach_model_and_effort_leave_as_the_owners_effects() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        let fx = r.send(Msg::Action {
            id: ActionId::new("theo.attach"),
            actor: Actor::Human,
        });
        assert!(
            fx.iter()
                .any(|e| e.kind() == EffectKind::ConversationAttachPick),
            "{fx:?}"
        );
        // The models arrive; the footer names the selected one and its effort.
        r.send(Msg::Host(HostMessage::ConversationModels {
            resource: ResourceRef::Conversation {
                project: PROJECT.into(),
                thread: "t1".into(),
            },
            conversation_id: "t1".into(),
            models: vec![
                serde_json::from_value(json!({"ref": "m-a", "label": "Alpha"})).unwrap(),
                serde_json::from_value(json!({"ref": "m-b", "label": "Beta"})).unwrap(),
            ],
            selected: Some("m-a".into()),
            effort: Some("low".into()),
            efforts: vec!["low".into(), "high".into()],
        }));
        assert!(r.drawn().contains("Alpha"), "{}", r.drawn());
        let fx = r.send(Msg::Action {
            id: ActionId::new("theo.effort"),
            actor: Actor::Human,
        });
        let EffectBody::ConversationSetEffort(e) = &fx[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(e.level, "high");
        // theo.model opens the list in the composer; choosing sends the ref.
        r.send(Msg::Action {
            id: ActionId::new("theo.model"),
            actor: Actor::Human,
        });
        r.key(Key::Down, Mods::NONE);
        let fx = r.enter();
        let EffectBody::ConversationSetModel(m) = &fx[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(m.model_ref, "m-b");
    }

    #[test]
    fn the_context_percentage_comes_from_the_snapshot() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({"context": {"usedTokens": 1200, "windowTokens": 8000}}),
        );
        assert!(r.drawn().contains("15% context"), "{}", r.drawn());
    }

    #[test]
    fn copy_cut_and_paste_leave_as_the_cores_clipboard_effects() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("cut me");
        r.key(Key::Char('a'), Mods::CMD);
        let fx = r.key(Key::Char('x'), Mods::CMD);
        assert_eq!(fx[0].kind(), EffectKind::ClipboardWrite);
        assert_eq!(
            draft_json(&r)["text"],
            json!("cut me"),
            "not before the write"
        );
        r.send(Msg::Completion(Completion::new(
            fx[0].id,
            fx[0].resource.clone(),
            Outcome::Accepted,
        )));
        assert_eq!(draft_json(&r)["text"], json!(""));
        let fx = r.key(Key::Char('v'), Mods::CMD);
        assert_eq!(fx[0].kind(), EffectKind::ClipboardRead);
        r.send(Msg::Completion(
            Completion::new(fx[0].id, fx[0].resource.clone(), Outcome::Accepted).with_payload(
                CompletionPayload::Clipboard(theorem_workbench_core::completion::ClipboardText {
                    text: "pasted\nlines".into(),
                }),
            ),
        ));
        assert_eq!(draft_json(&r)["text"], json!("pasted\nlines"));
    }

    #[test]
    fn transcript_keys_and_the_runs_keys_reach_the_panel_not_the_draft() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({"run": {"state": "streaming", "runId": "run-1"}}),
        );
        r.typed("keep");
        // Ctrl+C with nothing selected stops the run; the draft is untouched.
        let fx = r.key(Key::Char('c'), Mods::CTRL);
        assert_eq!(fx[0].kind(), EffectKind::ConversationCancel);
        assert_eq!(draft_json(&r)["text"], json!("keep"));
        // Esc stops it too, as the footer says.
        let fx = r.key(Key::Esc, Mods::NONE);
        assert_eq!(fx[0].kind(), EffectKind::ConversationCancel);
        // Idle: Ctrl+C clears the draft.
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("gone");
        r.key(Key::Char('c'), Mods::CTRL);
        assert_eq!(draft_json(&r)["text"], json!(""));
        // Page keys and Ctrl+O are not text.
        r.typed("x");
        r.key(Key::PageUp, Mods::NONE);
        r.key(Key::Char('o'), Mods::CTRL);
        assert_eq!(draft_json(&r)["text"], json!("x"));
    }

    #[test]
    fn slash_commands_are_the_drawers_words_and_never_sent() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("/new");
        let fx = r.enter();
        assert_eq!(fx[0].kind(), EffectKind::ConversationCreate);
        r.typed("/nope");
        let fx = r.enter();
        assert!(fx.is_empty(), "{fx:?}");
        assert!(
            r.drawn().contains("/nope is not a command"),
            "{}",
            r.drawn()
        );
    }

    #[test]
    fn a_blocked_composer_sends_nothing_and_says_why() {
        let mut r = rig();
        // No snapshot yet: the panel is not connected to a conversation.
        r.typed("hello");
        let fx = r.enter();
        assert!(conversation_effects(&fx).is_empty(), "{fx:?}");
        assert!(r.drawn().contains("connecting"), "{}", r.drawn());
    }

    #[test]
    fn the_semantic_tree_has_one_text_field_and_no_plain_copy_of_the_draft() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        r.typed("secret words");
        let tree = r.tree();
        let fields: Vec<_> = tree
            .nodes
            .iter()
            .filter(|n| n.role == Role::TextBox)
            .collect();
        assert_eq!(fields.len(), 1);
        let copies = tree
            .nodes
            .iter()
            .filter(|n| {
                n.role != Role::TextBox
                    && (n
                        .state
                        .description
                        .as_deref()
                        .is_some_and(|d| d.contains("secret words"))
                        || n.name.contains("secret words"))
            })
            .count();
        assert_eq!(copies, 0);
    }

    // ---- delegations --------------------------------------------------------

    fn delegation(id: &str, label: &str, state: &str) -> Value {
        json!({"type": "delegation", "delegationId": id, "runId": "run-1",
               "label": label, "objective": "Check the shortcuts", "state": state})
    }

    fn with_delegations(parts: Vec<Value>) -> Rig {
        let directory = Directory::default();
        let mut factories = PanelFactories::new();
        register(&mut factories, &directory);
        theorem_workbench_panels::register(&mut factories);
        theorem_workbench_changes::register(&mut factories);
        let mut registry = builtin::registry();
        theorem_workbench_changes::extend_registry(&mut registry).unwrap();
        let (keys, issues) = KeyTable::build(&registry, Platform::Other, &Overrides::default());
        assert!(issues.is_empty(), "{issues:?}");
        let (dock, _) = Dock::from_preset(DockConfig::default(), Preset::Default);
        let mut m = Model::new(
            registry,
            factories,
            keys,
            Capabilities::of(["files", "conversation", "scm"]),
            dock,
        );
        update(
            &mut m,
            Msg::Resize {
                area: Rect::new(0, 0, 160, 50),
                metrics: CellMetrics::new(8.0, 16.0),
            },
        );
        update(
            &mut m,
            Msg::Action {
                id: ActionId::new("theo.focus"),
                actor: Actor::Human,
            },
        );
        let mut r = Rig {
            m,
            directory,
            seen: Vec::new(),
        };
        r.show(
            1,
            "t1",
            json!({"messages": [user("m1", "go"), assistant("m2", Value::Array(parts), "complete")],
                   "run": {"state": "idle", "runId": "run-1"}}),
        );
        r
    }

    fn alt(c: char) -> (Key, Mods) {
        (Key::Char(c), Mods::ALT)
    }

    fn kinds_open(r: &Rig, kind: &str) -> Vec<PanelInstanceId> {
        r.m.panel_ids()
            .filter(|(_, k)| k.as_str() == kind)
            .map(|(id, _)| id.clone())
            .collect()
    }

    #[test]
    fn a_run_with_delegations_lists_a_row_each_with_its_label_state_and_an_open_action() {
        let r = with_delegations(vec![
            delegation("d1", "Reviewer", "started"),
            json!({"type": "delegation", "delegationId": "d2", "runId": "run-1",
                   "label": "Worker", "objective": "Edit it", "state": "reviewed", "verdict": "accept"}),
        ]);
        let shown = r.drawn();
        assert!(shown.contains("Delegations (2)"), "{shown}");
        assert!(
            shown.contains("Reviewer  started  Check the shortcuts"),
            "{shown}"
        );
        assert!(
            shown.contains("Worker  reviewed (accept)  Edit it"),
            "{shown}"
        );

        let tree = r.tree();
        tree.validate().expect("one valid tree");
        let list = tree.nodes.iter().find(|n| n.role == Role::List).unwrap();
        assert_eq!(list.name, "Delegations");
        let rows: Vec<&Node> = tree
            .nodes
            .iter()
            .filter(|n| n.role == Role::ListItem)
            .collect();
        assert_eq!(
            rows.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(),
            ["Reviewer: started", "Worker: reviewed (accept)"]
        );
        assert_eq!(rows[0].actions[0].id.as_str(), "theo.delegation.open.d1");
        assert!(rows[0].actions[0].enabled);
        assert_eq!(
            rows[1].binding,
            ResourceRef::Delegation {
                run_id: "run-1".into(),
                delegation_id: "d2".into(),
                path: String::new()
            }
        );
        assert_eq!(rows[0].set_size, Some(2));
        // The transcript is not told twice: the part draws nothing in it.
        assert_eq!(shown.matches("Reviewer").count(), 1, "{shown}");
    }

    #[test]
    fn a_later_state_of_a_delegation_replaces_its_row() {
        let mut r = with_delegations(vec![delegation("d1", "Reviewer", "started")]);
        r.show(
            2,
            "t1",
            json!({"messages": [user("m1", "go"), assistant("m2", json!([delegation("d1", "Reviewer", "published")]), "complete")]}),
        );
        let shown = r.drawn();
        assert!(shown.contains("Delegations (1)"), "{shown}");
        assert!(shown.contains("Reviewer  published"), "{shown}");
        assert!(!shown.contains("started"), "{shown}");
    }

    #[test]
    fn alt_d_then_enter_opens_the_chosen_delegations_changes_panel() {
        let mut r = with_delegations(vec![
            delegation("d1", "Reviewer", "started"),
            delegation("d2", "Worker", "published"),
        ]);
        assert!(kinds_open(&r, "delegation").is_empty());
        let (k, m) = alt('d');
        r.key(k, m);
        assert!(r.drawn().contains("Enter opens"));
        let chosen = r.tree();
        assert!(chosen.nodes.iter().any(|n| n.role == Role::ListItem
            && n.state.selected
            && n.name == "Reviewer: started"));
        r.key(Key::Down, Mods::NONE);
        let fx = r.key(Key::Enter, Mods::NONE);
        // Opening is a core open, never an effect of the conversation.
        assert!(conversation_effects(&fx).is_empty());
        let opened = kinds_open(&r, "delegation");
        assert_eq!(opened.len(), 1);
        let node = r.tree().nodes.into_iter().find(|n| {
            n.binding
                == ResourceRef::Delegation {
                    run_id: "run-1".into(),
                    delegation_id: "d2".into(),
                    path: String::new(),
                }
        });
        assert!(
            node.is_some(),
            "the panel is bound to the chosen delegation"
        );
        assert_eq!(r.m.focus().panel, Some(opened[0].clone()));
    }

    #[test]
    fn esc_gives_the_keys_back_to_the_composer_and_other_keys_type() {
        let mut r = with_delegations(vec![delegation("d1", "Reviewer", "started")]);
        let (k, m) = alt('d');
        r.key(k, m);
        r.key(Key::Esc, Mods::NONE);
        r.typed("hi");
        assert!(kinds_open(&r, "delegation").is_empty());
        assert!(!r.drawn().contains("Enter opens"));
        // A letter while the list has the keys leaves the list and is typed.
        let (k, m) = alt('d');
        r.key(k, m);
        r.key(Key::Char('x'), Mods::NONE);
        assert!(!r.drawn().contains("Enter opens"));
        let draft = r.m.document();
        assert!(draft.to_string().contains("hix"), "{draft}");
    }

    #[test]
    fn an_agent_opens_a_delegation_by_the_rows_named_action() {
        let mut r = with_delegations(vec![delegation("d1", "Reviewer", "started")]);
        let id = r
            .tree()
            .nodes
            .iter()
            .find(|n| n.role == Role::ListItem)
            .unwrap()
            .actions[0]
            .id
            .clone();
        r.send(Msg::Action {
            id,
            actor: Actor::Agent {
                run_id: "run-9".into(),
            },
        });
        assert_eq!(kinds_open(&r, "delegation").len(), 1);
        // An id the conversation does not have opens nothing and is told.
        let before = r.m.panel_ids().count();
        r.send(Msg::Action {
            id: ActionId::new("theo.delegation.open.nope"),
            actor: Actor::Human,
        });
        assert_eq!(r.m.panel_ids().count(), before);
    }

    #[test]
    fn a_click_on_a_delegation_row_opens_it() {
        let mut r = with_delegations(vec![
            delegation("d1", "Reviewer", "started"),
            delegation("d2", "Worker", "published"),
        ]);
        let row = r
            .drawn()
            .lines()
            .position(|l| l.contains("Worker  published"))
            .unwrap();
        let origin = main_body(&r);
        r.send(Msg::Pointer(theorem_workbench_core::Pointer {
            kind: PointerKind::Down(theorem_workbench_core::Button::Left),
            x: origin.x + 6,
            y: row as u16,
            mods: Mods::NONE,
            clicks: 1,
        }));
        let opened = kinds_open(&r, "delegation");
        assert_eq!(opened.len(), 1);
        assert!(r.tree().nodes.iter().any(|n| n.binding
            == ResourceRef::Delegation {
                run_id: "run-1".into(),
                delegation_id: "d2".into(),
                path: String::new()
            }));
    }

    #[test]
    fn hostile_label_objective_and_state_text_is_escaped_where_it_is_drawn_and_named() {
        let r = with_delegations(vec![json!({
            "type": "delegation", "delegationId": "d1", "runId": "run-1",
            "label": "Rev\u{202e}iew\u{1b}[31mer", "objective": "a\u{7}b\nc",
            "state": "st\u{200b}arted", "verdict": "ok\u{9d}"
        })]);
        let shown = r.drawn();
        for raw in ['\u{202e}', '\u{1b}', '\u{7}', '\u{200b}', '\u{9d}'] {
            assert!(!shown.contains(raw), "{raw:?} reached the cells");
        }
        assert!(shown.contains("Rev\\u{202e}iew\\u{1b}[31mer"), "{shown}");
        let tree = r.tree();
        let row = tree
            .nodes
            .iter()
            .find(|n| n.role == Role::ListItem)
            .unwrap();
        assert_eq!(
            row.name,
            "Rev\\u{202e}iew\\u{1b}[31mer: st\\u{200b}arted (ok\\u{9d})"
        );
        let description = row.state.description.as_deref().unwrap();
        assert!(description.contains("a\\u{7}b c"), "{description}");
        for node in &tree.nodes {
            for text in [Some(&node.name), node.state.description.as_ref()]
                .into_iter()
                .flatten()
            {
                assert!(
                    !text
                        .chars()
                        .any(|c| c == '\u{202e}' || c == '\u{1b}' || c == '\u{200b}'),
                    "{text:?}"
                );
            }
        }
    }

    #[test]
    fn a_run_with_no_delegations_shows_nothing_extra() {
        let r = with_delegations(vec![json!({"type": "text", "text": "done"})]);
        let shown = r.drawn();
        assert!(!shown.contains("Delegations"), "{shown}");
        assert!(
            !r.tree()
                .nodes
                .iter()
                .any(|n| matches!(n.role, Role::List | Role::ListItem))
        );
        // And Alt+D is not taken: there is nothing to choose.
        assert!(!r.m.takes_chord(&KeyInput::new(Key::Char('d'), Mods::ALT)));
    }

    #[test]
    fn a_part_without_its_ids_is_not_a_row() {
        let r = with_delegations(vec![
            json!({"type": "delegation", "delegationId": "", "runId": "run-1", "label": "x", "state": "started"}),
            json!({"type": "delegation", "delegationId": "d1", "label": "x", "state": "started"}),
        ]);
        assert!(!r.drawn().contains("Delegations"));
    }

    // ---- L30: the queue, the approval region and its receipt, the footer ----

    /// A node's id within its panel.
    fn local(n: &Node) -> &str {
        n.id.as_str()
            .split_once('/')
            .map_or(n.id.as_str(), |(_, l)| l)
    }

    /// The frame cell where `needle` starts, in the drawn frame.
    fn cell_of(r: &Rig, needle: &str) -> Option<(u16, u16)> {
        let area = Rect::new(0, 0, 160, 50);
        let mut buf = Buffer::empty(area);
        theorem_workbench_core::view(&r.m, area, &mut buf, &Theme::plain());
        for y in 0..area.height {
            let mut line = String::new();
            let mut xs = Vec::new();
            for x in 0..area.width {
                let symbol = buf[(x, y)].symbol();
                for _ in 0..symbol.len() {
                    xs.push(x);
                }
                line.push_str(symbol);
            }
            if let Some(at) = line.find(needle) {
                return Some((xs[at], y));
            }
        }
        None
    }

    fn click_at(r: &mut Rig, (x, y): (u16, u16)) -> Vec<Effect> {
        r.send(Msg::Pointer(theorem_workbench_core::Pointer {
            kind: PointerKind::Down(theorem_workbench_core::Button::Left),
            x,
            y,
            mods: Mods::NONE,
            clicks: 1,
        }))
    }

    fn click_on(r: &mut Rig, needle: &str) -> Vec<Effect> {
        let at = cell_of(r, needle).unwrap_or_else(|| panic!("{needle:?} in\n{}", r.drawn()));
        click_at(r, at)
    }

    /// The row the box's top border is on.
    fn box_top(r: &Rig) -> usize {
        r.drawn()
            .lines()
            .collect::<Vec<_>>()
            .iter()
            .rposition(|l| l.contains('\u{256D}'))
            .expect("the box's top border")
    }

    fn working_with(queued: Value) -> Value {
        json!({
            "messages": [user("m1", "start")],
            "run": {"state": "streaming", "runId": "run-1"},
            "queued": queued,
        })
    }

    #[test]
    fn messages_sent_mid_turn_stand_over_the_box_in_the_order_sent_with_their_state() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            working_with(json!([
                {"clientMessageId": "c1", "text": "first steer", "state": "queued"},
                {"clientMessageId": "c2", "text": "second steer", "state": "failed", "reason": "the run ended"},
            ])),
        );
        // The composer stays usable: a third goes as input for the run.
        r.typed("third steer");
        let fx = r.enter();
        assert_eq!(fx[0].kind(), EffectKind::ConversationInput, "{fx:?}");
        let drawn = r.drawn();
        let lines: Vec<&str> = drawn.lines().collect();
        let row = |t: &str| {
            lines
                .iter()
                .position(|l| l.contains(t))
                .unwrap_or_else(|| panic!("{t} in\n{drawn}"))
        };
        let (a, b, c) = (row("first steer"), row("second steer"), row("third steer"));
        assert!(a < b && b < c && c < box_top(&r), "{drawn}");
        assert!(lines[a].contains("queued"), "{}", lines[a]);
        assert!(lines[b].contains("not sent: the run ended"), "{}", lines[b]);
        assert!(lines[b].contains("[retry]") && lines[b].contains("[remove]"));
        assert!(lines[c].contains("sending"), "{}", lines[c]);
        assert!(
            !lines[a].contains("[remove]"),
            "the owner holds a queued one"
        );
        let tree = r.tree();
        let names: Vec<_> = tree
            .nodes
            .iter()
            .filter(|n| local(n).starts_with("q:"))
            .map(|n| n.name.clone())
            .collect();
        assert_eq!(names.len(), 3, "{names:?}");
        assert!(names[0].starts_with("first steer"), "{names:?}");
    }

    #[test]
    fn a_queued_message_the_snapshot_takes_in_leaves_the_queue_once_and_shows_once() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            working_with(
                json!([{"clientMessageId": "c1", "text": "steer left", "state": "queued"}]),
            ),
        );
        assert_eq!(r.drawn().matches("steer left").count(), 1);
        let mut taken = assistant(
            "a1",
            json!([{"type": "input", "inputId": "c1", "text": "steer left", "status": "delivered"}]),
            "running",
        );
        taken["clientMessageId"] = json!(null);
        r.show(
            2,
            "t1",
            json!({
                "messages": [user("m1", "start"), taken],
                "run": {"state": "streaming", "runId": "run-1"},
                "queued": [],
            }),
        );
        let drawn = r.drawn();
        assert_eq!(drawn.matches("steer left").count(), 1, "{drawn}");
        assert!(!r.tree().nodes.iter().any(|n| local(n) == "q:c1"));
    }

    #[test]
    fn removing_a_kept_row_asks_the_owner_to_drop_its_record() {
        let queued = json!([
            {"clientMessageId": "c2", "text": "lost one", "state": "failed", "reason": "no run"},
        ]);
        let mut r = rig();
        r.show(1, "t1", working_with(queued));
        let fx = r.act("theo.view.queue.remove.c2");
        let sent = conversation_effects(&fx);
        let EffectBody::ConversationDismissInput(drop) = &sent[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(drop.client_message_id, "c2");
        assert!(!r.drawn().contains("lost one"));
    }

    #[test]
    fn a_failed_message_is_removed_by_key_by_click_and_by_action() {
        let queued = json!([
            {"clientMessageId": "c1", "text": "kept one", "state": "queued"},
            {"clientMessageId": "c2", "text": "lost one", "state": "failed", "reason": "no run"},
            {"clientMessageId": "c3", "text": "maybe one", "state": "uncertain"},
        ]);
        // By key: Alt+Q takes the keys to the first one that can go, Delete removes it.
        let mut r = rig();
        r.show(1, "t1", working_with(queued.clone()));
        r.key(Key::Char('q'), Mods::ALT);
        r.key(Key::Delete, Mods::NONE);
        let drawn = r.drawn();
        assert!(!drawn.contains("lost one"), "{drawn}");
        assert!(drawn.contains("kept one") && drawn.contains("maybe one"));
        // A queued one the owner holds does not go.
        r.key(Key::Home, Mods::NONE);
        r.key(Key::Backspace, Mods::NONE);
        assert!(r.drawn().contains("kept one"));
        // Esc gives the keys back; typing goes to the composer.
        r.key(Key::Esc, Mods::NONE);
        r.typed("x");
        assert_eq!(draft_json(&r)["text"], json!("x"));
        // The removal holds across a snapshot that still carries it.
        r.show(2, "t1", working_with(queued.clone()));
        assert!(!r.drawn().contains("lost one"));

        // By click on its remove.
        let mut r = rig();
        r.show(1, "t1", working_with(queued.clone()));
        let (_, y) = cell_of(&r, "maybe one").unwrap();
        let line = r.drawn().lines().nth(usize::from(y)).unwrap().to_owned();
        let x = line
            .find("[remove]")
            .expect("a remove on the uncertain row") as u16;
        click_at(&mut r, (x + 1, y));
        assert!(!r.drawn().contains("maybe one"), "{}", r.drawn());

        // By the tree's action.
        let mut r = rig();
        r.show(1, "t1", working_with(queued));
        r.act("theo.view.queue.remove.c2");
        assert!(!r.drawn().contains("lost one"));
        r.act("theo.view.queue.remove.c1");
        assert!(r.drawn().contains("kept one"));
    }

    #[test]
    fn a_retry_of_a_kept_row_names_that_row_and_mints_no_fresh_message() {
        // The owner keeps the words a run never took, so the panel's Retry is a request about
        // that message: it names the row's own id, and the owner replays that same request.
        let queued = json!([
            {"clientMessageId": "c2", "text": "try again", "state": "failed", "reason": "no run"},
        ]);
        let mut r = rig();
        r.show(1, "t1", working_with(queued));
        let fx = r.act("theo.view.queue.retry.c2");
        let sent = conversation_effects(&fx);
        let EffectBody::ConversationInput(input) = &sent[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(input.text, "try again");
        assert_eq!(input.run_id, "run-1");
        assert_eq!(
            input.client_message_id, "c2",
            "the same message, not a fresh one beside it"
        );
        // The row the person is watching is that request, so it stays listed until the owner
        // settles it; taking it back off is a separate act.
        let drawn = r.drawn();
        assert_eq!(drawn.matches("try again").count(), 1, "{drawn}");
        assert!(drawn.contains("[remove]"), "{drawn}");
    }

    #[test]
    fn a_recovered_draft_retries_under_its_message_id_without_a_run_id() {
        let queued = json!([
            {"clientMessageId": "recovered", "text": "finish the edit", "state": "failed", "reason": "no run"},
        ]);
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({"run": {"state": "idle"}, "queued": queued}),
        );
        let effects = r.act("theo.view.queue.retry.recovered");
        let sent = conversation_effects(&effects);
        let EffectBody::ConversationSend(send) = &sent[0].body else {
            panic!("recovered text must start a turn: {effects:?}")
        };
        assert_eq!(send.client_message_id, "recovered");
        assert_eq!(send.text, "finish the edit");
    }

    #[test]
    fn an_uncertain_row_is_retried_under_its_own_request_key() {
        // An ambiguous result keeps its original run, key and text, and Retry replays that
        // same request; it must not invite a fresh duplicate send as though the owner had
        // certainly refused it. So an uncertain row is playable, under its own id.
        let queued = json!([
            {"clientMessageId": "c1", "text": "lost one", "state": "uncertain"},
        ]);
        let mut r = rig();
        r.show(1, "t1", working_with(queued.clone()));
        assert!(r.drawn().contains("[retry]"), "{}", r.drawn());
        let fx = r.act("theo.view.queue.retry.c1");
        let sent = conversation_effects(&fx);
        let EffectBody::ConversationInput(input) = &sent[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(
            input.client_message_id, "c1",
            "the same request key, replayed"
        );
        assert_eq!(input.text, "lost one");
        assert_eq!(input.run_id, "run-1");
        // A row the owner holds is still one the person can take off the queue.
        assert!(r.drawn().contains("[remove]"), "{}", r.drawn());

        // Through the queue's keys, the same.
        let mut r = rig();
        r.show(1, "t1", working_with(queued));
        r.key(Key::Char('q'), Mods::ALT);
        let fx = r.enter();
        let EffectBody::ConversationInput(input) = &conversation_effects(&fx)[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(input.client_message_id, "c1");
    }

    #[test]
    fn a_refused_edit_is_retried_as_the_edit_it_was() {
        // A refused edit keeps the message it edits: retrying it must not turn into a plain
        // new turn, which would lose the branch the words were asked for.
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({"messages": [user("m1", "start"), assistant("m2", json!([{"type": "text", "text": "ok"}]), "complete")]}),
        );
        r.act("theo.edit");
        r.typed(" changed");
        let fx = r.enter();
        let EffectBody::ConversationEdit(first) = &conversation_effects(&fx)[0].body else {
            panic!("{fx:?}")
        };
        let (id, message_id) = (first.client_message_id.clone(), first.message_id.clone());
        r.send(Msg::Completion(Completion::new(
            fx[0].id,
            fx[0].resource.clone(),
            Outcome::Refused {
                code: "unavailable".into(),
                reason: "busy".into(),
            },
        )));
        let fx = r.act(&format!("theo.view.queue.retry.{id}"));
        let sent = conversation_effects(&fx);
        let EffectBody::ConversationEdit(edit) = &sent[0].body else {
            panic!("{:?}", sent[0])
        };
        assert_eq!(edit.text, "start changed");
        assert_eq!(edit.message_id, message_id, "the message it edits");
        assert_eq!(
            edit.client_message_id, id,
            "the same message, not a fresh one beside it"
        );
    }

    #[test]
    fn sending_a_new_message_keeps_other_failed_rows() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        let refuse = |r: &mut Rig, text: &str| {
            r.typed(text);
            let fx = r.enter();
            r.send(Msg::Completion(Completion::new(
                fx[0].id,
                fx[0].resource.clone(),
                Outcome::Refused {
                    code: "unavailable".into(),
                    reason: "busy".into(),
                },
            )));
        };
        refuse(&mut r, "alpha words");
        // The draft came back; it goes again and replaces its own failed row.
        let fx = r.enter();
        assert_eq!(fx.len(), 1);
        r.send(Msg::Completion(Completion::new(
            fx[0].id,
            fx[0].resource.clone(),
            Outcome::Refused {
                code: "unavailable".into(),
                reason: "busy".into(),
            },
        )));
        // One failed row over the box (the draft is back in it as well).
        let over = |r: &Rig, t: &str| {
            let top = box_top(r);
            r.drawn()
                .lines()
                .take(top)
                .filter(|l| l.contains(t))
                .count()
        };
        assert_eq!(over(&r, "alpha words"), 1, "{}", r.drawn());
        // Clear the draft and send another: the failed alpha row stays.
        r.key(Key::Char('a'), Mods::CMD);
        r.key(Key::Backspace, Mods::NONE);
        r.typed("beta words");
        r.enter();
        assert_eq!(over(&r, "alpha words"), 1, "{}", r.drawn());
        assert_eq!(over(&r, "beta words"), 1, "{}", r.drawn());
    }

    fn waiting() -> Value {
        json!({
            "messages": [user("m1", "list it"), assistant("a1", json!([
                {"type": "tool", "id": "call-1", "name": "shell", "args": "{\"command\": [\"ls\", \"-la\", \"src\"]}",
                 "status": "running", "approvalId": "ap-1", "approvalOutcome": "awaiting"}
            ]), "running")],
            "run": {"state": "waiting_approval", "runId": "run-1"},
            "approval": {"runId": "run-1", "approvalId": "ap-1", "toolCallId": "call-1",
                         "toolName": "shell", "summary": "List the source folder", "risk": "low"}
        })
    }

    #[test]
    fn a_waiting_approval_is_pinned_over_the_box_with_the_command_and_both_answers() {
        let mut r = rig();
        r.show(1, "t1", waiting());
        let drawn = r.drawn();
        let lines: Vec<&str> = drawn.lines().collect();
        let top = box_top(&r);
        assert!(
            lines[top - 1].contains("[ Allow  y ]  [ Deny  n ]"),
            "{drawn}"
        );
        assert!(lines[top - 2].contains("$ ls -la src"), "{drawn}");
        assert!(lines[top - 3].contains("List the source folder"), "{drawn}");
        assert!(
            lines[top - 4].contains("shell needs your approval")
                && lines[top - 4].contains("low risk"),
            "{drawn}"
        );
        let alert = r
            .tree()
            .nodes
            .into_iter()
            .find(|n| local(n) == "approval")
            .unwrap();
        assert_eq!(alert.rect.map(|c| c.y), Some(top as u16 - 4));
        // A click on Allow answers it.
        let fx = click_on(&mut r, "[ Allow");
        let EffectBody::ConversationApproval(a) = &fx[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(
            a.decision,
            theorem_workbench_core::effect::ApprovalDecision::Allow
        );
        assert!(r.drawn().contains("answer sent"), "{}", r.drawn());
        // And on Deny.
        let mut r = rig();
        r.show(1, "t1", waiting());
        let fx = click_on(&mut r, "[ Deny");
        let EffectBody::ConversationApproval(a) = &fx[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(
            a.decision,
            theorem_workbench_core::effect::ApprovalDecision::Deny
        );
        // With words typed, y is a letter of them and the region still waits.
        let mut r = rig();
        r.show(1, "t1", waiting());
        r.typed("ok");
        assert!(r.typed_effects("y").is_empty());
        assert_eq!(draft_json(&r)["text"], json!("oky"));
        assert!(r.drawn().contains("[ Allow  y ]"));
        // A change names the path it would write.
        let mut edit = waiting();
        edit["messages"][1]["parts"][0]["name"] = json!("edit_file");
        edit["messages"][1]["parts"][0]["args"] = json!("{\"path\": \"src/a.rs\"}");
        let mut r = rig();
        r.show(1, "t1", edit);
        let drawn = r.drawn();
        let lines: Vec<&str> = drawn.lines().collect();
        let top = box_top(&r);
        assert!(
            lines[top - 2].contains("src/a.rs") && !lines[top - 2].contains('$'),
            "{drawn}"
        );
    }

    #[test]
    fn an_answered_approval_leaves_a_receipt_where_it_was_asked() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({
                "messages": [user("m1", "list it"), assistant("a1", json!([
                    {"type": "tool", "id": "call-1", "name": "shell", "args": "ls -la src",
                     "status": "complete", "result": "a b", "approvalId": "ap-1",
                     "approvalOutcome": "approved", "approvalSummary": "List the source folder"},
                    {"type": "tool", "id": "call-2", "name": "shell", "args": "rm -rf build",
                     "status": "failed", "approvalId": "ap-2", "approvalOutcome": "declined"}
                ]), "complete")],
            }),
        );
        let drawn = r.drawn();
        assert!(
            drawn.contains("\u{2713} Allowed: List the source folder"),
            "{drawn}"
        );
        assert!(
            drawn.contains("\u{2717} Denied: shell rm -rf build"),
            "{drawn}"
        );
        assert!(!drawn.contains("needs your approval"));
        let lines: Vec<&str> = drawn.lines().collect();
        let receipt = lines.iter().position(|l| l.contains("Allowed:")).unwrap();
        assert!(receipt < box_top(&r));
        let receipts: Vec<_> = r
            .tree()
            .nodes
            .into_iter()
            .filter(|n| local(n).starts_with("r:"))
            .collect();
        // Each receipt node is the one row it is drawn on.
        for node in &receipts {
            let at = node.rect.expect("a receipt has a place");
            assert_eq!(at.height, 1, "{}", node.name);
            let word = node.name.split(':').next().unwrap();
            assert!(
                lines[usize::from(at.y)].contains(&format!("{word}:")),
                "{} drawn on {:?}",
                node.name,
                lines[usize::from(at.y)]
            );
        }
        let names: Vec<_> = receipts.into_iter().map(|n| n.name).collect();
        assert_eq!(
            names,
            [
                "Allowed: List the source folder",
                "Denied: shell rm -rf build"
            ]
        );
    }

    fn models_for(r: &mut Rig) {
        r.send(Msg::Host(HostMessage::ConversationModels {
            resource: ResourceRef::Conversation {
                project: PROJECT.into(),
                thread: "t1".into(),
            },
            conversation_id: "t1".into(),
            models: vec![
                serde_json::from_value(json!({"ref": "m-a", "label": "Alpha"})).unwrap(),
                serde_json::from_value(json!({"ref": "m-b", "label": "Beta"})).unwrap(),
            ],
            selected: Some("m-a".into()),
            effort: Some("low".into()),
            efforts: vec!["low".into(), "high".into()],
        }));
    }

    fn named(r: &mut Rig) {
        r.send(Msg::Host(HostMessage::ThreadsChanged {
            listing: theorem_workbench_core::threads::ThreadListing {
                projects: vec![theorem_workbench_core::threads::ThreadProject {
                    id: PROJECT.into(),
                    name: "Orchard".into(),
                }],
                threads: vec![],
                open: None,
                as_of_ms: 0,
            },
        }));
    }

    #[test]
    fn the_footer_under_the_box_names_the_project_effort_model_and_stop_and_they_act() {
        let mut r = rig();
        r.show(
            1,
            "t1",
            json!({"run": {"state": "streaming", "runId": "run-1"}}),
        );
        models_for(&mut r);
        named(&mut r);
        let drawn = r.drawn();
        let lines: Vec<&str> = drawn.lines().collect();
        let bottom = lines.iter().rposition(|l| l.contains('\u{2570}')).unwrap();
        let footer = lines[bottom + 1];
        for word in ["Orchard", "low effort", "Alpha", "\u{25A0} stop"] {
            assert!(footer.contains(word), "{word} in {footer:?}");
        }
        assert!(
            !lines[bottom - 1].contains("Alpha"),
            "said once, in the footer"
        );
        let ids: Vec<_> = r
            .tree()
            .nodes
            .iter()
            .filter(|n| local(n).starts_with("footer:"))
            .map(|n| local(n).to_owned())
            .collect();
        assert_eq!(
            ids,
            [
                "footer:project",
                "footer:effort",
                "footer:model",
                "footer:stop"
            ]
        );
        // Effort by click and by Alt+T.
        let fx = click_on(&mut r, "low effort");
        let EffectBody::ConversationSetEffort(e) = &fx[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(e.level, "high");
        let fx = r.key(Key::Char('t'), Mods::ALT);
        assert!(
            matches!(fx[0].body, EffectBody::ConversationSetEffort(_)),
            "{fx:?}"
        );
        // The model by click opens the list; by Alt+M too.
        click_on(&mut r, "Alpha");
        r.key(Key::Down, Mods::NONE);
        let fx = r.enter();
        let EffectBody::ConversationSetModel(m) = &fx[0].body else {
            panic!("{fx:?}")
        };
        assert_eq!(m.model_ref, "m-b");
        r.key(Key::Char('m'), Mods::ALT);
        let fx = r.enter();
        assert!(
            matches!(fx[0].body, EffectBody::ConversationSetModel(_)),
            "{fx:?}"
        );
        // Stop by click while the run works.
        let fx = click_on(&mut r, "\u{25A0} stop");
        assert_eq!(fx[0].kind(), EffectKind::ConversationCancel, "{fx:?}");
        // Idle, stop is off: a click does nothing.
        let mut r = rig();
        r.show(1, "t1", json!({}));
        let fx = click_on(&mut r, "\u{25A0} stop");
        assert!(conversation_effects(&fx).is_empty(), "{fx:?}");
        let stop = r
            .tree()
            .nodes
            .into_iter()
            .find(|n| local(n) == "footer:stop")
            .unwrap();
        assert!(stop.state.disabled);
    }

    #[test]
    fn takes_chord_answers_for_the_queue_model_and_effort_chords() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        let id = r.id();
        let panel = r.m.panel(&id).unwrap();
        let chord = |c| KeyInput::new(Key::Char(c), Mods::ALT);
        assert!(panel.takes_chord(&chord('m')));
        assert!(panel.takes_chord(&chord('t')));
        assert!(
            !panel.takes_chord(&chord('q')),
            "an empty queue takes no chord"
        );
        r.show(
            2,
            "t1",
            working_with(json!([{"clientMessageId": "c1", "text": "x", "state": "failed"}])),
        );
        assert!(r.m.panel(&id).unwrap().takes_chord(&chord('q')));
    }

    /// A panel bound and drawn into a footer row `width` wide, with every item there.
    fn footer_at(width: u16, working: bool) -> String {
        let mut p = TheoPanel::new(Kind::Main, Directory::default(), &json!({}));
        let run = if working {
            json!({"state": "streaming", "runId": "r"})
        } else {
            json!({"state": "idle"})
        };
        p.adopt(
            PROJECT,
            "t1",
            1,
            &json!({"conversationId": "t1", "messages": [], "run": run, "queued": []}).to_string(),
        );
        p.project_names.insert(PROJECT.into(), "Orchard".into());
        p.repo.head = Some("feature/queue".into());
        p.repo.keys = vec![RowKey {
            section: theorem_workbench_changes::Section::Unstaged,
            path: "a.rs".into(),
        }];
        p.repo.counts = vec![Some((12, 3))];
        p.effort = Some("medium".into());
        p.selected_model = Some("m-a".into());
        p.models = vec![serde_json::from_value(json!({"ref": "m-a", "label": "Alpha"})).unwrap()];
        let area = Rect::new(0, 0, width, 1);
        let mut buf = Buffer::empty(area);
        p.draw_footer_row(&mut buf, area);
        (0..width)
            .map(|x| buf[(x, 0)].symbol().to_owned())
            .collect::<String>()
    }

    #[test]
    fn the_footer_drops_whole_items_in_order_and_never_stop_while_a_run_works() {
        let wide = footer_at(120, true);
        for word in [
            "Orchard",
            "feature/queue",
            "+12",
            "\u{2212}3",
            "medium effort",
            "Alpha",
            "\u{25A0} stop",
        ] {
            assert!(wide.contains(word), "{word} in {wide:?}");
        }
        // Narrower, whole items go in order: the project, the totals, the branch, the
        // effort, the model. Stop stays while the run works.
        let all = [
            "Orchard",
            "feature/queue",
            "+12",
            "medium effort",
            "Alpha",
            "\u{25A0} stop",
        ];
        let shows =
            |row: &str| -> Vec<&str> { all.iter().copied().filter(|w| row.contains(w)).collect() };
        assert_eq!(
            shows(&footer_at(60, true)),
            [
                "feature/queue",
                "+12",
                "medium effort",
                "Alpha",
                "\u{25A0} stop"
            ]
        );
        assert_eq!(
            shows(&footer_at(50, true)),
            ["feature/queue", "medium effort", "Alpha", "\u{25A0} stop"]
        );
        assert_eq!(
            shows(&footer_at(40, true)),
            ["medium effort", "Alpha", "\u{25A0} stop"]
        );
        // A phone's width (390px is about 48 cells less the panel's chrome).
        assert_eq!(shows(&footer_at(30, true)), ["Alpha", "\u{25A0} stop"]);
        assert_eq!(shows(&footer_at(12, true)), ["\u{25A0} stop"]);
        // Idle, stop goes first.
        assert_eq!(
            shows(&footer_at(44, false)),
            ["feature/queue", "medium effort", "Alpha"]
        );
        // Whatever the width, no word is cut.
        for width in 8..120 {
            for working in [true, false] {
                let row = footer_at(width, working);
                for word in ["Orchard", "feature/queue", "medium", "Alpha", "stop"] {
                    let prefix = &word[..word.len().min(3)];
                    if row.contains(prefix) && !row.contains(word) {
                        panic!("{word} cut at {width}: {row:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn clip_words_cuts_at_a_word_end_never_inside_one() {
        assert_eq!(clip_words("short", 10), "short");
        assert_eq!(clip_words("one two three four", 10), "one two\u{2026}");
        assert_eq!(clip_words("unbreakableword", 6), "unbre\u{2026}");
    }

    fn scm_rig() -> Rig {
        let directory = Directory::default();
        let mut m = model_with(
            &directory,
            &["files", "conversation", "conversation.model", "scm"],
        );
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

    fn scm_status(paths: &[&str]) -> CompletionPayload {
        CompletionPayload::Scm(theorem_workbench_core::completion::ScmStatus {
            branch: Some("feature/queue".into()),
            head: None,
            changes: paths
                .iter()
                .map(|p| theorem_workbench_core::completion::ScmChange {
                    path: (*p).into(),
                    index: " ".into(),
                    worktree: "M".into(),
                    original_path: None,
                    conflict: false,
                })
                .collect(),
            state: None,
        })
    }

    fn scm_diff(text: &str) -> CompletionPayload {
        CompletionPayload::ScmDiff(theorem_workbench_core::completion::ScmDiffResult {
            path: None,
            staged: false,
            commit: None,
            text: text.into(),
            hunks: vec![],
            state: None,
        })
    }

    #[test]
    fn the_footer_reads_the_branch_and_diff_totals_from_the_changes_source() {
        let mut r = scm_rig();
        r.show(1, "t1", json!({}));
        let status: Vec<_> = r
            .seen
            .iter()
            .filter(|e| e.kind() == EffectKind::ScmStatus)
            .cloned()
            .collect();
        assert_eq!(status.len(), 1, "{:?}", r.seen);
        r.send(Msg::Completion(
            Completion::new(status[0].id, status[0].resource.clone(), Outcome::Accepted)
                .with_payload(scm_status(&["a.rs", "b.rs"])),
        ));
        let fx = r.send(Msg::Tick);
        let diffs: Vec<_> = fx
            .iter()
            .filter(|e| e.kind() == EffectKind::ScmDiff)
            .cloned()
            .collect();
        assert_eq!(diffs.len(), 2, "{fx:?}");
        assert!(r.drawn().contains("feature/queue"), "{}", r.drawn());
        // One diff in: no totals yet, never a partial sum.
        r.send(Msg::Completion(
            Completion::new(diffs[0].id, diffs[0].resource.clone(), Outcome::Accepted)
                .with_payload(scm_diff("@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n")),
        ));
        assert!(!r.drawn().contains("+2"), "{}", r.drawn());
        r.send(Msg::Completion(
            Completion::new(diffs[1].id, diffs[1].resource.clone(), Outcome::Accepted)
                .with_payload(scm_diff("@@ -1 +1 @@\n-x\n+y\n")),
        ));
        assert!(r.drawn().contains("+3 \u{2212}2"), "{}", r.drawn());
        // A file change reads it again at the next tick.
        r.send(Msg::Host(HostMessage::FileChanged {
            workspace: String::new(),
            path: "a.rs".into(),
        }));
        let fx = r.send(Msg::Tick);
        assert!(
            fx.iter().any(|e| e.kind() == EffectKind::ScmStatus),
            "{fx:?}"
        );
    }

    #[test]
    fn without_scm_the_footer_asks_for_nothing_and_shows_no_totals() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        assert!(!r.seen.iter().any(|e| e.kind() == EffectKind::ScmStatus));
        assert!(!r.tree().nodes.iter().any(|n| local(n) == "footer:totals"));
    }

    #[test]
    fn a_bound_panel_asks_for_the_models_once_so_the_footer_can_name_them() {
        let mut r = rig();
        r.show(1, "t1", json!({}));
        let asked = |r: &Rig| {
            r.seen
                .iter()
                .filter(|e| e.kind() == EffectKind::ConversationModels)
                .count()
        };
        assert_eq!(asked(&r), 1, "{:?}", r.seen);
        r.send(Msg::Tick);
        r.show(2, "t1", json!({}));
        assert_eq!(asked(&r), 1, "once per conversation");
        // Without the capability it asks for nothing.
        let directory = Directory::default();
        let mut m = model_with(&directory, &["files", "conversation"]);
        update(
            &mut m,
            Msg::Action {
                id: ActionId::new("theo.focus"),
                actor: Actor::Human,
            },
        );
        let mut r = Rig {
            m,
            directory,
            seen: Vec::new(),
        };
        r.show(1, "t1", json!({}));
        assert_eq!(asked(&r), 0);
    }

    #[test]
    fn a_theo_panel_mounted_after_the_listing_still_names_its_project() {
        let directory = Directory::default();
        let mut m = model(&directory);
        let listing = Msg::Host(HostMessage::ThreadsChanged {
            listing: theorem_workbench_core::threads::ThreadListing {
                projects: vec![theorem_workbench_core::threads::ThreadProject {
                    id: PROJECT.into(),
                    name: "Orchard".into(),
                }],
                threads: vec![],
                open: None,
                as_of_ms: 0,
            },
        });
        update(&mut m, listing);
        let mut r = Rig {
            m,
            directory,
            seen: Vec::new(),
        };
        r.send(Msg::Action {
            id: ActionId::new("theo.focus"),
            actor: Actor::Human,
        });
        r.send(Msg::Host(HostMessage::WorkspaceChanged {
            workspace: "w1".into(),
            environment: None,
        }));
        r.show(1, "t1", json!({}));
        let drawn = r.drawn();
        let footer = drawn.lines().last().unwrap_or_default().to_owned();
        assert!(drawn.contains("Orchard"), "{drawn}\n{footer}");
    }
}
