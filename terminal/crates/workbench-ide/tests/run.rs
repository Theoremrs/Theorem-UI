//! The Run output panel driven through a real root.

mod common;

use common::{WORKSPACE, agent, names, open, open_with};
use keybinds::{Key, Mods};
use ratatui::style::{Color, Style};
use serde_json::json;
use theorem_workbench_core::Theme;
use theorem_workbench_core::completion::{CompletionPayload, Outcome, RunStarted};
use theorem_workbench_core::effect::{Effect, EffectBody};
use theorem_workbench_core::host::HostMessage;
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::results::{ReadAt, RunState};
use theorem_workbench_ide::RunPanel;

const CAPS: [&str; 4] = ["files", "documents", "run.start", "run.subscribe"];

fn rig() -> common::Rig {
    open("run-output", &CAPS, WORKSPACE).0
}

fn state(
    rig: &common::Rig,
    word: &str,
    code: Option<i64>,
    out: &str,
    err: &str,
) -> CompletionPayload {
    CompletionPayload::RunState(RunState {
        handle: "h1".into(),
        state: word.into(),
        exit_code: code,
        stdout: out.into(),
        stderr: err.into(),
        read_at: ReadAt {
            workspace_id: WORKSPACE.into(),
            version: None,
            epoch: None,
            generation: rig.m.workspace().generation.0,
        },
    })
}

fn status(rig: &common::Rig) -> String {
    rig.node("status").name
}

/// Fills in the name and command and presses Enter. Returns the configure effect.
fn start_with_command(rig: &mut common::Rig) -> Vec<Effect> {
    rig.typed("build");
    rig.key(Key::Tab);
    rig.typed("cargo build --release -p \"my crate\"");
    rig.key(Key::Enter)
}

/// Starts run `h1`: configure, start, and the first poll answered as running.
fn running(rig: &mut common::Rig, out: &str) -> Vec<Effect> {
    let sent = start_with_command(rig);
    let fx = rig.answer(&sent[0], Outcome::Accepted, None);
    let fx = rig.accept(
        &fx[0],
        CompletionPayload::RunStarted(RunStarted {
            handle: "h1".into(),
        }),
    );
    let poll = fx[0].clone();
    rig.accept(&poll, state(rig, "running", None, out, ""))
}

#[test]
fn a_name_and_a_command_are_configured_then_started_then_read() {
    let mut rig = rig();
    let sent = start_with_command(&mut rig);
    assert_eq!(names(&sent), ["run configure"]);
    match &sent[0].body {
        EffectBody::RunConfigure(c) => {
            assert_eq!(c.name, "build");
            assert_eq!(c.argv, ["cargo", "build", "--release", "-p", "my crate"]);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(status(&rig), "Starting\u{2026}");
    let fx = rig.answer(&sent[0], Outcome::Accepted, None);
    assert_eq!(names(&fx), ["run start"]);
    let fx = rig.accept(
        &fx[0],
        CompletionPayload::RunStarted(RunStarted {
            handle: "h1".into(),
        }),
    );
    // The first read follows at once, before any tick.
    assert_eq!(names(&fx), ["run poll"]);
    match &fx[0].body {
        EffectBody::RunPoll(h) => assert_eq!(h.handle, "h1"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_empty_command_starts_the_run_already_configured_under_that_name() {
    let mut rig = rig();
    rig.typed("build");
    let sent = rig.key(Key::Enter);
    assert_eq!(names(&sent), ["run start"]);
}

#[test]
fn starting_with_no_name_or_an_unclosed_quote_sends_nothing_and_says_so() {
    let mut rig = rig();
    assert!(rig.key(Key::Enter).is_empty());
    assert_eq!(status(&rig), "Name the run first.");
    rig.typed("build");
    rig.key(Key::Tab);
    rig.typed("cargo \"oops");
    assert!(rig.key(Key::Enter).is_empty());
    assert_eq!(
        status(&rig),
        "The command has an unclosed quote or no words in it."
    );
}

#[test]
fn a_live_run_is_read_every_few_frames_and_not_while_a_read_is_out() {
    let mut rig = rig();
    running(&mut rig, "compiling\n");
    // Not at once: the poll interval has to pass.
    let fx = rig.ticks(3);
    assert!(fx.is_empty(), "{fx:?}");
    let fx = rig.ticks(10);
    assert_eq!(names(&fx), ["run poll"]);
    // That read is still out, so no second one is sent.
    assert!(rig.ticks(20).is_empty());
}

#[test]
fn the_state_words_show_running_exited_with_code_failed_and_stopped() {
    for (word, code, shown) in [
        ("running", None, "running"),
        ("exited", Some(0), "exited with code 0"),
        ("exited", Some(2), "exited with code 2"),
        ("failed", None, "failed"),
        ("stopped", None, "stopped"),
    ] {
        let mut rig = rig();
        let fx = running(&mut rig, "");
        assert!(fx.is_empty() || !fx.is_empty());
        let fx = rig.ticks(10);
        let poll = fx[0].clone();
        rig.accept(&poll, state(&rig, word, code, "", ""));
        let said = status(&rig);
        assert!(said.starts_with(shown), "{word}: {said}");
        assert!(said.contains("started here"), "{said}");
        // An ended run is not read again.
        if word != "running" {
            assert!(rig.ticks(30).is_empty(), "{word}");
        }
    }
}

#[test]
fn the_tab_marks_a_running_run_and_names_how_an_ended_one_ended() {
    let mut rig = rig();
    assert!(rig.panel().tab_label().is_none());
    running(&mut rig, "");
    assert_eq!(
        rig.panel().tab_label().map(|t| t.title),
        Some("Run output (running)".into())
    );
    let poll = rig.ticks(10)[0].clone();
    rig.accept(&poll, state(&rig, "exited", Some(0), "", ""));
    assert_eq!(
        rig.panel().tab_label().map(|t| t.title),
        Some("Run output (exited with code 0)".into())
    );
}

#[test]
fn output_is_drawn_as_text_and_the_wire_is_called_plain_text() {
    let mut rig = rig();
    running(&mut rig, "Compiling a v0.1.0\n\tFinished\n");
    let text = rig.text();
    assert!(text.contains("Compiling a v0.1.0"), "{text}");
    assert!(
        text.contains("    Finished"),
        "a tab goes to the next stop of four: {text}"
    );
    assert!(
        status(&rig).contains("output is plain text"),
        "{}",
        status(&rig)
    );
}

#[test]
fn ansi_colour_in_the_text_is_kept_and_remapped_through_the_theme() {
    let mut rig = rig();
    running(&mut rig, "\u{1b}[31merror\u{1b}[0m: plain\n");
    assert!(
        status(&rig).contains("escape sequences drawn as colour"),
        "{}",
        status(&rig)
    );
    // The program's red comes out as the theme's red, not as a raw escape.
    let mut ansi = [Color::Reset; 16];
    ansi[1] = Color::Rgb(200, 10, 10);
    let theme = Theme::plain().with_ansi(ansi);
    let buf = rig.cells(&theme, 80, 24);
    let y = common::row_with(&buf, "error: plain");
    let x = common::lines(&buf)[y as usize].find("error").unwrap() as u16;
    assert_eq!(buf[(x, y)].fg, Color::Rgb(200, 10, 10));
    let after = common::lines(&buf)[y as usize].find("plain").unwrap() as u16;
    assert_ne!(buf[(after, y)].fg, Color::Rgb(200, 10, 10));
    assert!(!common::lines(&buf)[y as usize].contains('\u{1b}'));
}

#[test]
fn stdout_and_stderr_are_shown_apart_because_the_wire_does_not_interleave_them() {
    let mut rig = rig();
    let sent = start_with_command(&mut rig);
    let fx = rig.answer(&sent[0], Outcome::Accepted, None);
    let fx = rig.accept(
        &fx[0],
        CompletionPayload::RunStarted(RunStarted {
            handle: "h1".into(),
        }),
    );
    rig.accept(
        &fx[0],
        state(&rig, "running", None, "out line\n", "warn line\n"),
    );
    let screen = rig.screen();
    let at = |s: &str| {
        screen
            .iter()
            .position(|l| l.contains(s))
            .unwrap_or_else(|| panic!("{s}: {screen:?}"))
    };
    assert!(at("out line") < at("stderr"));
    assert!(at("stderr") < at("warn line"));
}

#[test]
fn stopping_asks_first_and_only_the_human_confirmation_sends_the_stop() {
    let mut rig = rig();
    running(&mut rig, "working\n");
    let asked = rig.key_in_output('s');
    assert!(asked.is_empty(), "asking sends nothing: {asked:?}");
    assert!(
        status(&rig).starts_with("Stop the run?"),
        "{}",
        status(&rig)
    );
    // An agent can ask for a stop and never approve it.
    assert!(rig.action("run.stop-confirm", agent()).is_empty());
    assert!(status(&rig).starts_with("Stop the run?"));
    let sent = rig.action(
        "run.stop-confirm",
        theorem_workbench_core::ids::Actor::Human,
    );
    assert_eq!(names(&sent), ["run stop"]);
    match &sent[0].body {
        EffectBody::RunStop(h) => assert_eq!(h.handle, "h1"),
        other => panic!("{other:?}"),
    }
    assert!(status(&rig).contains("stop requested"), "{}", status(&rig));
    // A later frame reads the run to see it end.
    let fx = rig.ticks(10);
    assert_eq!(names(&fx), ["run poll"]);
}

#[test]
fn escape_keeps_the_run_going_and_the_stop_chip_asks_then_the_yes_chip_stops() {
    let mut rig = rig();
    running(&mut rig, "");
    rig.click("[Stop]");
    assert!(status(&rig).starts_with("Stop the run?"));
    rig.key(Key::Esc);
    assert!(status(&rig).starts_with("running"), "{}", status(&rig));
    rig.click("[Stop]");
    let sent = rig.click("[Yes, stop]");
    assert_eq!(names(&sent), ["run stop"]);
}

#[test]
fn closing_the_panel_does_not_stop_the_run() {
    let mut rig = rig();
    running(&mut rig, "");
    let fx = rig.close();
    assert!(
        !names(&fx).contains(&"run stop"),
        "closing the panel must not stop the run: {fx:?}"
    );
    assert!(fx.is_empty(), "{fx:?}");
}

#[test]
fn the_stop_confirmation_is_registered_human_only_and_a_stop_names_what_it_sends() {
    use theorem_workbench_core::effect::EffectKind;
    use theorem_workbench_core::ids::ActionId;
    let mut registry = theorem_workbench_core::builtin::registry();
    theorem_workbench_ide::extend_registry(&mut registry).unwrap();
    let get = |id: &str| registry.action(&ActionId::new(id)).expect(id).1.clone();
    assert!(get("run.stop-confirm").human_only);
    assert!(!get("run.stop").human_only);
    assert_eq!(get("run.stop").emits, [EffectKind::RunStop]);
    assert_eq!(
        get("run.start").emits,
        [EffectKind::RunConfigure, EffectKind::RunStart]
    );
    assert_eq!(get("run.refresh").emits, [EffectKind::RunPoll]);
    assert!(get("run.follow").emits.is_empty());
}

#[test]
fn the_tail_is_followed_until_the_person_scrolls_up_and_follows_again_at_the_end() {
    let long: String = (1..=100).map(|n| format!("line {n}\n")).collect();
    let mut rig = rig();
    rig.standard();
    running(&mut rig, &long);
    let screen = rig.screen();
    assert!(screen.iter().any(|l| l.contains("line 100")), "{screen:?}");
    assert!(
        !screen
            .iter()
            .any(|l| l.contains("line 1 ") || l == "line 1")
    );
    assert!(rig.text().contains("[Following]"));

    // Scrolling up leaves the tail where it is.
    rig.key(Key::Esc);
    rig.key(Key::PageUp);
    assert!(rig.text().contains("[Follow]") && !rig.text().contains("[Following]"));
    let held = rig.screen();
    let more: String = (1..=130).map(|n| format!("line {n}\n")).collect();
    let poll = rig.ticks(10)[0].clone();
    rig.accept(&poll, state(&rig, "running", None, &more, ""));
    assert_eq!(
        rig.screen()[5..],
        held[5..],
        "new output does not move a reader who scrolled up"
    );

    // End follows again, and the new tail is shown.
    rig.key(Key::End);
    assert!(rig.text().contains("[Following]"));
    assert!(rig.screen().iter().any(|l| l.contains("line 130")));
}

#[test]
fn a_run_known_only_by_its_handle_is_shown_as_observed_and_read_on_the_first_frame() {
    let (mut rig, fx) = open_with(
        "run-output",
        &CAPS,
        WORKSPACE,
        Some(json!({"name": "build", "command": "", "handle": "h1", "follow": true})),
    );
    assert_eq!(names(&fx), ["run poll"]);
    rig.accept(&fx[0], state(&rig, "running", None, "from elsewhere\n", ""));
    assert!(
        status(&rig).starts_with("running, observed, not started here"),
        "{}",
        status(&rig)
    );
    assert!(rig.text().contains("from elsewhere"));
}

#[test]
fn a_refused_read_is_shown_as_the_owner_said_it_and_reading_waits_until_asked() {
    let mut rig = rig();
    running(&mut rig, "");
    let poll = rig.ticks(10)[0].clone();
    rig.refuse(&poll, "run_unknown", "No run has that handle.");
    assert_eq!(
        status(&rig),
        "Reading the run refused (run_unknown): No run has that handle. Not retried."
    );
    assert_eq!(
        rig.node("status").state.description.as_deref(),
        Some("refused")
    );
    assert!(rig.ticks(40).is_empty(), "no silent retry");
    let again = rig.action("run.refresh", theorem_workbench_core::ids::Actor::Human);
    assert_eq!(names(&again), ["run poll"]);
}

#[test]
fn a_failed_start_and_an_uncertain_stop_are_shown_in_the_owners_words() {
    let mut rig = rig();
    let sent = start_with_command(&mut rig);
    rig.answer(
        &sent[0],
        Outcome::Failed {
            reason: "no such program".into(),
        },
        None,
    );
    assert_eq!(
        status(&rig),
        "Setting the command failed: no such program Not retried."
    );

    let mut rig = common::open("run-output", &CAPS, WORKSPACE).0;
    running(&mut rig, "");
    rig.key_in_output('s');
    let sent = rig.action(
        "run.stop-confirm",
        theorem_workbench_core::ids::Actor::Human,
    );
    rig.answer(
        &sent[0],
        Outcome::Uncertain {
            reason: "the connection dropped".into(),
        },
        None,
    );
    assert_eq!(
        status(&rig),
        "Stopping the run: unknown whether it happened: the connection dropped Not retried."
    );
    assert_eq!(
        rig.node("status").state.description.as_deref(),
        Some("uncertain")
    );
}

#[test]
fn name_command_follow_scroll_and_handle_are_saved_and_restoring_sends_no_start() {
    let mut rig = rig();
    running(&mut rig, "");
    let saved = rig.panel().serialize();
    assert_eq!(saved["name"], "build");
    assert_eq!(saved["handle"], "h1");
    assert_eq!(saved["follow"], true);
    assert!(
        saved["command"]
            .as_str()
            .unwrap()
            .starts_with("cargo build")
    );
    assert_eq!(
        theorem_workbench_core::Panel::serialize(&RunPanel::restore(&saved)),
        saved
    );
    let (_, fx) = open_with("run-output", &CAPS, WORKSPACE, Some(saved));
    assert_eq!(
        names(&fx),
        ["run poll"],
        "restoring only reads the run, it never starts one"
    );
}

#[test]
fn without_the_run_capabilities_the_panel_says_so_and_start_gives_its_reason() {
    let mut rig = rig();
    rig.host(HostMessage::CapabilitiesChanged {
        capabilities: Capabilities::of(["files"]),
    });
    let said = status(&rig);
    assert!(
        said.contains("neither \"run.start\" nor \"run.subscribe\""),
        "{said}"
    );
    let root = rig.node("run");
    let start = root
        .actions
        .iter()
        .find(|a| a.id.as_str() == "run.start")
        .unwrap();
    assert!(!start.enabled);
    assert!(start.reason.as_deref().unwrap().contains("run.start"));
}

#[test]
fn the_semantic_tree_names_the_state_the_buttons_and_why_an_action_is_off() {
    let mut rig = rig();
    let root = rig.node("run");
    let reason = |id: &str| {
        root.actions
            .iter()
            .find(|a| a.id.as_str() == id)
            .unwrap_or_else(|| panic!("{id}"))
            .reason
            .clone()
    };
    assert_eq!(reason("run.start").as_deref(), Some("The run has no name."));
    assert_eq!(reason("run.stop").as_deref(), Some("Nothing is running."));
    assert_eq!(
        reason("run.stop-confirm").as_deref(),
        Some("Ask to stop first with run.stop.")
    );
    assert_eq!(
        reason("run.refresh").as_deref(),
        Some("There is no run to read yet.")
    );
    assert!(rig.node("start").state.disabled);

    running(&mut rig, "hello\n");
    let root = rig.node("run");
    assert!(root.state.busy);
    assert!(
        root.state
            .description
            .as_deref()
            .unwrap()
            .starts_with("running")
    );
    assert!(rig.node("stop").actions.iter().all(|a| a.enabled));
    assert_eq!(rig.node("output").text.as_deref(), Some("hello"));
    assert!(rig.node("follow").state.selected);
    rig.key_in_output('s');
    assert!(rig.node("stop-confirm").actions.iter().all(|a| a.enabled));
    assert!(rig.node("stop-cancel").actions.iter().all(|a| a.enabled));
}

#[test]
fn run_output_at_80_by_24_draws_the_form_the_state_and_the_output() {
    let mut rig = rig();
    rig.standard();
    running(
        &mut rig,
        "\u{1b}[32m   Compiling\u{1b}[0m a v0.1.0\n    Finished dev in 1.2s\n",
    );
    let screen = rig.screen();
    println!("{}", screen.join("\n"));
    assert_eq!(screen.len(), 24);
    assert!(screen[0].starts_with("Name") && screen[0].contains("build"));
    assert!(screen[1].starts_with("Command") && screen[1].contains("cargo build"));
    assert!(
        screen[2].contains("running, started here")
            && screen[2].contains("[Stop]")
            && screen[2].contains("[Following]")
    );
    // The status wraps onto a second row at this width; the output starts under it.
    assert!(screen[4].contains("Compiling"), "{screen:?}");
    assert!(screen[5].contains("Finished dev in 1.2s"));
    let _ = (Style::new(), Mods::NONE);
}
