# IME manual checklist (AC-25)

Input-method composition cannot be driven by Playwright in any of the three engines: it has no way to start an IME session, so composition is a manual check on a real input method. Run it once per engine (Chromium, Firefox, WebKit/Safari) against the story `workbench-keyboard-journey` (1440x900) in the oracle's dev server, and once in the real app.

Use at least one of each family: Japanese (Kana or Romaji, with candidate window), Chinese Pinyin, Korean Hangul (composition without a candidate window), and the macOS accent press-and-hold menu (for example hold `e`, pick `é`).

For every surface, record pass or fail per engine and input method. A failure is any line under "Expected" that does not hold.

## Everywhere (all three surfaces)

Expected:
- While composing, the underlined or pending text is shown where the caret is, and the caret follows the composition as it grows.
- The candidate window (or accent menu) opens next to the caret, not at the corner of the page.
- Committing a candidate inserts it exactly once. No duplicate, no leftover pending text.
- Keys that belong to the composition (Enter to commit, Escape to cancel, Space and arrows to choose, Backspace to shorten) go to the input method. They do not send a message, close a panel, move focus, or run a workbench chord.
- Cancelling the composition with Escape leaves the text as it was before it began.
- After the commit, ordinary typing, Backspace and the arrow keys work at once.
- The page does not scroll and the grid does not lose its focus ring during composition.

## Composer (Theo panel, `Message to Theo`)

Steps:
1. Focus the composer (it has focus on load).
2. Compose `にほんご` and choose a candidate with Space, commit with Enter.
3. Compose another phrase and press Enter once to commit, then Enter again.
4. Compose, then press Escape.
5. Type `y` and `n` with an empty composer, then again while a composition is open.
6. Compose in the middle of an existing line (move the caret first), then undo.

Expected:
- Step 2: the chosen text appears once. Enter commits and does not send.
- Step 3: the first Enter commits. Only the second Enter sends (a `conversationSend`).
- Step 4: the pending text disappears. Nothing is sent.
- Step 5: with a composition open, `y` and `n` stay in the composition. They never answer a waiting approval. With an empty, idle composer they do.
- Step 6: the text lands at the caret, once. Undo removes the committed text as one step.

## Editor (open `docs/notes.txt` from Files)

Steps:
1. Open the document, place the caret at the end of a line.
2. Compose and commit a phrase. Watch the tab's modified marker and the line count.
3. Compose across a line end: commit, then press Enter.
4. Compose, then press Mod+Alt+T or Mod+Alt+E while the composition is open.
5. Select a word, then start composing over it.

Expected:
- Step 2: one edit. The text shows once. The modified marker appears once.
- Step 3: the newline comes only from the Enter after the commit.
- Step 4: the chord does not run until the composition ends (focus does not leave the editor mid-composition).
- Step 5: the selection is replaced by the committed text, once.

## Terminal (Shell panel, session `sh-1`)

Steps:
1. Open the terminal with Mod+Alt+S, Enter on the existing session.
2. At the prompt, compose `こんにちは` and commit.
3. Compose and press Escape.
4. Compose a phrase and press Enter to commit, then Enter to run it.
5. Run a full-screen program that turns on application cursor keys, then compose.

Expected:
- Step 2: the committed text reaches the program once, as UTF-8, and is echoed once.
- Step 3: nothing is sent to the program. In particular no stray ESC byte.
- Step 4: the commit sends the text, never a carriage return. The second Enter sends one.
- Step 5: composition is committed as text, not as arrow-key sequences.
- Wide characters occupy two cells and the cursor lands after them.
