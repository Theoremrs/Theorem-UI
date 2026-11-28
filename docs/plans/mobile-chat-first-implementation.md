# Mobile chat: rich replies and clear glass

Date: 2026-11-21

This implements the approved first chat pass: readable rich replies, a compact composer above native navigation, and nearly clear native Liquid Glass. Claude iOS informs the conversation hierarchy; Linear informs compact context and expandable detail. Theorem's existing Stone palette and typography remain the application identity.

The integration branch is `feat/mobile-rich-chat-20261121`, based on main `6c9a1806`. Main gained a newer SDK and substantial mobile work during the initial implementation. This integration keeps those newer runtime, queue, app-preview, presence, recovery, native-header, navigation, authentication, and native-build changes. The initial local implementation remains on `feat/mobile-rich-chat-20261120` as a checkpoint; it is not the branch to merge.

The November 27 integration brought in #152's durable outbox, Stop error reporting, and project-bound attachment flow. The composer keeps the attachment picker before the recipient and leaves it hidden while a conversation starts. The transcript reserves room for both the composer and any expanded notices.

## User-visible behavior

- Native Markdown renders paragraphs, headings, emphasis, lists, task lists, quotes, links, inline code, fenced code, tables, and supported images. Code has a Copy action. Tables and code scroll horizontally inside the reply. Embedded raster images stay inline. External images in Markdown and typed parts show their host and load only when the reader selects Load external image. Web links and image addresses with embedded credentials are refused.
- Citations no longer produce a stack of generic rows. One source control opens a deduplicated sheet that distinguishes explicit references from retrieved research pages.
- Each assistant message has one activity control for supplied reasoning, tool inputs/results, and event details. Terminal states override stale progress. Hosted TheoPresence owns the generic live caption, avoiding a second Working label while preserving specific progress and history.
- Native App revisions and automatic App checks retain their existing rendered components, request identities, run IDs, and running state. App checks remain mounted in the reply body.
- Approval and calendar cards retain their existing actions. Completed tools retain results and errors, including false, null, zero, empty strings, and alpha10 results with omitted safeOutput; stale pending metadata cannot offer a second decision.
- Files, images, attachment states, public errors, completion-limit notices, and follow-ups have dedicated presentations. Unknown content and metadata remain inspectable. Bigint values appear as exact decimal strings.
- Copy and Share use the native clipboard/share sheet. Existing user-message long-press and accessibility copy actions remain.
- The composer uses native clear Liquid Glass when both compiled-design and runtime checks support it. Reduce Transparency and unsupported systems use a solid theme surface. A material change leaves the input mounted.
- The transparent dock reserves its measured height in the transcript. The multiline input grows to 180 points, then scrolls internally. Main's native safe-area/keyboard behavior and 16-point composer radius remain.
- The attachment entry sits before recipient context in new and existing conversations and continues through the existing intake flow. Its menu stays within the window's safe horizontal margins. Split-pane sharing and remote-agent controls retain their current behavior.
- During a hosted run, Queue submits through the existing outbox without interrupting the run. Stop remains a separate explicit action. Normal Send uses Assistant UI's primitive and readiness rules.

## Runtime and content boundaries

The current SDK is the vendored `@theoremharness/sdk` 0.6.0-alpha.10 from main. HeadlessConversation, the external-store binding, journal, draft store, outbox, and selection remain their existing owners. This change adds no SDK endpoint, direct mutation transport, approval replay, or inferred progress.

The active-run Queue button needed a native action because the generic Assistant UI Send primitive disables running sends without an Assistant UI queue adapter. Theorem already owns its outbox. The action uses the public `runtime.thread.composer.send({ startRun: false })`, preserving the existing onNew/outbox path and avoiding cancellation of in-flight tool execution. It honors thread/composer readiness and the surface's blocked state. Main's SQLite outbox keeps waiting messages and their Stop pause across app termination.

Source policy follows the web implementation: web_search and web_read supply retrieved research, while explicit reference parts remain distinguishable. URL deduplication cannot silently promote retrieval into an explicit reference. Public links use the contextual browser. Email links retain main's existing handoff.

Uploads show only supplied states. Protected upload IDs remain identifiers and are never turned into guessed download URLs. Attachment deduplication uses stable identity, not filename. Unsupported image formats retain readable metadata and an explicit preview limitation.

## Implementation map

| Area | Sources under mobile/src |
| --- | --- |
| Native Markdown and streamed parsing | features/chat/rich-text.tsx, rich-text-markdown.ts, markdown-text.tsx |
| Part placement, source/status/attachment policy | features/chat/message-presentation.ts |
| Reply layout and native actions | features/chat/message-view.tsx |
| Activity and per-part error recovery | features/chat/reply-details.tsx |
| Source sheet | features/chat/sources-sheet.tsx |
| Files, images, approvals, Apps, and typed output | features/chat/output-part.tsx |
| Composer and transcript geometry | features/chat/conversation-surface.tsx |
| Attachment placement | features/chat/conversation-pane.tsx, new-conversation.tsx |
| Material and accessibility | ui/control-material.tsx, material-policy.ts, theme.tsx |

The renderer uses react-native-marked and Assistant UI's native renderer pattern. Complete-document parsing retains reference links defined later in the reply. Deferred/throttled updates and stable element keys reduce streamed rendering churn. The reply adds no nested vertical list. The adapted renderer's MIT notice is in `mobile/THIRD_PARTY_NOTICES.md`.

The only dependency added relative to this main baseline is the explicit `marked` 18.1.3 dependency, matching the already-installed transitive parser. Main already provides react-native-marked, react-native-svg, and expo-glass-effect. No native module, entitlement, capability, extension, bundle identifier, or SDK tarball changes are part of this integration.

## Verification

The November 27 integration and review fixes passed the app and test TypeScript checks, 251 mobile tests across 26 files with a space in the temporary directory path, and the iOS production export of 2,594 modules (8.3 MB Hermes bundle). The earlier build results below apply to the original mobile branch revision.

An existing native development client on the iOS 26.5 simulator loaded the reviewed branch through Metro. The app used its supported development-token sign-in against an isolated local Theorem authority. Signed-in Chat accepted composer input, recorded a new message, and queued a follow-up while a run was active. Pressing Stop paused the outbox and left the follow-up visible. The model was a local fixture. The simulator's regular OAuth path returned Apple's missing webcredentials-association error because the installed binary carried no associated-domains signing entitlement.

- App and test TypeScript configurations passed.
- Full mobile suite passed: 231 tests, 0 failures, 1,342 assertions across 25 files.
- iOS production export passed: 2,592 modules and an 8.3 MB Hermes bundle.
- Independent reply review verified preservation of App/check/calendar/approval rendering, alpha10 completion semantics, sources, attachments, and unknown content.
- A one-off contract check against the actual installed Assistant UI core verified running send with startRun:false calls onNew exactly once, clears the sent draft, preserves a newer draft, leaves the run active, and never calls onCancel. Disabled/readiness/whitespace gates retain their expected behavior.
- Regression coverage includes source consolidation, terminal status, stale approvals, bigint details, attachment identities/states, unknown content, streamed Markdown, and material availability/accessibility gates.
- Current native Debug simulator build passed with Xcode 27.2 / iPhoneSimulator SDK 27.2, targeting phone-composer on iOS 26.5. Clean CNG prebuild, CocoaPods installation, and direct xcodebuild completed successfully (BUILD SUCCEEDED, exit 0). Dependency and CocoaPods module-setting warnings remain; the build had no compiler errors.
- The resulting rs.theorem.app installed over the existing simulator app and launched successfully through simctl (both exit 0). The startup capture showed Expo's development launcher with the existing localhost:8097 server, beneath the system Open in Theorem confirmation. This verifies installation and process launch; the capture did not show authenticated chat.

## Device review and remaining scope

Authenticated simulator coverage is recorded above. A production-signed build, normal OAuth sign-in, and a physical iPhone remain outside that evidence. The keyboard transitions, source sheet, dark theme, and Dynamic Type still need device review.

The next review should open a real rich reply, verify code/table horizontal scrolling and source links, exercise Copy/Share and attachments, check Queue/Stop with a real run, and inspect the composer above the tabs with the keyboard open and closed. Check light/dark, Reduce Transparency, and larger text. Those observations are separate from automated and build results.

Protected upload previews still need a confirmed typed content capability. Math, Mermaid, syntax highlighting, full canvas editing, new custom question/action routes, computer onboarding without manual SSH, and terminal redesign remain later work. Existing native App previews stay available; this pass does not expand their execution contract.

## References

- https://www.assistant-ui.com/docs/react-native/elements
- https://github.com/assistant-ui/assistant-ui/blob/main/packages/ui/src/components/react-native/assistant-ui/elements/markdown-text.tsx
- https://docs.expo.dev/versions/v58.0.0/sdk/glass-effect/
- https://docs.expo.dev/router/advanced/native-tabs/
