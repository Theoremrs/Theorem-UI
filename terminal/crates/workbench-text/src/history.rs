//! Undo and redo as stacks of operations.
//!
//! An undo entry is the inverse of a local edit and applies to the current
//! text. Typing is grouped: consecutive inserts of the same character class
//! that touch each other, and consecutive backspaces or forward deletes that
//! touch each other, share one entry. A change from the owner never becomes an
//! entry; instead every entry is transformed past it so it still applies.
//!
//! An entry also carries the atomic ranges its edit dissolved, as they lay in
//! the text the entry produces, so applying it brings the marks back with
//! their ids. They follow the entry through owner changes and are dropped when
//! an owner change edits inside them.

use crate::change::{Bias, map_pos, touches_interior};
use crate::session::AtomicRange;
use operational_transform::OperationSeq;

const MAX_ENTRIES: usize = 1000;

/// What an edit was, for grouping.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Insert,
    Backspace,
    DeleteForward,
    /// Pastes, cuts, word deletes, newlines, replacements: never grouped.
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Class {
    Word,
    Space,
    Other,
}

pub(crate) fn class_of(text: &str) -> Class {
    match text.chars().last() {
        Some(c) if c.is_alphanumeric() || c == '_' => Class::Word,
        Some(c) if c.is_whitespace() => Class::Space,
        _ => Class::Other,
    }
}

/// How one edit sits in the text, in scalars: it replaced `[start, end)` with `inserted` scalars.
#[derive(Clone, Copy, Debug)]
pub(crate) struct EditShape {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
    pub inserted: usize,
    pub class: Class,
    pub has_newline: bool,
}

#[derive(Clone, Copy, Debug)]
struct Group {
    kind: Kind,
    /// Where the next edit of this kind must touch for the group to continue.
    next: usize,
    class: Class,
}

/// An operation that applies to the current text, and the atomic ranges to
/// restore once it has.
#[derive(Clone, Debug)]
pub(crate) struct Entry {
    pub op: OperationSeq,
    pub marks: Vec<AtomicRange>,
}

impl Entry {
    fn is_noop(&self) -> bool {
        self.op.is_noop()
    }
}

#[derive(Default)]
pub(crate) struct History {
    undo: Vec<Entry>,
    redo: Vec<Entry>,
    group: Option<Group>,
}

impl History {
    /// Record the inverse of a fresh local edit. Clears the redo stack.
    pub fn record(&mut self, inverse: OperationSeq, marks: Vec<AtomicRange>, shape: EditShape) {
        self.redo.clear();
        let joins = match (&self.group, shape.kind) {
            (Some(g), Kind::Insert) => {
                g.kind == Kind::Insert
                    && g.next == shape.start
                    && g.class == shape.class
                    && !shape.has_newline
            }
            (Some(g), Kind::Backspace) => g.kind == Kind::Backspace && g.next == shape.end,
            (Some(g), Kind::DeleteForward) => {
                g.kind == Kind::DeleteForward && g.next == shape.start
            }
            _ => false,
        };
        let merged = joins
            && self
                .undo
                .last()
                .and_then(|top| {
                    let c = inverse.compose(&top.op).ok()?;
                    // The new marks lie in the text `top` applies to; carry
                    // them across it, then add the ones `top` already held.
                    let mut all = carry_marks(&top.op, &marks);
                    all.extend(top.marks.iter().copied());
                    Some(Entry { op: c, marks: all })
                })
                .map(|c| {
                    *self.undo.last_mut().expect("top exists") = c;
                })
                .is_some();
        if !merged {
            self.undo.push(Entry { op: inverse, marks });
            if self.undo.len() > MAX_ENTRIES {
                self.undo.remove(0);
            }
        }
        self.group = match shape.kind {
            Kind::Insert if !shape.has_newline => Some(Group {
                kind: Kind::Insert,
                next: shape.start + shape.inserted,
                class: shape.class,
            }),
            Kind::Backspace => Some(Group {
                kind: Kind::Backspace,
                next: shape.start,
                class: Class::Other,
            }),
            Kind::DeleteForward => Some(Group {
                kind: Kind::DeleteForward,
                next: shape.start,
                class: Class::Other,
            }),
            _ => None,
        };
    }

    /// End the open typing group; the next edit starts a new entry.
    pub fn close_group(&mut self) {
        self.group = None;
    }

    pub fn pop_undo(&mut self) -> Option<Entry> {
        self.group = None;
        self.undo.pop()
    }

    pub fn pop_redo(&mut self) -> Option<Entry> {
        self.group = None;
        self.redo.pop()
    }

    pub fn push_redo(&mut self, op: OperationSeq, marks: Vec<AtomicRange>) {
        self.redo.push(Entry { op, marks });
    }

    /// An undo entry made by a redo: does not clear the redo stack.
    pub fn push_undo(&mut self, op: OperationSeq, marks: Vec<AtomicRange>) {
        self.undo.push(Entry { op, marks });
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.group = None;
    }

    /// Keep every entry applicable after `remote` changed the current text.
    /// The remote change is not an entry and cannot be undone from here.
    pub fn transform_past(&mut self, remote: &OperationSeq) {
        self.group = None;
        transform_stack(&mut self.undo, remote);
        transform_stack(&mut self.redo, remote);
    }
}

/// `marks` lie in the text `op` applies to; where they lie in the text it
/// produces. A mark `op` edits inside is dropped.
fn carry_marks(op: &OperationSeq, marks: &[AtomicRange]) -> Vec<AtomicRange> {
    marks
        .iter()
        .filter(|m| !touches_interior(op, m.start, m.end))
        .map(|m| AtomicRange {
            id: m.id,
            start: map_pos(op, m.start, Bias::After),
            end: map_pos(op, m.end, Bias::Before),
        })
        .collect()
}

/// Entries are chained: the top applies to the current text, the next to the
/// text the top produces, and so on. `remote` applies to the current text.
fn transform_stack(stack: &mut Vec<Entry>, remote: &OperationSeq) {
    let mut carried = remote.clone();
    for entry in stack.iter_mut().rev() {
        match carried.transform(&entry.op) {
            Ok((after_entry, entry_after_remote)) => {
                entry.op = entry_after_remote;
                // The marks lie in the text the entry produces, which
                // `after_entry` applies to.
                entry.marks = carry_marks(&after_entry, &entry.marks);
                carried = after_entry;
            }
            Err(_) => {
                // Lengths no longer chain; an unusable stack is dropped rather than misapplied.
                stack.clear();
                return;
            }
        }
    }
    stack.retain(|e| !e.is_noop());
}
