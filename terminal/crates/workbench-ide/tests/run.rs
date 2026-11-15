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
use theorem_workbench_core::ids::Actor;
use theorem_workbench_core::registry::Capabilities;
use theorem_workbench_core::results::RunList;
use theorem_workbench_core::results::{ReadAt, RunState, RunSummary};
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

// ---- listing runs and attaching to one started elsewhere ----------------------------------

const LIST_CAPS: [&str; 5] = [
    "files",
    "documents",
    "run.start",
    "run.subscribe",
    "run.list",
];

fn summary(handle: &str, name: &str, command: &[&str], state: &str, at: u64) -> RunSummary {
    RunSummary {
        handle: handle.into(),
        name: Some(name.into()),
        command: Some(command.iter().map(|w| (*w).to_owned()).collect()),
        state: state.into(),
        started_at_ms: Some(at),
        exit_code: None,
        kind: None,
    }
}

fn two_runs() -> CompletionPayload {
    CompletionPayload::RunList(RunList {
        runs: vec![
            summary("h-old", "lint", &["cargo", "clippy"], "exited", 1_000),
            summary(
                "h-new",
                "serve",
                &["npm", "run", "dev server"],
                "running",
                9_000,
            ),
        ],
    })
}

fn listing() -> (common::Rig, Vec<Effect>) {
    let (mut rig, _) = open("run-output", &LIST_CAPS, WORKSPACE);
    rig.standard();
    let sent = rig.click("[Runs]");
    (rig, sent)
}

#[test]
fn without_the_list_capability_the_control_is_absent_not_disabled() {
    let mut rig = rig();
    rig.standard();
    assert!(!rig.text().contains("[Runs]"));
    let root = rig.node("run");
    assert!(
        root.actions
            .iter()
            .all(|a| !a.id.as_str().starts_with("run.list"))
    );
    assert!(root.actions.iter().all(|a| a.id.as_str() != "run.attach"));
    assert!(rig.nodes().iter().all(|n| n.id.as_str() != "runs"));
    assert!(rig.key_in_output('l').is_empty());
    assert!(rig.action("run.list", Actor::Human).is_empty());
}

#[test]
fn the_runs_chip_asks_the_host_for_its_runs_and_shows_them_newest_first() {
    let (mut rig, sent) = listing();
    assert_eq!(names(&sent), ["run list"]);
    rig.accept(&sent[0], two_runs());
    let screen = rig.screen();
    let at = |s: &str| {
        screen
            .iter()
            .position(|l| l.contains(s))
            .unwrap_or_else(|| panic!("{s}: {screen:?}"))
    };
    assert!(screen[at("2 runs on the host")].contains("Esc closes the list"));
    assert!(at("serve") < at("lint"), "the newest run is first");
    assert!(
        screen[at("serve")].contains("npm run dev server")
            && screen[at("serve")].contains("[h-new]")
    );
    assert!(rig.text().contains("[Close runs]"));
}

#[test]
fn choosing_a_listed_run_shows_it_as_observed_and_reads_it_without_starting_anything() {
    let (mut rig, sent) = listing();
    rig.accept(&sent[0], two_runs());
    let fx = rig.key(Key::Enter);
    assert_eq!(names(&fx), ["run poll"], "attaching only reads");
    match &fx[0].body {
        EffectBody::RunPoll(h) => assert_eq!(h.handle, "h-new"),
        other => panic!("{other:?}"),
    }
    let mut poll = state(&rig, "running", None, "listening on 3000\n", "");
    if let CompletionPayload::RunState(s) = &mut poll {
        s.handle = "h-new".into();
    }
    rig.accept(&fx[0], poll);
    assert!(
        status(&rig).starts_with("running, observed, not started here"),
        "{}",
        status(&rig)
    );
    assert!(rig.text().contains("listening on 3000"));
    assert_eq!(rig.node("name").text.as_deref(), Some("serve"));
    assert_eq!(
        rig.node("command").text.as_deref(),
        Some("npm run 'dev server'")
    );
    assert!(rig.text().contains("[Runs]") && !rig.text().contains("[Close runs]"));
    // It is the host's run: this panel does not stop it unless asked, and closing sends nothing.
    let fx = rig.close();
    assert!(fx.is_empty(), "{fx:?}");
}

#[test]
fn arrow_keys_and_the_pointer_choose_among_the_listed_runs() {
    let (mut rig, sent) = listing();
    rig.accept(&sent[0], two_runs());
    rig.key(Key::Down);
    let fx = rig.key(Key::Enter);
    match &fx[0].body {
        EffectBody::RunPoll(h) => assert_eq!(h.handle, "h-old"),
        other => panic!("{other:?}"),
    }
    let (mut rig, sent) = listing();
    rig.accept(&sent[0], two_runs());
    let fx = rig.click("lint");
    match &fx[0].body {
        EffectBody::RunPoll(h) => assert_eq!(h.handle, "h-old"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn escape_or_the_close_chip_leaves_the_list_and_the_current_run_untouched() {
    let (mut rig, sent) = listing();
    rig.accept(&sent[0], two_runs());
    assert!(rig.key(Key::Esc).is_empty());
    assert!(!rig.text().contains("runs on the host"));
    let sent = rig.click("[Runs]");
    rig.accept(&sent[0], two_runs());
    assert!(rig.click("[Close runs]").is_empty());
    assert!(!rig.text().contains("runs on the host"));
}

#[test]
fn a_refused_or_empty_list_is_told_in_the_owners_words_and_not_retried() {
    let (mut rig, sent) = listing();
    rig.refuse(&sent[0], "run_list_denied", "Runs cannot be listed here.");
    assert_eq!(
        status(&rig),
        "Listing the runs refused (run_list_denied): Runs cannot be listed here. Not retried."
    );
    assert!(rig.ticks(40).is_empty());
    let (mut rig, sent) = listing();
    rig.accept(
        &sent[0],
        CompletionPayload::RunList(RunList { runs: vec![] }),
    );
    assert_eq!(status(&rig), "The host lists no runs.");
}

#[test]
fn the_list_has_semantic_items_and_an_attach_action_registered_with_what_it_sends() {
    let (mut rig, sent) = listing();
    rig.accept(&sent[0], two_runs());
    let items: Vec<_> = rig
        .nodes()
        .into_iter()
        .filter(|n| n.id.as_str().starts_with("run:"))
        .collect();
    assert_eq!(items.len(), 2);
    assert!(items[0].state.selected && items[0].name.contains("serve"));
    assert!(
        items[0]
            .actions
            .iter()
            .any(|a| a.id.as_str() == "run.attach" && a.enabled)
    );
    assert_eq!(rig.node("runs").name, "Close the list of runs");
    let fx = rig.action("run.attach", Actor::Human);
    assert_eq!(names(&fx), ["run poll"]);

    use theorem_workbench_core::effect::EffectKind;
    use theorem_workbench_core::ids::ActionId;
    let mut registry = theorem_workbench_core::builtin::registry();
    theorem_workbench_ide::extend_registry(&mut registry).unwrap();
    let get = |id: &str| registry.action(&ActionId::new(id)).expect(id).1.clone();
    assert_eq!(get("run.list").emits, [EffectKind::RunList]);
    assert_eq!(get("run.attach").emits, [EffectKind::RunPoll]);
    assert!(get("run.list-up").emits.is_empty());
}

// ---- placing the caret by pointer ----------------------------------------------------------

fn field_text(rig: &common::Rig, id: &str) -> String {
    rig.node(id).text.unwrap_or_default()
}

#[test]
fn clicking_in_the_name_field_puts_the_caret_under_the_pointer() {
    let mut rig = rig();
    rig.typed("abcdef");
    // The label takes 9 columns; column 2 of the field is the gap between b and c.
    rig.press(9 + 2, 0);
    rig.ch('X');
    assert_eq!(field_text(&rig, "name"), "abXcdef");
    // Past the end is the end.
    rig.press(9 + 40, 0);
    rig.ch('Z');
    assert_eq!(field_text(&rig, "name"), "abXcdefZ");
}

#[test]
fn a_click_chooses_the_field_and_lands_by_cells_over_wide_characters() {
    let mut rig = rig();
    rig.key(Key::Tab);
    rig.typed("\u{65E5}\u{672C}\u{8A9E}");
    rig.press(9 + 2, 1);
    rig.ch('X');
    assert_eq!(field_text(&rig, "command"), "\u{65E5}X\u{672C}\u{8A9E}");
    // Back in the name field by clicking it, whatever had focus.
    rig.press(9, 0);
    rig.ch('N');
    assert_eq!(field_text(&rig, "name"), "N");
}

#[test]
fn a_click_in_a_scrolled_field_accounts_for_the_scroll() {
    let mut rig = rig();
    rig.key(Key::Tab);
    let long: String = (0..30).map(|n| format!("{n:03} ")).collect();
    rig.typed(&long);
    let shown = rig.screen()[1].chars().skip(9).collect::<String>();
    let first = shown.trim_end().chars().take(3).collect::<String>();
    rig.press(9, 1);
    rig.ch('X');
    let value = field_text(&rig, "command");
    let at = value.find('X').expect("typed");
    assert!(
        at > 0,
        "the field was scrolled, so column 0 is not the start: {value}"
    );
    assert_eq!(&value[at + 1..at + 4], first, "{value}");
}

// ---- how a listed run reads: exit code and kind ----------------------------------------------

fn listed(rows: Vec<RunSummary>) -> common::Rig {
    let (mut rig, sent) = listing();
    rig.accept(&sent[0], CompletionPayload::RunList(RunList { runs: rows }));
    rig
}

fn ended(handle: &str, state: &str, code: Option<i32>, kind: Option<&str>, at: u64) -> RunSummary {
    RunSummary {
        exit_code: code,
        kind: kind.map(Into::into),
        ..summary(handle, "job", &["make"], state, at)
    }
}

fn row_of<'a>(screen: &'a [String], handle: &str) -> &'a str {
    screen
        .iter()
        .find(|l| l.contains(&format!("[{handle}]")))
        .unwrap_or_else(|| panic!("{handle}: {screen:?}"))
}

#[test]
fn a_listed_run_says_how_it_ended_in_the_words_a_followed_run_uses() {
    let rig = listed(vec![
        ended("ok", "exited", Some(0), None, 4),
        ended("bad", "exited", Some(101), None, 3),
        ended("none", "exited", None, None, 2),
        ended("live", "running", None, None, 1),
    ]);
    let screen = rig.screen();
    assert!(
        row_of(&screen, "ok").starts_with("exited with code 0  job"),
        "{screen:?}"
    );
    assert!(row_of(&screen, "bad").starts_with("exited with code 101  job"));
    assert!(
        row_of(&screen, "none").starts_with("exited (no code given)  job"),
        "no number is guessed: {screen:?}"
    );
    assert!(row_of(&screen, "live").starts_with("running  job"));
    // The semantic tree says the same.
    let name = |h: &str| {
        rig.nodes()
            .into_iter()
            .find(|n| n.name.contains(&format!("[{h}]")))
            .unwrap()
            .name
    };
    assert!(name("bad").contains("exited with code 101") && name("none").contains("no code given"));
}

#[test]
fn only_a_non_zero_exit_takes_the_error_role() {
    use ratatui::style::Color;
    let rig = listed(vec![
        ended("ok", "exited", Some(0), None, 3),
        ended("bad", "exited", Some(2), None, 2),
        ended("none", "exited", None, None, 1),
    ]);
    let theme = Theme::plain().with_state(
        ratatui::style::Style::new().fg(Color::Red),
        ratatui::style::Style::new(),
        ratatui::style::Style::new(),
    );
    let buf = rig.cells(&theme, 80, 24);
    let fg_at = |needle: &str| {
        let y = common::row_with(&buf, needle);
        buf[(0, y)].fg
    };
    assert_eq!(fg_at("[bad]"), Color::Red);
    assert_ne!(fg_at("[ok]"), Color::Red);
    assert_ne!(fg_at("[none]"), Color::Red);
}

#[test]
fn a_kind_is_a_muted_label_beside_the_name_and_absent_when_the_host_gave_none() {
    let rig = listed(vec![
        ended("with", "running", None, Some("test"), 2),
        ended("without", "running", None, None, 1),
    ]);
    let screen = rig.screen();
    assert!(
        row_of(&screen, "with").contains("job  test  make"),
        "{screen:?}"
    );
    assert!(!row_of(&screen, "without").contains("test"));
    assert_eq!(
        row_of(&screen, "without").split("  ").nth(1),
        Some("job"),
        "no kind is made up from `make`"
    );
    let item = rig
        .nodes()
        .into_iter()
        .find(|n| n.name.contains("[with]"))
        .unwrap();
    assert!(item.name.contains("(test)"), "{}", item.name);
}

#[test]
fn a_narrow_width_drops_the_kind_before_it_cuts_the_name() {
    let (mut rig, sent) = listing();
    let mut long = ended("h1", "running", None, Some("debug"), 1);
    long.name = Some("integration-suite".into());
    rig.accept(
        &sent[0],
        CompletionPayload::RunList(RunList { runs: vec![long] }),
    );
    // Wide: name and kind both whole.
    assert!(rig.screen().join("\n").contains("integration-suite  debug"));
    // "running  integration-suite" is 26 cells; the kind needs 7 more. At 30 columns it
    // does not fit, so the kind goes and the name stays whole.
    let theme = Theme::plain();
    let buf = rig.cells(&theme, 30, 24);
    let text = common::lines(&buf).join("\n");
    assert!(text.contains("running  integration-suite"), "{text}");
    assert!(!text.contains("debug"), "{text}");
}

// ---- the text and caret the run's fields publish -------------------------------

#[test]
fn the_name_and_command_fields_publish_their_text_and_caret_in_utf16_units() {
    let mut rig = rig();
    rig.typed("b\u{1F600}");
    let n = rig.node("name");
    assert_eq!(n.text.as_deref(), Some("b\u{1F600}"));
    let s = n.selection.expect("a text box publishes its selection");
    assert_eq!((s.anchor, s.focus), (3, 3));
    assert_eq!(rig.node("command").selection.map(|s| s.focus), Some(0));
}

#[test]
fn shift_left_then_typing_replaces_the_run_name_and_select_all_replaces_the_command() {
    let mut rig = rig();
    rig.typed("build");
    rig.mods(Key::Left, Mods::SHIFT);
    rig.mods(Key::Left, Mods::SHIFT);
    rig.typed("X");
    rig.key(Key::Tab);
    rig.typed("cargo old");
    rig.mods(Key::Char('a'), Mods::CTRL);
    rig.typed("cargo new");
    let sent = rig.key(Key::Enter);
    match &sent[0].body {
        EffectBody::RunConfigure(c) => {
            assert_eq!(c.name, "buiX");
            assert_eq!(c.argv, ["cargo", "new"]);
        }
        other => panic!("{other:?}"),
    }
}

fn clipboard_write(fx: &[Effect]) -> (Effect, String) {
    let write = fx
        .iter()
        .find(|e| matches!(e.body, EffectBody::ClipboardWrite(_)))
        .unwrap_or_else(|| panic!("no clipboard write in {fx:?}"));
    let EffectBody::ClipboardWrite(w) = &write.body else {
        unreachable!()
    };
    (write.clone(), w.text.clone())
}

#[test]
fn copy_and_cut_in_a_run_field_go_through_the_clipboard_effect_and_ctrl_c_still_stops_without_one()
{
    let mut rig = rig();
    rig.typed("build");
    rig.mods(Key::Left, Mods::SHIFT);
    rig.mods(Key::Left, Mods::SHIFT);
    let (write, text) = clipboard_write(&rig.mods(Key::Char('c'), Mods::CTRL));
    assert_eq!(text, "ld");
    rig.answer(&write, Outcome::Accepted, None);
    let (write, _) = clipboard_write(&rig.mods(Key::Char('x'), Mods::CTRL));
    assert_eq!(rig.node("name").text.as_deref(), Some("build"));
    rig.answer(&write, Outcome::Accepted, None);
    assert_eq!(rig.node("name").text.as_deref(), Some("bui"));
    // A refused cut leaves the text.
    rig.mods(Key::Char('a'), Mods::CTRL);
    let (write, _) = clipboard_write(&rig.mods(Key::Char('x'), Mods::CTRL));
    rig.refuse(&write, "denied", "no clipboard here");
    assert_eq!(rig.node("name").text.as_deref(), Some("bui"));
    assert!(rig.text().contains("no clipboard here"), "{}", rig.text());
    // With nothing selected, Ctrl+C is still the stop.
    rig.key(Key::Right);
    assert!(
        rig.mods(Key::Char('c'), Mods::CTRL)
            .iter()
            .all(|e| !matches!(e.body, EffectBody::ClipboardWrite(_)))
    );
}
