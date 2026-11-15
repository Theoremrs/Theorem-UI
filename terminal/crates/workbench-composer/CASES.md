# Composer test cases and where each came from

Behaviour reference: `openai/codex` `codex-rs/tui` at `b016cd18472588606c04af565528c4cd6746a41f` (Apache-2.0), snapshots in `docs/plans/evidence/refs/composer@b016cd1/`. Lane "translation": no Codex file is copied. "original" cases cite the spec clause (SPEC-THEO-WEB-TERMINAL-WORKBENCH-1.0, section 7.2 item numbers, R21, AC-25, AC-48).

## editing.rs
- empty draft shows the placeholder after a prompt glyph; no gutter: `chat_composer__tests__empty`, `snapshot_tests__draft_composer` (prompt row, placeholder, footer row)
- Enter submits the trimmed text and keeps the draft: original, 7.2 item 1 and 9
- an empty or blank draft submits nothing: original, 7.2 item 8
- Shift+Enter, Alt+Enter, Ctrl+J insert a newline: original, 7.2 item 1 (Codex's multi-line entry is Shift+Enter; the others are the spec's)
- height grows with content up to max_rows, then scrolls: `textarea__tests__textarea_full_final_line_scrolls_to_visible_cursor_row`, `textarea__wrapping__tests__hanging_tab_cursor_and_scroll`
- a long line wraps and counts toward the height: `textarea__tests__textarea_trailing_spaces_wrap_without_cursor_overflow`, `textarea_reflow_keeps_fitting_remainder_on_current_row`
- there is no line-number gutter, also across a digit change: original, 7.2 item 1
- Shift+arrows select and typing replaces: original (Codex has no keyboard selection, donors.md 3.3), 7.2 item 2
- word and line motions, select all: original, 7.2 item 2
- double click selects a word, drag selects a span: `textarea__mouse__tests__mouse_wrapped_selection` (pointer selection over wrapped rows), 7.2 item 2
- copy and cut return the text, cut removes it; Ctrl+C with no selection is the panel's: original, 7.2 item 2 and the current `theo.rs` Ctrl+C meaning
- the paste key asks the host for the clipboard: original, 7.2 item 2
- a paste with newlines is one undo step and never submits; redo with upper-case Z: `chat_composer__paste_tests__paste_burst_tab_indentation` (paste does not act as typing), `theo.rs` `a_paste_into_the_composer_never_becomes_terminal_input`; original for undo (7.2 items 2 and 3)
- undo and redo run through the session: original, 7.2 item 3
- Ctrl+E, Ctrl+U, Ctrl+K line keys: original, from the current `terminal/src/lib.rs` Session::key
- Esc, Tab, Page keys, Alt+[ Alt+], Ctrl+L, Ctrl+O are not handled: original, from `theo.rs` on_key (the panel owns them)

## ime.rs
- preedit drawn at the caret and not in the text, caret follows it: original, 7.2 item 4, R21; width alignment: `textarea__tests__textarea_halfwidth_sound_marks_wrap_and_align_with_cursor`
- committed text enters once, also when the browser delivers it again as typed input (before or after End): original, 7.2 item 4
- a cancelled composition leaves the text alone: original, 7.2 item 4
- Enter while composing never submits: original, 7.2 item 4
- a commit is its own undo step: original, 7.2 item 3 and 4
- preedit survives a resize: original, 7.2 item 9

## caret.rs
- steady after a key, blinking when idle, hold period is a parameter: original, 7.2 item 5; half period from `terminal/src/lib.rs` BLINK_MS
- reduced motion gives steady: original, 7.2 item 5
- hidden when unfocused, window unfocused, or the model list owns the keys: original, 7.2 item 5
- steady while composing: original, 7.2 item 5
- no caret glyph in text(), serialize(), draft() or the cell under the host caret: original, 7.2 item 5 and AC-25

## attachments.rs
- chips above the text with name and state: `chat_composer__tests__remote_image_rows`, `image_placeholder_single`, `image_placeholder_multiple` (rows of attachment labels above the prompt)
- keyboard path into the chip row, Left/Right, Down and Esc out: original, 7.2 item 6
- Up on a later line moves the caret, not the chip: original, 7.2 item 6
- Backspace or Delete on a chip returns AttachRemove: `chat_composer__tests__remote_image_rows_after_delete_first` (removing a row), 7.2 item 6
- attach request returns AttachPick: original, 7.2 item 6
- submit carries the ready ids only: original, 7.2 item 6
- an attachment alone is a sendable draft; a refused one is not: original, 7.2 item 6 and 8
- Enter while an attachment is adding does not submit and the footer says why: original, 7.2 item 6
- Blocked refuses Enter: original, 7.2 item 8
- chips clip at narrow widths and keep the chosen one visible: original, R21 (20-column rule)

## references.rs
- `@` at a word start opens the popup and asks for files as the query changes: `chat_composer__mentions_layout_tests__mention_menu_above_composer`, `default_unified_mention_popup`
- an `@` inside a word is not a reference: `chat_composer__tests__file_popup_ignores_shell_positional_parameter` (not every sigil is a mention)
- a stale answer is ignored: original, 7.2 item 7
- Up/Down move (wrapping), Enter and Tab choose: `mention_menu_above_composer` ("enter/tab insert, esc close, up/down select" hint)
- Esc dismisses and leaves the typed text; it does not reopen for the same `@`: `chat_composer__tests__deleting_prefix_keeps_bang_literal`, 7.2 item 7
- Enter with no matches still sends: original, 7.2 item 7
- a chosen reference is atomic and Backspace removes it whole: `chat_composer__tests__backspace_after_pastes` (a placeholder element deleted as one unit)
- undo restores a removed reference with its reference, redo removes it: original, 7.2 item 7
- edits around a reference leave it alone: original, 7.2 item 7
- add_reference inserts at the caret for "ask about this": original, 7.2 item 7
- references come back in text order: original, 7.2 item 7
- a reference chosen by pointer: original
- the reference text is drawn in the atomic role: original, R21 (theme roles only)

## policy.rs
- footer says what Enter does on the left, model, effort and context on the right: `chat_composer__tests__footer_collapse_empty_full`, `footer_collapse_queue_full`, `effort_tests__effort_transition_keeps_the_full_footer_row`
- the right side goes first when narrow, then the left is worded shorter, then cut: `footer_collapse_empty_mode_only`, `footer_collapse_queue_short_without_context`, `status_surface__tests__shortcut_help_above_narrow`
- Enter steers a running run, sends when idle: `chat_composer__tests__footer_collapse_queue_full` ("tab to queue message" while running), `theo.rs` submit(); 7.2 item 8
- a run that cannot take input returns no Submit and says so: original, 7.2 item 8
- Blocked returns nothing and keeps the draft: original, 7.2 item 8
- take returns the draft and empties it and its undo history: original, 7.2 item 9; `theo.rs` `an_uncertain_send_is_shown_as_unknown_and_never_sent_again`
- put_back returns text, caret, references, attachments: original, 7.2 item 9; `theo.rs` `a_refused_send_shows_the_reason_and_keeps_the_draft`
- put_back does not overwrite a newer draft: `theo.rs` keep() (only when the input is empty)
- an uncertain send leaves the composer empty: `theo.rs` `an_uncertain_send_is_shown_as_unknown_and_never_sent_again`
- serialize and restore round trip text, caret, selection, references: `theo.rs` `the_conversation_scroll_anchor_expanded_results_and_draft_survive_a_save_and_restore`; 7.2 item 9
- restore takes a plain string and refuses nonsense: `theo.rs` state["draft"] (older saved layouts)
- a theme change and a resize lose nothing: original, 7.2 item 9
- Up on an empty draft returns RecallLast: `theo.rs` recall (Up in Session::key); 7.2 item 10
- a loaded message submits as Edit; Esc untouched returns to empty: `theo.rs` begin_edit and Action::Close; 7.2 item 10
- Esc on a touched loaded message is the panel's: original, 7.2 item 10
- a loaded message keeps its references atomic: original, 7.2 item 7 and 10
- the model list returns ModelChosen, Esc closes, typing is ignored while it owns the keys: `chat_composer__mentions_layout_tests__mention_scopes_overlay_history` (a list popup over the composer); 7.2 item 11

## semantics.rs
- one textbox with value, caret, selection and focus: `theo.rs` composer node; 7.2 item 12
- placeholder as description while empty: `chat_composer__tests__empty`; 7.2 item 12
- one node per chip with name and state: original, 7.2 item 12
- the popup is a menu with its options and the active one: `editor/src/panel/chrome.rs` popup nodes; 7.2 item 12
- the footer is a status node: original, 7.2 item 12
- the tree validates and the draft text is exposed once: original, 7.2 item 12 (last sentence)
- ids sit under the panel's prefix: original, 7.2 item 12

## layout.rs
- CJK and emoji take two cells at the caret and at the wrap: `textarea__tests__textarea_halfwidth_sound_marks_wrap_and_align_with_cursor`, `textarea_masked_graphemes_align_with_cursor`, `textarea_breakable_unicode_space_hangs_before_following_text`
- a wide character is never split at the right edge: `textarea__tests__textarea_full_non_final_line_has_a_visible_cursor_row`
- 20 columns clip without panicking in every state: original, R21
- a zero-size area does not panic and input still works: `textarea__mouse__tests__wheel_at_edges_after_resize`; original, R21
- draws through a ratatui TestBackend: original, R21
- the area need not start at the origin: original, 7.2 item 12 (panels are placed by the dock)
- four states at 80 and 30 columns: `chat_composer__tests__empty`, `footer_collapse_*`, `mention_menu_above_composer`
- original (spec 7.2, editor rule): a cut leaves the draft only when the clipboard write is accepted and the text is still there; otherwise the footer says "Not cut" (tests/editing.rs)
- original (terminal `Session::history`): Up on the first row of an empty draft walks sent prompts, Down comes back, an edit stops the walk, the list is bounded (tests/editing.rs)
