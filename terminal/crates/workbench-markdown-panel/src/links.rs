//! What the document's syntax tree says about links, task boxes and where a
//! link points. The tree is the Markdown model's (`markdown_tree`); nothing
//! here parses Markdown. Every range is in UTF-8 bytes of the text read.

use std::collections::BTreeMap;
use std::ops::Range;

use github_slugger::Slugger;
use percent_encoding::percent_decode_str;
use theorem_workbench_markdown::{markdown_tree, mdast};
use theorem_workbench_text::{Coords, LineCol, Snap, Unit};

/// A link in the text, inline or by reference, with the address it resolves to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkRef {
    pub range: Range<usize>,
    pub url: String,
}

/// A task box: `[ ]` or `[x]` at the start of a list item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TaskBox {
    /// The byte between the brackets, the one a toggle replaces.
    pub mark: usize,
    pub checked: bool,
}

#[derive(Default)]
struct Found {
    links: Vec<LinkRef>,
    tasks: Vec<TaskBox>,
    definitions: BTreeMap<String, String>,
    /// References to settle once every definition is known.
    references: Vec<(Range<usize>, String)>,
}

fn walk(text: &str, node: &mdast::Node, out: &mut Found) {
    match node {
        mdast::Node::Link(link) => out.links.push(LinkRef {
            range: link.position.clone(),
            url: link.url.clone(),
        }),
        mdast::Node::LinkReference(r) => out
            .references
            .push((r.position.clone(), r.identifier.clone())),
        mdast::Node::Definition(d) => {
            out.definitions
                .entry(d.identifier.to_lowercase())
                .or_insert_with(|| d.url.clone());
        }
        mdast::Node::ListItem(item) if item.checked.is_some() => {
            let start = item.position.start;
            if let Some(source) = text.get(item.position.clone())
                && let Some(open) = source.find('[')
                // The box is the first thing after the list marker.
                && open <= 12
                && source[..open]
                    .chars()
                    .all(|c| c.is_whitespace() || "-*+>0123456789.)".contains(c))
                && source.is_char_boundary(open + 1)
                && source.get(open + 2..open + 3) == Some("]")
                && let Some(mark) = source.get(open + 1..open + 2)
                && matches!(mark, " " | "x" | "X")
            {
                out.tasks.push(TaskBox {
                    mark: start + open + 1,
                    checked: mark != " ",
                });
            }
        }
        _ => {}
    }
    for child in node.children().into_iter().flatten() {
        walk(text, child, out);
    }
}

fn read(text: &str) -> Found {
    let mut found = Found::default();
    walk(text, &markdown_tree(text), &mut found);
    for (range, identifier) in std::mem::take(&mut found.references) {
        if let Some(url) = found.definitions.get(&identifier.to_lowercase()) {
            found.links.push(LinkRef {
                range,
                url: url.clone(),
            });
        }
    }
    found.links.sort_by_key(|l| l.range.start);
    found.tasks.sort_by_key(|t| t.mark);
    found
}

/// Every link of `text`, in source order. A reference whose definition does
/// not exist is not a link.
pub fn links(text: &str) -> Vec<LinkRef> {
    read(text).links
}

/// Every task box of `text`, in source order.
pub fn tasks(text: &str) -> Vec<TaskBox> {
    read(text).tasks
}

/// The text of a node, without its markup.
fn plain(node: &mdast::Node) -> String {
    match node {
        mdast::Node::Text(t) => t.value.clone(),
        mdast::Node::InlineCode(c) => c.value.clone(),
        other => other.children().into_iter().flatten().map(plain).collect(),
    }
}

/// The byte where the heading whose anchor is `fragment` starts, anchors made
/// as GitHub makes them.
pub fn heading_start(text: &str, fragment: &str) -> Option<usize> {
    fn walk(node: &mdast::Node, slugger: &mut Slugger, want: &str, out: &mut Option<usize>) {
        if out.is_some() {
            return;
        }
        if let mdast::Node::Heading(h) = node
            && slugger.slug(&plain(node)) == want
        {
            *out = Some(h.position.start);
            return;
        }
        for child in node.children().into_iter().flatten() {
            walk(child, slugger, want, out);
        }
    }
    let want = percent_decode_str(fragment)
        .decode_utf8_lossy()
        .to_lowercase();
    let mut found = None;
    walk(
        &markdown_tree(text),
        &mut Slugger::default(),
        &want,
        &mut found,
    );
    found
}

/// Where a link points, once read against the document it is in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// Has a scheme or is protocol-relative. Nothing opens it automatically:
    /// the panel shows it and stops.
    Remote(String),
    /// A path of the workspace, from its root, without the fragment.
    Workspace {
        path: String,
        fragment: Option<String>,
    },
    /// A place in this document.
    Fragment(String),
    /// Names a place outside the workspace, or nothing.
    Refused(String),
}

fn has_scheme(url: &str) -> bool {
    let Some((scheme, _)) = url.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
}

/// Read `url`, written in the document at `from` (a workspace path).
pub fn classify(from: &str, url: &str) -> Target {
    let url = url.trim();
    if url.is_empty() {
        return Target::Refused("The link has no address.".to_owned());
    }
    if url.starts_with("//") || has_scheme(url) {
        return Target::Remote(url.to_owned());
    }
    let (location, fragment) = match url.split_once('#') {
        Some((l, f)) => (l, Some(f.to_owned())),
        None => (url, None),
    };
    let location = location.split_once('?').map_or(location, |(l, _)| l);
    if location.is_empty() {
        return match fragment {
            Some(f) => Target::Fragment(f),
            None => Target::Refused("The link has no address.".to_owned()),
        };
    }
    let decoded = percent_decode_str(location).decode_utf8_lossy();
    let mut parts: Vec<&str> = if decoded.starts_with('/') {
        vec![]
    } else {
        let mut base: Vec<&str> = from.split('/').filter(|p| !p.is_empty()).collect();
        base.pop();
        base
    };
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Target::Refused(format!("\"{url}\" leads out of the workspace."));
                }
            }
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        return Target::Refused(format!("\"{url}\" names the workspace root, not a file."));
    }
    Target::Workspace {
        path: parts.join("/"),
        fragment,
    }
}

/// The scalar offset of `line` and `column` (from 1; the column in UTF-16
/// units, as `PanelMsg::Reveal` counts), clamped to the end of the line it
/// names and to the end of the text.
pub fn reveal_offset(coords: &Coords, line: u32, column: u32) -> usize {
    let last = coords.line_count().saturating_sub(1);
    let line = (line.max(1) as usize - 1).min(last);
    let col = column.saturating_sub(1) as usize;
    let utf16 = coords
        .offset_of(LineCol { line, col }, Unit::Utf16, Snap::Backward)
        .and_then(|u| coords.to_scalar(u, Unit::Utf16, Snap::Backward));
    match utf16 {
        Some(scalar) => scalar,
        None => coords.line_range(line).map_or(0, |(_, end)| end),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ropey::Rope;

    #[test]
    fn inline_and_reference_links_and_task_boxes_are_found_in_order() {
        let text = "- [ ] one [a](x.md)\n- [x] two\n\nsee [b][r]\n\n[r]: ../y.md\n";
        let found = links(text);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].url, "x.md");
        assert_eq!(found[1].url, "../y.md");
        let boxes = tasks(text);
        assert_eq!(boxes.len(), 2);
        assert_eq!(&text[boxes[0].mark..boxes[0].mark + 1], " ");
        assert!(!boxes[0].checked && boxes[1].checked);
    }

    #[test]
    fn a_target_is_remote_a_workspace_path_a_fragment_or_refused() {
        assert_eq!(
            classify("docs/a.md", "https://example.com/x"),
            Target::Remote("https://example.com/x".into())
        );
        assert!(matches!(
            classify("a.md", "//cdn.example/x"),
            Target::Remote(_)
        ));
        assert_eq!(
            classify("docs/a.md", "../b%20c.md#top"),
            Target::Workspace {
                path: "b c.md".into(),
                fragment: Some("top".into())
            }
        );
        assert_eq!(
            classify("docs/a.md", "/readme.md"),
            Target::Workspace {
                path: "readme.md".into(),
                fragment: None
            }
        );
        assert_eq!(classify("a.md", "#intro"), Target::Fragment("intro".into()));
        assert!(matches!(classify("a.md", "../../x.md"), Target::Refused(_)));
        assert!(matches!(classify("a.md", ""), Target::Refused(_)));
    }

    #[test]
    fn a_fragment_finds_its_heading_with_duplicates_numbered() {
        let text = "# Intro\n\ntext\n\n## Details here\n\n## Details here\n";
        assert_eq!(heading_start(text, "intro"), Some(0));
        assert_eq!(
            heading_start(text, "details-here"),
            Some(text.find("## Details").unwrap())
        );
        assert_eq!(
            heading_start(text, "details-here-1"),
            Some(text.rfind("## Details").unwrap())
        );
        assert_eq!(heading_start(text, "nope"), None);
    }

    #[test]
    fn a_reveal_column_counts_utf16_units_and_stays_on_its_line() {
        let rope = Rope::from_str("ab\nx\u{1F600}yz\nlast");
        let coords = Coords::new(&rope);
        assert_eq!(reveal_offset(&coords, 1, 1), 0);
        assert_eq!(reveal_offset(&coords, 2, 1), 3);
        // The emoji is two UTF-16 units and one scalar.
        assert_eq!(reveal_offset(&coords, 2, 4), 5);
        assert_eq!(reveal_offset(&coords, 2, 99), 7, "clamped to the line end");
        assert_eq!(
            reveal_offset(&coords, 99, 1),
            8,
            "past the end: the last line"
        );
    }
}
