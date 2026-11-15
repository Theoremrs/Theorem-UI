//! Property tests: coordinate round trips, grapheme safety, the line index
//! under edits, and convergence of several editing sessions through an owner.

use operational_transform::{Operation, OperationSeq};
use proptest::prelude::*;
use ropey::Rope;
use std::collections::VecDeque;
use theorem_workbench_text::{
    Coords, Deletion, EditSession, LineCol, LocalEdit, Motion, OpId, ScalarChange, SessionConfig,
    Snap, Unit,
};
use unicode_segmentation::UnicodeSegmentation;

const FRAGMENTS: &[&str] = &[
    "a",
    "b",
    "z",
    " ",
    "  ",
    "\t",
    "\n",
    "\r\n",
    "\r",
    "\u{e9}",
    "e\u{301}",
    "e\u{301}\u{302}",
    "\u{1F600}",
    "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
    "\u{1F1FA}\u{1F1F8}",
    "\u{1F44D}\u{1F3FD}",
    "\u{4e2d}",
    "\u{6587}\u{5b57}",
    "\u{5e9}\u{5dc}\u{5d5}\u{5dd}",
    "\u{627}\u{644}\u{639}\u{631}\u{628}\u{64a}\u{629}",
    "\u{200b}",
    "\u{1100}\u{1161}\u{11a8}",
    "word",
    "Hello,",
];

fn fragment() -> impl Strategy<Value = &'static str> {
    prop::sample::select(FRAGMENTS)
}

fn text(max: usize) -> impl Strategy<Value = String> {
    prop::collection::vec(fragment(), 0..max).prop_map(|v| v.concat())
}

fn scalar_len(s: &str) -> usize {
    s.chars().count()
}

/// Scalar offsets that the Unicode standard puts between two clusters.
fn oracle_boundaries(s: &str) -> Vec<usize> {
    let mut out: Vec<usize> = s
        .grapheme_indices(true)
        .map(|(b, _)| scalar_len(&s[..b]))
        .collect();
    out.push(scalar_len(s));
    out
}

// ---- coordinates ----

fn check_units(s: &str) {
    let rope = Rope::from_str(s);
    let c = Coords::new(&rope);
    let n = scalar_len(s);
    assert_eq!(c.len(Unit::Utf8), s.len());
    assert_eq!(c.len(Unit::Utf16), s.encode_utf16().count());
    assert_eq!(c.len(Unit::Scalar), n);
    for (scalar, (byte, _)) in s
        .char_indices()
        .chain(std::iter::once((s.len(), ' ')))
        .enumerate()
    {
        let u16 = s[..byte].encode_utf16().count();
        assert_eq!(c.from_scalar(scalar, Unit::Utf8), Some(byte));
        assert_eq!(c.from_scalar(scalar, Unit::Utf16), Some(u16));
        assert_eq!(c.to_scalar(byte, Unit::Utf8, Snap::Backward), Some(scalar));
        assert_eq!(c.to_scalar(u16, Unit::Utf16, Snap::Forward), Some(scalar));
        assert_eq!(
            c.convert(byte, Unit::Utf8, Unit::Utf16, Snap::Nearest),
            Some(u16)
        );
        assert_eq!(
            c.convert(u16, Unit::Utf16, Unit::Utf8, Snap::Nearest),
            Some(byte)
        );
    }
    assert_eq!(c.to_scalar(s.len() + 1, Unit::Utf8, Snap::Backward), None);
}

fn check_snapping(s: &str) {
    let rope = Rope::from_str(s);
    let c = Coords::new(&rope);
    let starts8: Vec<usize> = s.char_indices().map(|(b, _)| b).chain([s.len()]).collect();
    for off in 0..=s.len() {
        let back = c
            .convert(off, Unit::Utf8, Unit::Utf8, Snap::Backward)
            .unwrap();
        let fwd = c
            .convert(off, Unit::Utf8, Unit::Utf8, Snap::Forward)
            .unwrap();
        let near = c
            .convert(off, Unit::Utf8, Unit::Utf8, Snap::Nearest)
            .unwrap();
        assert!(s.is_char_boundary(back) && s.is_char_boundary(fwd) && s.is_char_boundary(near));
        assert!(back <= off && off <= fwd);
        assert!(near == back || near == fwd);
        if starts8.contains(&off) {
            assert_eq!((back, fwd, near), (off, off, off));
        }
    }
    let mut starts16 = vec![0usize];
    for ch in s.chars() {
        starts16.push(starts16.last().unwrap() + ch.len_utf16());
    }
    for off in 0..=s.encode_utf16().count() {
        for snap in [Snap::Backward, Snap::Forward, Snap::Nearest] {
            let got = c.convert(off, Unit::Utf16, Unit::Utf16, snap).unwrap();
            assert!(
                starts16.contains(&got),
                "{off} snapped to {got}, inside a surrogate pair"
            );
            if snap == Snap::Backward {
                assert!(got <= off);
            }
            if snap == Snap::Forward {
                assert!(got >= off);
            }
        }
    }
}

fn check_graphemes(s: &str) {
    let rope = Rope::from_str(s);
    let c = Coords::new(&rope);
    let n = scalar_len(s);
    let bounds = oracle_boundaries(s);
    for at in 0..=n {
        let is = bounds.contains(&at);
        assert_eq!(c.is_grapheme_boundary(at), is, "boundary at {at} in {s:?}");
        let back = *bounds.iter().rev().find(|b| **b <= at).unwrap();
        let fwd = *bounds.iter().find(|b| **b >= at).unwrap();
        assert_eq!(c.snap_grapheme(at, Snap::Backward), back);
        assert_eq!(c.snap_grapheme(at, Snap::Forward), fwd);
        let near = c.snap_grapheme(at, Snap::Nearest);
        assert!(near == back || near == fwd);
    }
    for (i, w) in bounds.windows(2).enumerate() {
        assert_eq!(c.next_grapheme(w[0]), w[1]);
        assert_eq!(c.prev_grapheme(w[1]), w[0]);
        assert_eq!(c.grapheme_index(w[0]), i);
        assert_eq!(c.grapheme_offset(i), Some(w[0]));
        // A conversion to a grapheme boundary lands on one, in any unit.
        let mid8 = c.from_scalar(w[0], Unit::Utf8).unwrap();
        let out = c
            .convert_to_grapheme(mid8, Unit::Utf8, Unit::Scalar, Snap::Forward)
            .unwrap();
        assert_eq!(out, w[0]);
    }
    assert_eq!(c.next_grapheme(n), n);
    assert_eq!(c.prev_grapheme(0), 0);
    assert_eq!(c.grapheme_offset(bounds.len() - 1), Some(n));
    assert_eq!(c.grapheme_offset(bounds.len()), None);
    // Converting any offset with a grapheme snap never lands inside a cluster.
    for off in 0..=s.len() {
        for snap in [Snap::Backward, Snap::Forward, Snap::Nearest] {
            let got = c
                .convert_to_grapheme(off, Unit::Utf8, Unit::Scalar, snap)
                .unwrap();
            assert!(bounds.contains(&got));
        }
    }
}

/// Lines the way the editor counts them: LF, CRLF and CR end a line.
fn naive_lines(s: &str) -> Vec<(usize, usize)> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let (mut start, mut i) = (0usize, 0usize);
    while i < chars.len() {
        match chars[i] {
            '\n' => {
                out.push((start, i));
                start = i + 1;
            }
            '\r' => {
                out.push((start, i));
                if chars.get(i + 1) == Some(&'\n') {
                    i += 1;
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push((start, chars.len()));
    out
}

fn check_lines(s: &str) {
    let rope = Rope::from_str(s);
    let c = Coords::new(&rope);
    let lines = naive_lines(s);
    assert_eq!(c.line_count(), lines.len(), "{s:?}");
    for (i, &(a, b)) in lines.iter().enumerate() {
        assert_eq!(c.line_range(i), Some((a, b)));
    }
    assert_eq!(c.line_range(lines.len()), None);
    for unit in [Unit::Utf8, Unit::Utf16, Unit::Scalar] {
        for at in oracle_boundaries(s) {
            let off = c.from_scalar(at, unit).unwrap();
            let lc = c.line_col(off, unit).unwrap();
            assert_eq!(lc.line, lines.iter().rposition(|&(a, _)| a <= at).unwrap());
            assert_eq!(
                c.offset_of(lc, unit, Snap::Backward),
                Some(off),
                "{s:?} at {at} in {unit:?}"
            );
        }
    }
    assert_eq!(
        c.offset_of(
            LineCol {
                line: lines.len(),
                col: 0
            },
            Unit::Scalar,
            Snap::Backward
        ),
        None
    );
}

fn check_cells(s: &str) {
    let rope = Rope::from_str(s);
    let c = Coords::new(&rope);
    let bounds = oracle_boundaries(s);
    let mut last = 0;
    for &at in &bounds {
        let w = c.cells_between(0, at, 4);
        assert!(w >= last);
        last = w;
        // The offset found for a cell column is a boundary at or before that column.
        let found = c.offset_at_cell(0, scalar_len(s), w, 4, Snap::Backward);
        assert!(bounds.contains(&found));
        assert!(c.cells_between(0, found, 4) <= w);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(160))]

    #[test]
    fn units_round_trip(s in text(40)) { check_units(&s); }

    #[test]
    fn snapping_never_splits_a_scalar_or_pair(s in text(30)) { check_snapping(&s); }

    #[test]
    fn graphemes_match_the_standard(s in text(40)) { check_graphemes(&s); }

    #[test]
    fn lines_match_a_naive_split_in_every_unit(s in text(40)) { check_lines(&s); }

    #[test]
    fn cells_grow_with_the_text(s in text(40)) { check_cells(&s); }
}

proptest! {
    // Long texts cross the rope's internal chunk boundaries.
    #![proptest_config(ProptestConfig::with_cases(12))]

    #[test]
    fn long_texts_cross_chunk_boundaries(s in text(900)) {
        check_units(&s);
        check_graphemes(&s);
        check_lines(&s);
    }
}

// ---- one session under random edits ----

#[derive(Clone, Debug)]
enum Act {
    Type(&'static str),
    Newline,
    Backspace,
    DeleteForward,
    WordBack,
    Move(u8, bool),
    Select(usize, usize),
    SelectAll,
    Undo,
    Redo,
    BreakGroup,
    Remote(usize, usize, &'static str),
    SendAndAck,
    Mark(usize, usize),
}

fn act() -> impl Strategy<Value = Act> {
    prop_oneof![
        4 => fragment().prop_map(Act::Type),
        1 => Just(Act::Newline),
        2 => Just(Act::Backspace),
        1 => Just(Act::DeleteForward),
        1 => Just(Act::WordBack),
        3 => (0u8..12, any::<bool>()).prop_map(|(m, e)| Act::Move(m, e)),
        1 => (any::<usize>(), any::<usize>()).prop_map(|(a, b)| Act::Select(a, b)),
        1 => Just(Act::SelectAll),
        2 => Just(Act::Undo),
        1 => Just(Act::Redo),
        1 => Just(Act::BreakGroup),
        3 => (any::<usize>(), any::<usize>(), fragment()).prop_map(|(a, b, t)| Act::Remote(a, b, t)),
        2 => Just(Act::SendAndAck),
        1 => (any::<usize>(), any::<usize>()).prop_map(|(a, b)| Act::Mark(a, b)),
    ]
}

fn motion(i: u8) -> Motion {
    [
        Motion::Left,
        Motion::Right,
        Motion::Up,
        Motion::Down,
        Motion::WordLeft,
        Motion::WordRight,
        Motion::LineStart,
        Motion::LineEnd,
        Motion::DocStart,
        Motion::DocEnd,
        Motion::PageUp,
        Motion::PageDown,
    ][i as usize % 12]
}

fn check_session(s: &EditSession) {
    assert_eq!(s.invariant_violation(), None);
    let text = s.text();
    let c = s.coords();
    assert_eq!(c.line_count(), naive_lines(&text).len());
    assert_eq!(c.len(Unit::Scalar), scalar_len(&text));
    assert!(
        c.is_grapheme_boundary(s.cursor()),
        "cursor inside a cluster in {text:?}"
    );
    if let Some((a, b)) = s.selection() {
        assert!(c.is_grapheme_boundary(a) && c.is_grapheme_boundary(b));
    }
    for a in s.atomics() {
        assert!(a.start < a.end && a.end <= c.len(Unit::Scalar));
    }
    assert_eq!(
        s.cursor_utf16(),
        c.from_scalar(s.cursor(), Unit::Utf16).unwrap()
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    #[test]
    fn a_session_stays_consistent_under_any_script(
        start in text(12),
        acts in prop::collection::vec(act(), 1..60),
    ) {
        let mut s = EditSession::new(&start, 1, SessionConfig::new("p"));
        s.set_viewport(12, 6);
        for a in acts {
            match a {
                Act::Type(t) => { let _ = s.insert_text(t); }
                Act::Newline => { let _ = s.insert_newline(); }
                Act::Backspace => { let _ = s.delete(Deletion::Backward); }
                Act::DeleteForward => { let _ = s.delete(Deletion::Forward); }
                Act::WordBack => { let _ = s.delete(Deletion::WordBackward); }
                Act::Move(m, e) => { s.move_cursor(motion(m), e); }
                Act::Select(x, y) => {
                    let n = s.len() + 1;
                    s.set_selection(x % n, y % n);
                }
                Act::SelectAll => s.select_all(),
                Act::Undo => { let _ = s.undo(); }
                Act::Redo => { let _ = s.redo(); }
                Act::BreakGroup => s.break_undo_group(),
                Act::Remote(x, y, t) => {
                    let accepted = s.accepted_text();
                    let n = scalar_len(&accepted) + 1;
                    let (a, b) = (x % n, y % n);
                    let (a, b) = (a.min(b), a.max(b));
                    let rev = s.accepted_revision() + 1;
                    s.apply_remote_scalars(&[ScalarChange::new(a, b, t)], rev).unwrap();
                }
                Act::SendAndAck => {
                    if let Some(e) = s.take_next_to_send() {
                        let rev = s.accepted_revision() + 1;
                        s.acknowledge(&e.op_id, rev).unwrap();
                    }
                }
                Act::Mark(x, y) => {
                    let n = s.len() + 1;
                    let (a, b) = (x % n, y % n);
                    let c = s.coords();
                    let (a, b) = (c.snap_grapheme(a.min(b), Snap::Backward), c.snap_grapheme(a.max(b), Snap::Backward));
                    if a < b { let _ = s.mark_atomic(a, b); }
                }
            }
            check_session(&s);
        }
        // Whatever happened, every edit still waiting is consistent with the owner's text.
        while let Some(e) = s.take_next_to_send() {
            let rev = s.accepted_revision() + 1;
            s.acknowledge(&e.op_id, rev).unwrap();
        }
        assert_eq!(s.accepted_text(), s.text());
    }
}

// ---- several sessions through an owner ----

/// A minimal document owner: applies each incoming edit after everything it
/// accepted since the edit's base revision, and the owner's changes win ties.
struct Owner {
    texts: Vec<String>,
    log: Vec<OperationSeq>,
}

fn op_from_scalar_changes(len: usize, changes: &[ScalarChange]) -> OperationSeq {
    let mut op = OperationSeq::default();
    let mut at = 0usize;
    for c in changes {
        if c.start > at {
            op.retain((c.start - at) as u64);
        }
        if c.end > c.start {
            op.delete((c.end - c.start) as u64);
        }
        if !c.insert.is_empty() {
            op.insert(&c.insert);
        }
        at = c.end;
    }
    if len > at {
        op.retain((len - at) as u64);
    }
    op
}

fn op_to_scalar_changes(op: &OperationSeq) -> Vec<ScalarChange> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    for o in op.ops() {
        match o {
            Operation::Retain(n) => pos += *n as usize,
            Operation::Delete(n) => {
                out.push(ScalarChange::new(pos, pos + *n as usize, ""));
                pos += *n as usize;
            }
            Operation::Insert(s) => out.push(ScalarChange::new(pos, pos, s.clone())),
        }
    }
    out
}

impl Owner {
    fn new(text: &str) -> Self {
        Owner {
            texts: vec![text.to_string()],
            log: Vec::new(),
        }
    }

    fn revision(&self) -> u64 {
        self.texts.len() as u64
    }

    /// Accept an edit made against `base` (a revision). Returns the change in
    /// terms of the owner's text before it, and the new revision.
    fn accept(&mut self, base: u64, changes: &[ScalarChange]) -> (Vec<ScalarChange>, u64) {
        let base_ix = (base - 1) as usize;
        let mut op = op_from_scalar_changes(scalar_len(&self.texts[base_ix]), changes);
        for logged in &self.log[base_ix..] {
            let (_, t) = logged.transform(&op).unwrap();
            op = t;
        }
        let next = op.apply(self.texts.last().unwrap()).unwrap();
        self.log.push(op.clone());
        self.texts.push(next);
        (op_to_scalar_changes(&op), self.revision())
    }
}

enum ToClient {
    Remote(Vec<ScalarChange>, u64),
    Ack(OpId, u64),
}

#[derive(Clone, Debug)]
enum Step {
    Edit(usize, u8, &'static str),
    Send(usize),
    Own(usize),
    Deliver(usize),
}

fn step(clients: usize) -> impl Strategy<Value = Step> {
    prop_oneof![
        5 => (0..clients, 0u8..8, fragment()).prop_map(|(c, k, t)| Step::Edit(c, k, t)),
        3 => (0..clients).prop_map(Step::Send),
        3 => (0..clients).prop_map(Step::Own),
        4 => (0..clients).prop_map(Step::Deliver),
    ]
}

fn edit_client(s: &mut EditSession, kind: u8, t: &str) {
    match kind {
        0..=2 => {
            let _ = s.insert_text(t);
        }
        3 => {
            let _ = s.delete(Deletion::Backward);
        }
        4 => {
            let _ = s.delete(Deletion::WordBackward);
        }
        5 => {
            let _ = s.undo();
        }
        6 => {
            s.move_cursor(Motion::Left, false);
            s.move_cursor(Motion::WordLeft, true);
        }
        _ => {
            s.move_cursor(Motion::DocStart, false);
        }
    }
}

fn run_convergence(initial: &str, clients: usize, steps: Vec<Step>) {
    let mut owner = Owner::new(initial);
    let mut sessions: Vec<EditSession> = (0..clients)
        .map(|i| EditSession::new(initial, 1, SessionConfig::new(format!("c{i}"))))
        .collect();
    let mut up: Vec<VecDeque<LocalEdit>> = (0..clients).map(|_| VecDeque::new()).collect();
    let mut down: Vec<VecDeque<ToClient>> = (0..clients).map(|_| VecDeque::new()).collect();

    let do_step = |st: Step,
                   owner: &mut Owner,
                   sessions: &mut Vec<EditSession>,
                   up: &mut Vec<VecDeque<LocalEdit>>,
                   down: &mut Vec<VecDeque<ToClient>>| match st {
        Step::Edit(c, k, t) => edit_client(&mut sessions[c], k, t),
        Step::Send(c) => {
            if let Some(e) = sessions[c].take_next_to_send() {
                up[c].push_back(e);
            }
        }
        Step::Own(c) => {
            if let Some(e) = up[c].pop_front() {
                let (changes, rev) = owner.accept(e.base_revision, &e.wire);
                for (i, q) in down.iter_mut().enumerate() {
                    if i == c {
                        q.push_back(ToClient::Ack(e.op_id.clone(), rev));
                    } else {
                        q.push_back(ToClient::Remote(changes.clone(), rev));
                    }
                }
            }
        }
        Step::Deliver(c) => match down[c].pop_front() {
            Some(ToClient::Remote(changes, rev)) => {
                sessions[c].apply_remote_scalars(&changes, rev).unwrap();
            }
            Some(ToClient::Ack(id, rev)) => sessions[c].acknowledge(&id, rev).unwrap(),
            None => {}
        },
    };

    for st in steps {
        do_step(st, &mut owner, &mut sessions, &mut up, &mut down);
        for s in &sessions {
            assert_eq!(s.invariant_violation(), None);
        }
    }
    // Drain: everything sent, accepted and delivered.
    for _ in 0..10_000 {
        let mut idle = true;
        for c in 0..clients {
            if sessions[c].has_pending() || !up[c].is_empty() || !down[c].is_empty() {
                idle = false;
            }
            for st in [Step::Send(c), Step::Own(c), Step::Deliver(c)] {
                do_step(st, &mut owner, &mut sessions, &mut up, &mut down);
            }
        }
        if idle {
            break;
        }
    }
    let truth = owner.texts.last().unwrap();
    for (i, s) in sessions.iter().enumerate() {
        assert!(!s.has_pending(), "client {i} still has pending edits");
        assert_eq!(&s.text(), truth, "client {i} diverged");
        assert_eq!(&s.accepted_text(), truth);
        assert_eq!(s.accepted_revision(), owner.revision());
        assert_eq!(s.invariant_violation(), None);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    #[test]
    fn two_sessions_converge(initial in text(8), steps in prop::collection::vec(step(2), 1..120)) {
        run_convergence(&initial, 2, steps);
    }

    #[test]
    fn three_sessions_converge(initial in text(8), steps in prop::collection::vec(step(3), 1..160)) {
        run_convergence(&initial, 3, steps);
    }
}
