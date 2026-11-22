//! Text changes and the operations behind them.
//!
//! Internally every change to the text is an `operational_transform::OperationSeq`
//! counted in Unicode scalars, the same model as the document owner's wire
//! format (`ot-text-unicode`). This module converts between that and the two
//! public change shapes, and holds the few operations the OT crate lacks for a
//! rope: apply to a `Rope`, invert against a `Rope`, and map a position.

use crate::coords::{Coords, Snap, Unit};
use operational_transform::{Operation, OperationSeq};
use ropey::Rope;
use serde::{Deserialize, Serialize};

/// One replacement in UTF-16 code units: the SDK's `TextChange`. A set of
/// changes is always against the text before the whole set, sorted and not
/// overlapping.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextChange {
    pub start: usize,
    pub end: usize,
    pub insert: String,
}

/// One replacement in Unicode scalar offsets: the wire form of a document edit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScalarChange {
    pub start: usize,
    pub end: usize,
    pub insert: String,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ChangeError {
    #[error("change {index} reaches past the end of the text")]
    OutOfRange { index: usize },
    #[error("change {index} starts after it ends, or overlaps the change before it")]
    Unordered { index: usize },
    #[error("change {index} starts or ends inside a character")]
    SplitScalar { index: usize },
}

impl TextChange {
    pub fn new(start: usize, end: usize, insert: impl Into<String>) -> Self {
        Self {
            start,
            end,
            insert: insert.into(),
        }
    }
}

impl ScalarChange {
    pub fn new(start: usize, end: usize, insert: impl Into<String>) -> Self {
        Self {
            start,
            end,
            insert: insert.into(),
        }
    }
}

/// Build an operation from changes in `unit`, validated against `rope` (the text before the set).
/// A boundary inside a scalar is an error, never snapped: an external owner
/// that sends one has a bug the session must not paper over.
pub(crate) fn op_from_changes(
    rope: &Rope,
    changes: impl IntoIterator<Item = (usize, usize, String)>,
    unit: Unit,
) -> Result<OperationSeq, ChangeError> {
    let coords = Coords::new(rope);
    let mut op = OperationSeq::default();
    let mut at = 0usize;
    for (index, (start, end, insert)) in changes.into_iter().enumerate() {
        if start > end {
            return Err(ChangeError::Unordered { index });
        }
        let to_scalar = |off: usize| -> Result<usize, ChangeError> {
            let back = coords
                .to_scalar(off, unit, Snap::Backward)
                .ok_or(ChangeError::OutOfRange { index })?;
            if coords.from_scalar(back, unit) != Some(off) {
                return Err(ChangeError::SplitScalar { index });
            }
            Ok(back)
        };
        let (s, e) = (to_scalar(start)?, to_scalar(end)?);
        if s < at {
            return Err(ChangeError::Unordered { index });
        }
        op.retain((s - at) as u64);
        op.delete((e - s) as u64);
        op.insert(&insert);
        at = e;
    }
    op.retain((rope.len_chars() - at) as u64);
    Ok(op)
}

/// The changes an operation makes, as scalar triples against the text before it.
pub(crate) fn op_scalar_edits(op: &OperationSeq) -> Vec<(usize, usize, String)> {
    let mut out: Vec<(usize, usize, String)> = Vec::new();
    let mut pos = 0usize;
    let mut open = false;
    for comp in op.ops() {
        match comp {
            Operation::Retain(n) => {
                open = false;
                pos += *n as usize;
            }
            Operation::Delete(n) => {
                if !open {
                    out.push((pos, pos, String::new()));
                    open = true;
                }
                pos += *n as usize;
                out.last_mut().expect("open edit").1 = pos;
            }
            Operation::Insert(s) => {
                if !open {
                    out.push((pos, pos, String::new()));
                    open = true;
                }
                out.last_mut().expect("open edit").2.push_str(s);
            }
        }
    }
    out
}

/// `op` as UTF-16 changes against `before`.
pub(crate) fn op_to_text_changes(before: &Rope, op: &OperationSeq) -> Vec<TextChange> {
    let c = Coords::new(before);
    op_scalar_edits(op)
        .into_iter()
        .map(|(s, e, insert)| TextChange {
            start: c.from_scalar(s, Unit::Utf16).unwrap_or(0),
            end: c.from_scalar(e, Unit::Utf16).unwrap_or(0),
            insert,
        })
        .collect()
}

/// `op` as scalar changes.
pub(crate) fn op_to_scalar_changes(op: &OperationSeq) -> Vec<ScalarChange> {
    op_scalar_edits(op)
        .into_iter()
        .map(|(start, end, insert)| ScalarChange { start, end, insert })
        .collect()
}

/// Apply `op` to `rope` in place. The rope is untouched on a length mismatch.
pub(crate) fn apply_op(rope: &mut Rope, op: &OperationSeq) -> Result<(), ChangeError> {
    if op.base_len() != rope.len_chars() {
        return Err(ChangeError::OutOfRange { index: 0 });
    }
    let mut pos = 0usize;
    for comp in op.ops() {
        match comp {
            Operation::Retain(n) => pos += *n as usize,
            Operation::Delete(n) => rope.remove(pos..pos + *n as usize),
            Operation::Insert(s) => {
                rope.insert(pos, s);
                pos += s.chars().count();
            }
        }
    }
    Ok(())
}

/// The operation that undoes `op`, which applies to `before`.
pub(crate) fn invert_op(op: &OperationSeq, before: &Rope) -> OperationSeq {
    let mut inv = OperationSeq::default();
    let mut pos = 0usize;
    for comp in op.ops() {
        match comp {
            Operation::Retain(n) => {
                inv.retain(*n);
                pos += *n as usize;
            }
            Operation::Delete(n) => {
                inv.insert(&before.slice(pos..pos + *n as usize).to_string());
                pos += *n as usize;
            }
            Operation::Insert(s) => inv.delete(s.chars().count() as u64),
        }
    }
    inv
}

/// Which side of an insertion exactly at a position the position ends up on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Bias {
    /// Stay before text inserted at the position.
    Before,
    /// Move after text inserted at the position.
    After,
}

/// Where position `pos` (in the text `op` applies to) lands in the text after `op`.
/// Positions inside deleted text collapse to just after what replaced it.
pub(crate) fn map_pos(op: &OperationSeq, pos: usize, bias: Bias) -> usize {
    let (mut i, mut j) = (0usize, 0usize);
    for comp in op.ops() {
        match comp {
            Operation::Insert(s) => {
                if pos == i && bias == Bias::Before {
                    return j;
                }
                j += s.chars().count();
            }
            Operation::Retain(n) => {
                let n = *n as usize;
                if pos < i + n {
                    return j + (pos - i);
                }
                i += n;
                j += n;
            }
            Operation::Delete(n) => {
                let n = *n as usize;
                if pos < i + n {
                    return j;
                }
                i += n;
            }
        }
    }
    j + pos.saturating_sub(i)
}

/// True when `op` deletes any of `[start, end)` or inserts strictly inside it.
pub(crate) fn touches_interior(op: &OperationSeq, start: usize, end: usize) -> bool {
    let mut i = 0usize;
    for comp in op.ops() {
        match comp {
            Operation::Retain(n) => i += *n as usize,
            Operation::Delete(n) => {
                let n = *n as usize;
                if i < end && i + n > start {
                    return true;
                }
                i += n;
            }
            Operation::Insert(_) => {
                if i > start && i < end {
                    return true;
                }
            }
        }
    }
    false
}

/// The single operation that turns `old` into `new` by replacing what is
/// between their common prefix and common suffix. Used to bring a draft or a
/// resolved conflict onto the text, not to track edits.
pub(crate) fn diff_op(old: &Rope, new: &Rope) -> OperationSeq {
    let (a, b) = (old.len_chars(), new.len_chars());
    let max = a.min(b);
    let mut prefix = 0;
    {
        let (mut x, mut y) = (old.chars(), new.chars());
        while prefix < max && x.next() == y.next() {
            prefix += 1;
        }
    }
    let mut suffix = 0;
    {
        let (mut x, mut y) = (old.chars_at(a), new.chars_at(b));
        while suffix < max - prefix && x.prev() == y.prev() {
            suffix += 1;
        }
    }
    let mut op = OperationSeq::default();
    op.retain(prefix as u64);
    op.delete((a - prefix - suffix) as u64);
    op.insert(&new.slice(prefix..b - suffix).to_string());
    op.retain(suffix as u64);
    op
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rope(s: &str) -> Rope {
        Rope::from_str(s)
    }

    #[test]
    fn utf16_changes_become_scalar_ops_and_back() {
        let before = rope("a\u{1F600}bc");
        // Replace "b" (UTF-16 units 3..4) with "XY".
        let op = op_from_changes(&before, [(3, 4, "XY".to_string())], Unit::Utf16).unwrap();
        let mut after = before.clone();
        apply_op(&mut after, &op).unwrap();
        assert_eq!(after.to_string(), "a\u{1F600}XYc");
        assert_eq!(
            op_to_text_changes(&before, &op),
            vec![TextChange::new(3, 4, "XY")]
        );
        assert_eq!(
            op_to_scalar_changes(&op),
            vec![ScalarChange::new(2, 3, "XY")]
        );
    }

    #[test]
    fn a_boundary_inside_a_surrogate_pair_is_refused() {
        let before = rope("a\u{1F600}b");
        let err = op_from_changes(&before, [(2, 2, "x".to_string())], Unit::Utf16).unwrap_err();
        assert_eq!(err, ChangeError::SplitScalar { index: 0 });
        let err = op_from_changes(&before, [(0, 99, String::new())], Unit::Utf16).unwrap_err();
        assert_eq!(err, ChangeError::OutOfRange { index: 0 });
        let err = op_from_changes(
            &before,
            [(2, 3, String::new()), (0, 1, String::new())],
            Unit::Scalar,
        )
        .unwrap_err();
        assert_eq!(err, ChangeError::Unordered { index: 1 });
    }

    #[test]
    fn invert_restores_the_text() {
        let before = rope("hello world");
        let op = op_from_changes(&before, [(0, 5, "bye".to_string())], Unit::Scalar).unwrap();
        let mut after = before.clone();
        apply_op(&mut after, &op).unwrap();
        let inv = invert_op(&op, &before);
        apply_op(&mut after, &inv).unwrap();
        assert_eq!(after.to_string(), "hello world");
    }

    #[test]
    fn map_pos_respects_bias_and_deletions() {
        let before = rope("abcdef");
        let ins = op_from_changes(&before, [(3, 3, "XX".to_string())], Unit::Scalar).unwrap();
        assert_eq!(map_pos(&ins, 3, Bias::Before), 3);
        assert_eq!(map_pos(&ins, 3, Bias::After), 5);
        assert_eq!(map_pos(&ins, 2, Bias::After), 2);
        assert_eq!(map_pos(&ins, 4, Bias::Before), 6);
        let del = op_from_changes(&before, [(1, 4, String::new())], Unit::Scalar).unwrap();
        assert_eq!(map_pos(&del, 2, Bias::Before), 1);
        assert_eq!(map_pos(&del, 4, Bias::Before), 1);
        assert_eq!(map_pos(&del, 6, Bias::Before), 3);
    }

    #[test]
    fn diff_op_replaces_the_middle_only() {
        let (a, b) = (rope("one two three"), rope("one 2 three"));
        let op = diff_op(&a, &b);
        assert_eq!(op_scalar_edits(&op), vec![(4, 7, "2".to_string())]);
        let same = diff_op(&a, &a);
        assert!(op_scalar_edits(&same).is_empty());
    }
}
