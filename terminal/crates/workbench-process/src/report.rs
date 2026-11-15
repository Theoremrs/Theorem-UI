//! What a program says about itself (R32), as the pane shows it.
//!
//! The program's word is shown as the program's word: every line begins with
//! who is speaking, it sits in its own band and its own semantic node apart
//! from the pane's lifecycle (the header), its notices (the footer) and the
//! lease role, and nothing here reads it as an action. Every character of it
//! is hostile: control and bidirectional characters are spelled out, rows are
//! bounded, and the terminal grid never changes size because of it.

use theorem_workbench_core::host::{ProgramReport, ProgramState, ProgramStatus};

use theorem_workbench_text::coords::grapheme_cells;
use theorem_workbench_text::visible::visible;
use unicode_segmentation::UnicodeSegmentation;

use crate::bound::Bound;
use crate::wrap::wrap;

/// The most rows the band may take in a pane; the rest is cut and marked.
pub(crate) const BAND_ROWS: u16 = 3;
/// The most Unicode scalars a semantic description keeps, the wire's bound
/// for one report text.
pub(crate) const DESCRIPTION_LIMIT: usize = 4096;
/// The most scalars a chooser row shows of a report.
const COMPACT_LIMIT: usize = 120;
const MORE: &str = "(more)";

fn state_word(state: ProgramState) -> &'static str {
    match state {
        ProgramState::Idle => "idle",
        ProgramState::Working => "working",
        ProgramState::Done => "done",
        ProgramState::Blocked => "blocked",
        ProgramState::Error => "error",
        ProgramState::Unknown => "an unrecognised state",
    }
}

/// The program's state and fields as one line of words, escaped. `unknown`
/// shows the program's own word in quotes, as its word.
fn status_words(s: &ProgramStatus) -> String {
    let mut parts = vec![match (&s.state, &s.raw_state) {
        (ProgramState::Unknown, Some(raw)) => {
            format!("its own word \"{}\"", visible(raw))
        }
        (state, _) => state_word(*state).to_owned(),
    }];
    for field in [&s.kind, &s.app, &s.title, &s.msg].into_iter().flatten() {
        parts.push(visible(field));
    }
    if let Some(progress) = s.progress {
        parts.push(format!("progress {progress}"));
    }
    parts.join(" \u{b7} ")
}

/// What the line says for a report, or None when the host says nothing.
/// `ended`: the program has exited or been lost, so a current report is its
/// last word and is labelled so.
pub(crate) fn line(report: &ProgramReport, ended: bool) -> Option<String> {
    match report {
        ProgramReport::Unavailable => None,
        ProgramReport::NeverReported => Some("Program has not reported a status".to_owned()),
        ProgramReport::Cleared { .. } => Some("Program withdrew its report".to_owned()),
        ProgramReport::Current { status, .. } => Some(format!(
            "{} {}",
            if ended {
                "Program's last report:"
            } else {
                "Program reports:"
            },
            status_words(status)
        )),
    }
}

/// The name of the semantic node: who is speaking.
pub(crate) fn node_name(ended: bool) -> &'static str {
    if ended {
        "Last status reported by the program itself (not workbench state)"
    } else {
        "Status reported by the program itself (not workbench state)"
    }
}

/// The node's description: the report's case and words, whole up to the
/// wire's bound for one text.
pub(crate) fn description(report: &ProgramReport) -> Option<String> {
    let text = match report {
        ProgramReport::Unavailable => return None,
        ProgramReport::NeverReported => {
            "never_reported: Program has not reported a status".to_owned()
        }
        ProgramReport::Cleared { .. } => "cleared: Program withdrew its report".to_owned(),
        ProgramReport::Current { status, .. } => format!("current: {}", status_words(status)),
    };
    Some(cut(&text, DESCRIPTION_LIMIT))
}

/// At most `limit` scalars, with the marker when something was cut.
fn cut(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let keep = limit.saturating_sub(MORE.len() + 1);
    let mut out: String = text.chars().take(keep).collect();
    out.push(' ');
    out.push_str(MORE);
    out
}

/// The line a chooser row adds for a session that is still running.
pub(crate) fn compact(report: &ProgramReport) -> Option<String> {
    line(report, false).map(|l| cut(&l, COMPACT_LIMIT))
}

/// The report as rows in `width` cells: at most `max_rows`, the last marked
/// `(more)` when the text was longer.
pub(crate) fn rows(text: &str, width: u16, max_rows: u16) -> Vec<String> {
    let mut rows = wrap(text, width);
    let max = usize::from(max_rows);
    if rows.len() <= max {
        return rows;
    }
    rows.truncate(max);
    if let Some(last) = rows.last_mut() {
        // Room for the marker in the row's cells; a row narrower than the
        // marker is the marker.
        let room = usize::from(width).saturating_sub(MORE.len() + 1);
        let mut kept = String::new();
        let mut used = 0usize;
        // By display cells and whole grapheme clusters, as the editors count
        // them: a combining mark takes none, a wide character two.
        for g in last.graphemes(true) {
            let w = grapheme_cells(g, 0, 4);
            if used + w > room {
                break;
            }
            used += w;
            kept.push_str(g);
        }
        *last = if kept.is_empty() {
            MORE.to_owned()
        } else {
            format!("{} {MORE}", kept.trim_end())
        };
    }
    rows
}

/// Where the band sits and what it says.
pub(crate) struct Band {
    pub rect: ratatui::layout::Rect,
    pub rows: Vec<String>,
}

/// The band for a live pane: directly above the footer's rows (or the pane's
/// bottom), under the header's rows, over the screen like the footer is, so
/// the grid keeps its size. None when the host says nothing or no row is left.
pub(crate) fn band(
    area: ratatui::layout::Rect,
    b: &Bound,
    head_rows: u16,
    bottom: u16,
) -> Option<Band> {
    let text = line(&b.report, b.status.program_ended())?;
    let top = area.y + head_rows;
    // At least one row of the screen stays visible.
    let room = bottom.saturating_sub(top).saturating_sub(1);
    let rows = rows(&text, area.width, BAND_ROWS.min(room));
    if rows.is_empty() || room == 0 {
        return None;
    }
    let n = u16::try_from(rows.len()).unwrap_or(u16::MAX);
    Some(Band {
        rect: ratatui::layout::Rect::new(area.x, bottom - n, area.width, n),
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::{cut, rows};
    use theorem_workbench_text::coords::grapheme_cells;
    use unicode_segmentation::UnicodeSegmentation;

    #[test]
    fn a_cut_text_ends_in_the_marker_and_stays_within_the_bound() {
        let c = cut(&"x".repeat(200), 50);
        assert_eq!(c.chars().count(), 50);
        assert!(c.ends_with("(more)"));
        assert_eq!(cut("short", 50), "short");
    }

    fn cells(row: &str) -> usize {
        row.graphemes(true).map(|g| grapheme_cells(g, 0, 4)).sum()
    }

    #[test]
    fn a_cut_row_is_counted_in_display_cells_not_characters() {
        // Narrow non-ASCII letters and a combining mark take one cell (none).
        let narrow = "\u{e9}t\u{e9} \u{e9}t\u{e9} e\u{301}e\u{301}e\u{301} \u{e9}t\u{e9} \u{e9}t\u{e9} e\u{301}e\u{301}e\u{301}";
        let r = rows(narrow, 14, 1);
        assert!(r[0].ends_with("(more)"), "{r:?}");
        assert!(cells(&r[0]) <= 14, "{r:?}");
        assert!(
            r[0].starts_with("\u{e9}t\u{e9} \u{e9}t\u{e9}"),
            "narrow letters were counted as two cells: {r:?}"
        );
        // A wide character takes two, and is never split to fit.
        let wide = "\u{65e5}\u{672c}\u{8a9e}\u{306e}\u{30d5}\u{30a1}\u{30a4}\u{30eb}\u{540d}\u{524d}\u{3092}\u{66f8}\u{304f}";
        for width in 8..16u16 {
            let r = rows(wide, width, 1);
            assert!(cells(&r[0]) <= usize::from(width), "{width}: {r:?}");
            assert!(r[0].ends_with("(more)"), "{r:?}");
        }
        let r = rows(wide, 11, 1);
        assert_eq!(r[0], "\u{65e5}\u{672c} (more)", "{r:?}");
    }

    #[test]
    fn rows_over_the_bound_are_cut_and_marked() {
        let text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
        let r = rows(text, 12, 3);
        assert_eq!(r.len(), 3);
        assert!(r[2].ends_with("(more)"), "{r:?}");
        assert!(r.iter().all(|row| row.chars().count() <= 12));
        assert_eq!(rows("one two", 12, 3), ["one two"]);
    }
}
