//! Keys, text, the pointer, and the actions they start.

use keybinds::{Key, KeyInput, Mods};
use ratatui::layout::Rect;
use theorem_workbench_core::effect::ReconcileKeep;
use theorem_workbench_core::{Button, Ctx, PanelPointer, PointerKind};
use theorem_workbench_text::{EditError, EditSession, LocalEdit, Resolution};

use super::{Clip, EditorPanel, Phase, Tone};
use crate::actions::Choice;
use crate::field::{Event, Field};
use crate::widget::{Clipboard, Reaction};

/// The chord a key is, when it is one. Alt and a letter belong to the editor
/// only for the letters it uses: any other Alt combination is the widget's.
fn chord(key: &KeyInput) -> Option<Choice> {
    let mods = key.mods();
    let command = mods.intersects(Mods::CTRL | Mods::CMD);
    let alt = mods.contains(Mods::ALT);
    // Mod and Alt together is the workbench's own chord space, and on some
    // layouts the way to type a character: not ours either way.
    if command && alt {
        return None;
    }
    match key.key() {
        Key::Char(c) if command => match c.to_ascii_lowercase() {
            's' => Some(Choice::Save),
            'f' => Some(Choice::Find),
            _ => None,
        },
        Key::F3 if mods.contains(Mods::SHIFT) => Some(Choice::FindPrevious),
        Key::F3 => Some(Choice::FindNext),
        Key::F2 => Some(Choice::Rename),
        Key::Char(c) if alt && c.is_ascii_alphabetic() => match c.to_ascii_lowercase() {
            'f' if c == 'F' || mods.contains(Mods::SHIFT) => Some(Choice::Format),
            'a' => Some(Choice::ApplyPlan),
            'm' => Some(Choice::KeepMine),
            't' => Some(Choice::TakeTheirs),
            'b' => Some(Choice::KeepBoth),
            'y' => Some(Choice::CopyMine),
            'r' => Some(Choice::Resend),
            'd' => Some(Choice::KeepDisk),
            'k' => Some(Choice::KeepAuthority),
            _ => None,
        },
        _ => None,
    }
}

impl EditorPanel {
    pub(super) fn on_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        if !matches!(self.phase, Phase::Ready(_)) {
            match key.key() {
                Key::Enter => self.choose(Choice::Retry, cx),
                Key::Esc => self.choose(Choice::Close, cx),
                _ => {}
            }
            return;
        }

        // The rename name is modal: everything goes to it until it ends.
        if let Some(d) = self.doc_mut()
            && let Some(field) = d.rename.as_mut()
        {
            match field.key(&key) {
                Event::Enter => {
                    let name = field.value().trim().to_owned();
                    d.rename = None;
                    if !name.is_empty() {
                        self.send_rename(name, cx);
                    }
                }
                Event::Escape => d.rename = None,
                Event::Edited | Event::Ignored => {}
            }
            return;
        }

        if let Some(choice) = chord(&key) {
            self.choose(choice, cx);
            return;
        }

        let Some(d) = self.doc_mut() else { return };
        let mods = key.mods();
        if d.find.is_open() && mods.contains(Mods::ALT) && matches!(key.key(), Key::Char('c' | 'C'))
        {
            d.find.toggle_case();
            return;
        }

        if d.in_find {
            match d.find.field.key(&key) {
                Event::Enter => {
                    let forward = !mods.contains(Mods::SHIFT);
                    self.choose(
                        if forward {
                            Choice::FindNext
                        } else {
                            Choice::FindPrevious
                        },
                        cx,
                    );
                    return;
                }
                Event::Escape => {
                    d.find.close();
                    d.in_find = false;
                    return;
                }
                Event::Edited => {
                    self.land_on_first_match();
                    return;
                }
                Event::Ignored => {}
            }
        }

        if key.key() == Key::Esc {
            self.choose(Choice::Dismiss, cx);
            return;
        }

        let Some(d) = self.doc_mut() else { return };
        let reaction = d.view.key(&mut d.session, &key);
        if let Some(c) = self.settle(reaction) {
            self.clipboard(c, cx);
        }
    }

    pub(super) fn on_text(&mut self, text: &str) {
        let Some(d) = self.doc_mut() else { return };
        if let Some(field) = d.rename.as_mut() {
            field.text(text);
            return;
        }
        if d.in_find {
            d.find.field.text(text);
            self.land_on_first_match();
            return;
        }
        let reaction = d.view.text(&mut d.session, text);
        self.settle(reaction);
    }

    pub(super) fn on_paste(&mut self, text: &str) {
        let Some(d) = self.doc_mut() else { return };
        if let Some(field) = d.rename.as_mut() {
            field.text(text.lines().next().unwrap_or(""));
            return;
        }
        if d.in_find {
            d.find.field.text(text.lines().next().unwrap_or(""));
            self.land_on_first_match();
            return;
        }
        let reaction = d.view.paste(&mut d.session, text);
        self.settle(reaction);
    }

    /// What an input did, in the panel's terms. A clipboard request comes back
    /// for the caller, which has the context to send it.
    fn settle(&mut self, reaction: Reaction) -> Option<Clipboard> {
        let Reaction {
            edited,
            error,
            clipboard,
            ..
        } = reaction;
        if edited && let Some(d) = self.doc_mut() {
            d.touch();
        }
        if let Some(e) = error {
            let note = self.edit_error(&e);
            self.say(note, Tone::Warn);
        }
        clipboard
    }

    pub(super) fn edit_error(&self, error: &EditError) -> String {
        match error {
            EditError::ReadOnly => {
                let why = self
                    .doc()
                    .and_then(|d| d.read_only.clone())
                    .unwrap_or_else(|| "the owner does not allow edits here".to_owned());
                format!("Read-only: {why}")
            }
            other => other.to_string(),
        }
    }

    /// While the query is typed, the selection follows the first match at or
    /// after where it started.
    fn land_on_first_match(&mut self) {
        let Some(d) = self.doc_mut() else { return };
        let version = d.version;
        d.find.refresh(&d.session, version);
        let from = d.session.selection().map_or(d.session.cursor(), |s| s.0);
        if let Some((a, b)) = d.find.first_from(from) {
            d.session.set_selection(a, b);
            d.view.reveal(&mut d.session);
        }
    }

    // ---- pointer ----------------------------------------------------------

    pub(super) fn on_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        let area = Rect::new(0, 0, self.body.0, self.body.1);
        if !matches!(self.phase, Phase::Ready(_)) {
            if matches!(p.kind, PointerKind::Down(Button::Left))
                && let Some(choice) = self.message_button_at(area, p.x, p.y)
            {
                self.choose(choice, cx);
            }
            return;
        }
        let Some(frame) = self.frame(area) else {
            return;
        };
        let inside = |r: Rect| {
            p.x >= i32::from(r.x)
                && p.x < i32::from(r.x + r.width)
                && p.y >= i32::from(r.y)
                && p.y < i32::from(r.y + r.height)
        };
        let to_text = PanelPointer {
            x: p.x - i32::from(frame.text.x),
            y: p.y - i32::from(frame.text.y),
            ..p
        };
        let Some(d) = self.doc_mut() else { return };
        match p.kind {
            PointerKind::Down(Button::Left) => {
                if frame.find.is_some_and(inside) {
                    d.in_find = true;
                } else if frame.strip.is_some_and(inside) {
                    if let Some(choice) = self.strip_button_at(&frame, p.x, p.y) {
                        self.choose(choice, cx);
                    }
                } else if inside(frame.text) {
                    d.in_find = false;
                    let reaction = d.view.pointer(&mut d.session, to_text);
                    self.settle(reaction);
                }
            }
            PointerKind::Wheel { .. } => {
                if inside(frame.text) {
                    d.view.pointer(&mut d.session, to_text);
                }
            }
            // A drag is the widget's while the press is held, wherever the
            // pointer is; with no drag a move is nobody's.
            PointerKind::Move | PointerKind::Up(_) => {
                if d.view.dragging() {
                    d.view.pointer(&mut d.session, to_text);
                }
            }
            PointerKind::Down(_) => {}
        }
    }

    // ---- choices ----------------------------------------------------------

    pub(super) fn choose(&mut self, choice: Choice, cx: &mut Ctx) {
        if !matches!(self.phase, Phase::Ready(_)) {
            match choice {
                Choice::Retry if self.can_retry() => {
                    self.phase = Phase::Waiting;
                    self.tick(cx);
                }
                Choice::Close => cx.close_self(),
                _ => {}
            }
            return;
        }
        if choice == Choice::Close {
            cx.close_self();
            return;
        }
        if let Some(reason) = self.unavailable(choice) {
            // Esc on a clean editor is not a request.
            if choice != Choice::Dismiss {
                let title = choice.descriptor().title;
                self.say(format!("{title}: {reason}"), Tone::Warn);
            }
            return;
        }
        match choice {
            Choice::Save => self.save(cx),
            Choice::Undo => self.local(|s| s.undo()),
            Choice::Redo => self.local(|s| s.redo()),
            Choice::Find => {
                if let Some(d) = self.doc_mut() {
                    let seed = d.session.selected_text();
                    d.find.open(seed);
                    d.in_find = true;
                    let version = d.version;
                    d.find.refresh(&d.session, version);
                }
            }
            Choice::FindNext => self.step(true),
            Choice::FindPrevious => self.step(false),
            Choice::Rename => {
                if let Some(d) = self.doc_mut() {
                    let seed = d.view.seed(&d.session).unwrap_or_default();
                    d.rename = Some(Field::with_value(&seed));
                }
            }
            Choice::Format => self.send_format(cx),
            Choice::ApplyPlan => self.apply_plan(cx),
            Choice::KeepMine => self.resolve(Resolution::KeepMine, cx),
            Choice::TakeTheirs => self.resolve(Resolution::TakeTheirs, cx),
            Choice::KeepBoth => self.resolve(Resolution::KeepBoth, cx),
            Choice::CopyMine => {
                let Some(d) = self.doc() else { return };
                let text = d.recoverable.clone().unwrap_or_else(|| d.session.text());
                self.write_clipboard(text, Clip::Copy, cx);
            }
            Choice::Resend => {
                if let Some(d) = self.doc_mut()
                    && let Some(u) = d.unknown.take()
                {
                    d.inflight = None;
                    let _ = d.session.requeue(&u.op);
                    d.notice("Sending the edit again under its own id.", Tone::Info);
                }
            }
            Choice::KeepDisk => self.reconcile(ReconcileKeep::Disk, cx),
            Choice::KeepAuthority => self.reconcile(ReconcileKeep::Authority, cx),
            Choice::Dismiss => {
                if let Some(d) = self.doc_mut() {
                    if d.find.is_open() {
                        d.find.close();
                        d.in_find = false;
                    } else {
                        d.notice = None;
                        d.recoverable = None;
                        d.plan = None;
                    }
                }
            }
            Choice::Retry | Choice::Close => {}
        }
    }

    fn can_retry(&self) -> bool {
        matches!(&self.phase, Phase::Failed(p) if p.can_retry)
    }

    fn save(&mut self, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        if d.session.has_pending() {
            // The save is of the revision the owner has accepted; the edits
            // typed so far are not in it until the owner says so.
            d.save.wanted = true;
            d.notice(
                "Saving as soon as the owner has accepted the edits.",
                Tone::Info,
            );
        } else {
            self.send_save(cx);
        }
    }

    /// A local change to the text from outside the widget (undo, redo).
    fn local(&mut self, f: impl FnOnce(&mut EditSession) -> Result<Option<LocalEdit>, EditError>) {
        let Some(d) = self.doc_mut() else { return };
        match f(&mut d.session) {
            Ok(Some(_)) => {
                d.touch();
                d.view.reveal(&mut d.session);
            }
            Ok(None) => {}
            Err(e) => {
                let note = self.edit_error(&e);
                self.say(note, Tone::Warn);
            }
        }
    }

    fn step(&mut self, forward: bool) {
        let Some(d) = self.doc_mut() else { return };
        let version = d.version;
        d.find.refresh(&d.session, version);
        if let Some((a, b)) = d.find.step(&d.session, forward) {
            d.session.set_selection(a, b);
            d.view.reveal(&mut d.session);
        }
    }

    // ---- the clipboard ----------------------------------------------------

    /// Through the core's effects only: the panel keeps no buffer of its own.
    fn clipboard(&mut self, what: Clipboard, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        match what {
            Clipboard::Copy | Clipboard::Cut => {
                let (Some(text), Some(selection)) =
                    (d.session.selected_text(), d.session.selection())
                else {
                    d.notice("Nothing is selected.", Tone::Info);
                    return;
                };
                if what == Clipboard::Cut && d.session.config().read_only {
                    let note = self.edit_error(&EditError::ReadOnly);
                    self.say(note, Tone::Warn);
                    return;
                }
                let task = if what == Clipboard::Cut {
                    Clip::Cut {
                        text: text.clone(),
                        selection,
                    }
                } else {
                    Clip::Copy
                };
                self.write_clipboard(text, task, cx);
            }
            Clipboard::Paste => {
                if d.session.config().read_only {
                    let note = self.edit_error(&EditError::ReadOnly);
                    self.say(note, Tone::Warn);
                    return;
                }
                if let Err(e) = self.emit_clip(
                    cx,
                    theorem_workbench_core::effect::EffectBody::ClipboardRead,
                    Clip::Paste,
                ) {
                    self.say(super::flow::emit_notice(e), Tone::Warn);
                }
            }
        }
    }

    pub(super) fn relayout(&mut self) {
        let area = Rect::new(0, 0, self.body.0, self.body.1);
        let Some(frame) = self.frame(area) else {
            return;
        };
        if let Some(d) = self.doc_mut() {
            let size = (frame.text.width, frame.text.height);
            if d.view.size() != size {
                d.view.resize(&mut d.session, size.0, size.1);
                d.view.reveal(&mut d.session);
            }
        }
    }
}
