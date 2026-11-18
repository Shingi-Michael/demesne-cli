# Foundry

[Documentation index](README.md) · [Desktop guide](desktop.md)

Foundry is where the model shows you something: a mockup, a prototype, a chart, a deck, a document. You look; what to change goes to the chat.

## The design guide

Every page the model designs follows a design guide. It has three layers, and a later one wins over an earlier one:

1. **Demesne's rules.** Sixteen numbered rules ([design-guide.ts](../apps/daemon/src/design-guide.ts)): a direction first, one focal point, type and space from the kit's scales, a small palette, an even layout, rows with hairlines, real content, a mockup that works at real size, two or three options with a pick, quiet motion, no stock AI looks, every state designed, and plain words (a button starts with a verb, an error says what happened, why and how to fix it). Plus how Demesne itself looks, for a mockup of Demesne.
2. **Your guide for every chat**: `~/.demesne/design.md`.
3. **The project's guide**: `.demesne/design.md` in the project (a `DESIGN.md` at its root is read when that file is missing).

Your files are plain Markdown, up to 8 KB each. Write them however you like; short rules work best:

```markdown
# Design guide

## It starts from what you have

A mockup of something that exists (your app, your site, Demesne itself) is drawn from the real thing, not from memory.

- Before the first save, the model looks: it captures the window, reads the project's real stylesheet and that screen's markup, opens the page in its browser, or uses a picture you attached.
- Every new mockup says what it started from (`why.starts_from`): the thing it looked at, or "new" when nothing like it exists yet. A page that draws Demesne can never call itself new.
- When it names something real and the chat has not looked at it, the save is refused once with how to look. If it truly cannot look (no window, no files), it says "could not look" and tells you so in its answer.
- The page shows your screen as it is today first ("Today"), then the change, so the change is the only difference. Today is the comparison and does not count as one of the three options.

What counts as looking is kept per chat (`apps/daemon/src/foundry-seen.ts`); the check is `checkStart` in `apps/daemon/src/foundry.ts`.

## It reviews what you have, and mocks the parts that matter

Ask Foundry to look at something that exists and show what needs work ("look at my settings page and show me what most needs a redesign", "what in the sidebar needs work?"), for your app, a website or a picture you attach. It reviews before it draws:

1. It starts from **a real picture** of it (pass 240 A): a capture of the window (`capture_window`, with application Demesne for Demesne itself), the browser's picture of a web page, or a picture you attach. When none can be had, it asks you for a screenshot instead of drawing the screen from what it read. Until pass 240 every real review read the source and drew "Today" again, and the redraw was never the screen you see (a light window for a dark one, an empty chat, no cards).
2. It goes through the screen in the order it critiques its own pages (first impression, usability, hierarchy, consistency, accessibility), rates each problem, and keeps **the two or three parts** that most need work, most important first (one only when nothing else comes close). A part is the smallest piece that holds the problem (a bar, a card, a row), never the whole page. A review saved with one part is asked once whether a second piece needs work as much. The sheet and its sections are written as plain markup, never built by a script, so Foundry can read the parts before it saves; a sheet built by a script is sent back saying so.
3. It saves **one mockup**, a review sheet. On top is that picture, your screen exactly as it is, with each part outlined in pink and numbered. Under it is each part alone, at its own size, with one line on what is wrong: **Today**, cut from the picture, then Foundry's pick (edged in pink), then one or two other options, which are drawn. Nothing else on the screen is redrawn.
4. The chat answer names the parts in order, the pick for each and why. You answer there ("1 and 3 as picked, try 2 again").

When you name the piece yourself ("the top bar feels busy"), it skips the ranking and mocks that piece the same way.

Options are the rule everywhere: unless you ask for one exact thing ("make this button blue"), a design question gets two or three different directions and a pick.

How it is built:

- The sheet is a kit part, `<d-review>` (`apps/desktop/foundry-kit/parts.js`). The model writes the screen (`<section data-today><d-shot src="IMAGE_ID" marks="x,y,w,h | x,y,w,h"></d-shot></section>`) and the parts (`<section data-part="Top bar" why="…">` holding a `<d-compare recommended="…">` whose Today is `<d-shot src="IMAGE_ID" box="x,y,w,h">`). Foundry draws the outlines, the numbers, the names and the pick, so the model writes no headings or captions.
- `<d-shot>` shows a picture the chat has, by its image artifact id, at its own size in points (a 2x capture of a 1440 point window shows 1440 wide, never stretched). Boxes are in the picture's own pixels, which the capture's result states; `marks` boxes the parts for the outlines, `box` shows one piece with 8 points of room (`pad`). The window capture says its size in points beside its pixels (`apps/daemon/src/window-capture.ts`); a picture you attach without one is taken as 2x when it is wider than 2400 pixels.
- The picture is **kept with the mockup** (the `foundry_shots` table: the picture's record, its bytes stay in the artifact folder by hash), so the review outlives the chat it was made in. The app serves it to the mockup's frame at `foundry://shot/<mockup>/<picture>` (`apps/desktop/electron/main.ts`; the frame's policy allows pictures from inside the app and still none from the web), and Foundry's own look gets it in its job.
- A save checks every `<d-shot>`: the picture is one this chat has (or one the mockup already keeps), and every box lies inside it; a miss names the chat's pictures. Pictures you attach now reach the model with their image artifact id.
- `<d-crop to="#desktop-toolbar">` shows one piece of something bigger at its own size: its inside is laid out at full width and everything but the piece is cut away. A part of Demesne is the real window, cropped, with one change. Wide pieces stack; small ones sit side by side.
- A save is held to that shape (`reviewProblem` in `packages/protocol/src/foundry-stage.ts`): a real picture of the screen as it is today, every part marked on it, one to three parts, each with a why, a Today cut from the picture, two or three options and a pick. A review is always looked at first, is saved as one growing sheet, and is not asked for a demo.
- Foundry's own look does not judge a review sheet as a poster, and ignores what a crop cuts away.
- `xvfb-run -a bun scripts/check-foundry-review.ts` checks the sheet in the real app, from a picture of the app pasted into the chat; `apps/desktop/test/foundry-review.dom.test.ts` and `foundry-shot.dom.test.ts` check the kit parts in a browser (`DEMESNE_DOM_TESTS=1`). The quality eval sends its two review asks with a picture from `scripts/shoot-desktop.ts` (`--pictures`).
- Not yet: for Demesne itself the app could name where its pieces sit in the capture, so outlines never depend on the model's boxes. The daemon has no way to ask the running window today, so the model gives the boxes.
- Until pass 223 Foundry's instructions called changes to the project's own interface "code work", which steered it away from mocking your app. Showing how it could look is now Foundry's job; building it is code work.

Read about it: [how to conduct a heuristic evaluation](https://www.nngroup.com/articles/how-to-conduct-a-heuristic-evaluation/) (the method), [design critiques](https://www.nngroup.com/articles/design-critiques/) (feedback on the real work, not a description of it), [devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio) (why a 2x capture has twice the pixels of its points), [severity ratings for usability problems](https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/) (how the three parts are chosen), [parallel and iterative design](https://www.nngroup.com/articles/parallel-and-iterative-design/) (why several options beat polishing one).

## It checks what was built against your pick

When you pick an option and say "build it" (or "build B", or @ the mockup), the chat writes the code and, before it says done, looks at what it built next to what you picked (pass 241 A). It works for whatever you are building:

1. **It looks at the result** the way it looks at anything it built: a web app or site through its local server or file (`look_at_page`), a desktop app, a phone app in its simulator or Demesne itself through its window (`capture_window`), or the browser's picture.
2. **It sees your pick beside it.** `foundry_built` without differences shows the model the option you picked, drawn by Foundry alone the way the long page stages it (`?stack=1&option=N`), next to its own picture of the build.
3. **It names what differs, at most three things,** biggest first, each boxed on its picture; smaller ones are only counted ("and 4 more"). Something meant to differ, like sample words or made-up numbers, is left out.
4. **It fixes them and looks again,** three looks at most in one turn. What it leaves different, it names and says why.
5. **Foundry keeps a "Built" record** beside the mockup ("Plans page, built"): your pick beside the real result with "matches your pick" or what still differs, and the first look with its rings and each difference marked fixed. Every look in one turn lands on the same record; a later build is its next version. Demesne writes the record from the looks, so `foundry_save` and `foundry_edit` refuse to change one, and it takes no notes. The chat ends with one chip: "Built like the mockup · matches".

When the result can't be seen (no server running, the app not open), the chat says what it could not look at instead of guessing. `foundry_read` of a mockup reminds the model to check a build this way, and the tool goes only to chats in a project, since it follows a build. The check is `scripts/check-foundry-built.ts` (a web app's plans page, built twice, in the real app).

Read about it: [Visual comparisons](https://playwright.dev/docs/test-snapshots) (Playwright docs: a test that compares a screen with a picture of how it should look), and [Design critiques](https://www.nngroup.com/articles/design-critiques/) (Nielsen Norman Group: feedback on the real work, not on what should have made it).

## Rules

- Blue stays the accent. Pink only marks where you are.
- A list always has hairline dividers in one rounded box.
- No menus and no side panels.
```

**Say a rule once and it is kept.** Tell a chat "never use purple" or "lists always get dividers" as a standing preference and the model saves it with the `remember` tool (`design: true`). It lands under `## Rules` in the project's guide, or in `~/.demesne/design.md` when the chat is outside a project, and holds from the next mockup on. It asks before writing, like any file change. A one-off ask about the page in front of you is not saved.

The guide reaches the model as its own numbered block in its instructions, from the moment the chat has Foundry's tools, with your rules marked as winning. It used to be one long paragraph inside the `foundry_save` tool's description, with nowhere for your rules to go. The tool's description now only says how the tool is called.

The ready kinds (deck, doc, dashboard) are drawn by Demesne from content, so the guide applies to pages the model designs itself: `html` and `svg`.

## A mockup of Demesne is drawn with Demesne's own styles

Foundry used to keep a small hand-made copy of the app for mockups of Demesne, and the copy drifted: it still listed Assistant and Customize, had no right cards, and drew the composer differently. Now there is no copy of the look.

- `<d-demesne>` draws the window with the app's own markup and loads the app's own stylesheet, `foundry://kit/app.css`. That file is made at build time from the four sheets the window loads (`ui.css`, `live.css`, `desktop.css`, `workspace.css`) by `apps/desktop/foundry-kit/scope-app.ts`.
- The app's rules assume they own the page, so they are fenced in: everything sits in `@scope (d-app)`, `html` becomes the scope's root and `body` a `<d-body>` inside it, viewport units and width queries become container units and container queries, and the whole sheet is one cascade layer.
- Because it is a layer, a mockup changes the app by its real names (`.sidebar-new{…}`, `#composer .composer-box{…}`) and always wins, without out-weighing the app's selectors.
- The kit's own styles (`base.css`) stop at the window, so nothing from the kit leaks into the app's look.
- Messages, the composer and cards the author writes (`<d-message>`, `<d-composer>`, `<d-card slot="cards">`) become the app's own turns, composer and right cards.
- `scripts/check-foundry-app.ts` opens the real app and the part on the same chat at the same size and fails when a piece of the window sits somewhere else, has other type or colours, is missing, or is invented. When the app's markup changes, bring `SHELL` in `apps/desktop/foundry-kit/parts.js` along and run it.

The window is glass over your desktop; in a mockup a still grey backdrop stands in for what is behind it.

## The page holds only the thing

A mockup used to carry controls that were not part of the design: Foundry's own option strip and deck buttons were drawn inside it, and since Foundry could not play a demo, models wrote Replay and Next step buttons into the page. Every page also sat in the same tall white box. Now Foundry owns the surface and the demo, and the page holds only what is being made.

- **Surface.** `foundry_save` and `foundry_edit` take `surface: {frame, width, height, backdrop, title}`. The frame is `window`, `browser`, `phone`, `part` (just the piece, at its own size) or `page`; the backdrop is `desk`, `paper`, `dark` or `white`. The Foundry page draws that frame and backdrop around the page at real size and only shrinks it to fit. A part or a page with no height grows to its content (the page tells the Foundry page its height). Without a surface a page sits in the plain stage as before.
- **Demo.** They also take `demo`: the steps `foundry_try` uses (`click`, `type`, `key`, `hover`, `scroll`, `wait`), each with an optional `say`. While the mockup is on screen the Foundry page plays it on the page itself with a drawn pointer, and the `say` lines appear under the stage, never on the drawing. Hover styles work because each `:hover` rule in the page gets a twin the pointer can set. Moving into the stage stops the demo and the page is yours to use; a moment after you leave it starts again on a fresh page. What a demo types is never saved to the page's memory. `foundry_try {id, demo: true}` runs the saved demo, so the model checks it before you see it. A step that finds nothing ends the demo quietly.
- **Kept until changed.** A surface or a demo stays on later versions until a save gives a new one; `foundry_edit` with only `surface` or `demo` changes them without a new version.
- **Options** in `<d-compare>` get a stage each on the Foundry page, named on the line above it with the recommended one first; nothing is drawn inside them.
- **Decks** draw no strip or arrows on the Foundry page: they play their slides, with the slide count under the stage, and the arrow keys still move.
- **Demo-only buttons are sent back.** A save whose page draws a button whose whole text is Replay, Play demo, Next step, Previous step or the like is refused once per ask with the reason (`[demo_control]`); saved again unchanged, it goes through, for the rare design that really has one.

The player is `apps/desktop/foundry-kit/demo.js`, put in front of pages on the Foundry page with the try runtime (`foundry-try.ts`); the stages are `apps/desktop/workspace/foundry-stage.ts`. `xvfb-run -a bun scripts/check-foundry-demo.ts` checks it in the real app.

## Notes on the parts

A correction used to mean going back to the chat and describing where the thing was ("the second row, the button on the right"). Now you say it on the mockup itself, part by part (pass 233 A). At rest the Foundry page shows nothing new.

- **Rest on a part.** When the pointer rests on a part of the newest version of a mockup, the part gets a thin pink outline and a small tag with its name ("Save button · Comment", "Overdue card · Comment"). A part is the smallest piece you would name: a control, a row, a card, a heading. A word or an icon belongs to the piece that holds it, and the frame around the mockup is never a part. The mockup's own clicks still work, and a playing demo still stops when you move in.
- **A note, then a pin.** The tag opens a one-line note. Enter keeps it as a numbered pin on the part; Esc puts it away. A pin opens its note again, and clearing the words removes it. Notes wait on the mockup while you are elsewhere in the app (they are not kept when the app is closed).
- **Sent together.** One quiet line under the mockup says how many notes wait: click it, or press ⌘↵ (Ctrl ↵ off the Mac), and they go as one message to the chat that made the mockup, so one new version holds every correction. ⌘↵ in an open note sends at once. You stay on Foundry; the chat opens under the page, and the message waits behind a turn that is still running.
- **What the model gets.** The message reads as you wrote it, part by part ("1 · Save button: make it green"), and on a mockup with options each note says which option. Folded under it ("Marked parts · N" in the chat) are the mockup's id and version, each part's place in the markup and its few lines of markup, with the instruction to change only those parts in one `foundry_edit`. A picture of each part as you saw it rides along, cut from the window with nothing of Demesne's over it (up to ten pictures a message).
- **What comes back.** While the model works the line says so. The new version arrives on top with the changed parts outlined for a few seconds, and its "You asked" line is your notes. If the model answered in words instead, the line says no new version came back.

The mockup's frame only reports: `apps/desktop/foundry-kit/note.js` says which part is under the pointer and where the noted parts are, and draws nothing. The outline, tag, pins and note are the page's (`apps/desktop/workspace/foundry-notes.ts`), over the frame at real size. Pictures are `desktop-crop` in `apps/desktop/electron/main.ts`. `xvfb-run -a bun scripts/check-foundry-notes.ts` checks it in the real app.

## It remembers the course

A page's source leaves the chat once its turn is over, so a later ask used to start from a title alone. Now reading a mockup (`foundry_read`) hands back its brief with the source: for each ask so far, what you asked, the direction taken, what leads, what was dropped and what it started from. The first ask and the newest five are kept. The model is told to answer the newest ask, keep every earlier decision you did not change, and never bring back what was dropped unless you ask. (`briefOf` in `apps/daemon/src/foundry.ts`.)

## Every mockup says why

Each version of a page the model designs (`html` or `svg`) carries a short **why**, written when it is saved:

- **Direction**: who it is for and the mood it went for.
- **Look at**: what leads, and so what to look at first.
- **Dropped**: what it tried or considered and left out. Left empty when nothing was.

On the Foundry page the why sits under the description as three quiet lines, one per version, so the history reads as a line of decisions. The model's answer in the chat says the same thing in plain words, so you never have to open Foundry to learn it.

`foundry_save` and `foundry_edit` take it as `why: {direction, look_at, dropped}`. A save that makes a new page version without it is turned back with a hint. The model fixing its own page in the same ask (after a look or a try) keeps the why it already gave. A later ask is a new version, so it says what changed and why. `foundry_edit` with only `id` and `why` sets the why of the latest version without making a new one. Versions saved before this, and the ready kinds, have none. It is stored per version in the `why` column of `foundry_versions`.

## A critic before you see it

After a page is saved, Foundry renders it off screen once, at 1280 pixels wide (a phone screen, surface `phone`, at 390 instead), and the model gets the picture back ([foundry-look.ts](../apps/daemon/src/foundry-look.ts)). Besides layout faults, the look now carries the page's **design numbers** against targets, each tied to the design guide rule it checks:

| Number | Target | Rule |
| --- | --- | --- |
| Text sizes | 3 to 6 | 3, type from the scale |
| Lead | biggest text 2.8× the body or more | 2, one focal point |
| Rhythm | 90% of spacing from six steps | 4, space from the scale |
| Aligned | 85% of text blocks share a left edge | 6, an even layout |
| Colours | 3 to 8 | 5, a small palette |
| Surface | a third of the first screen is more than blank paper | 8, depth where it earns it |

These are the same numbers the quality eval scores (`scripts/foundry-quality.ts`); until now only the eval saw them. They judge pages the model designs (`html`); the ready kinds are drawn by Demesne.

Not every page is a poster, so not every number judges every page:

- A mockup of the app itself (`<d-demesne>`) is not judged on Lead or Surface: no headline leads a window, and its surfaces are the app's own.
- A small thing saved on the `part` surface (a button, a row, a toast) is not judged on Lead or Surface either, and it may hold one text size and two colours. Told that "nothing leads" and "the screen is mostly blank", a model grows a small ask into a page.

After a look, the model tries the path the ask is about once with `foundry_try`. Controls off that path are drawn, not built, and may stay still: the model is told never to add a dialog, a form, a screen or data to make one work. (Until pass 222 it was told to click every control and make each dead one do something, which is how "a little dashboard" came back with two dialogs and saved data.)

The quality eval (`scripts/eval-foundry-quality.ts`) has twelve whole-page asks, three small ones (`small-pin`, `small-toast`, `small-toggle`) and two reviews. Beside the look score it prints **As asked**: for the asks that fix something, the share of those points the page keeps (the surface the ask names, how many versions it asked for, and no more dialogs, forms, controls or bytes than the ask needs), with each miss in words. Open design questions are owed two or three options and a pick, and two review asks (`review-settings`, `review-sidebar`) are owed a review sheet that holds.

When the look finds a fault or a number off target, the fix has to say what it is fixing first. `foundry_edit` takes a `critique`: the rules the page breaks, by number, and what will change. A fix without one is turned back, and a whole new source through `foundry_save` is pointed to `foundry_edit`. A number can stay off target on purpose, with the reason in the critique. The critique is the model's own working: it is not kept and never shown to you. One fix per ask, as before.

The critique runs in a fixed order, so nothing is skipped: first impression (what the eye lands on in two seconds), usability, hierarchy, consistency with the guide and the numbers, then accessibility. Each problem is marked critical, moderate or minor, the fix goes to the first two, and one thing that works is named so the fix doesn't undo it.

The look also holds pages to the accessibility standard (WCAG 2.1 AA): text needs 4.5:1 contrast against what is behind it, or 3:1 from 24px up (18.66px when bold), and on a phone screen anything to tap must be at least 44 by 44 pixels. A link inside a sentence, a tick box with its label, a switched-off control and a desktop app drawn inside a frame are exempt. The kit's own muted text, status colours and phone-width buttons were adjusted to meet the same numbers.

The order of the critique, the states rule and the wording rules come from the checklists in Anthropic's design plugin for Claude ([knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins)).

## A mockup you can trace

Each version keeps the trail back to why it exists and forward to what came of it:

- **The ask that made it.** The message you sent is kept with the version and quoted under the name ("You asked …"), cut to a line, in full on hover. It is a copy, so it stays after the chat is deleted. What the app folded under the message (pasted text, the marked parts of a mockup) is left out.
- **Based on.** When the model read another mockup in the same ask before making a new one, the new one is based on it, even if the model didn't say so. Naming `based_on` still wins.
- **Built in #N.** When the chat that made a mockup opened a pull request that has merged, the newest version of each mockup it made before opening that pull request says "built in #N", a link to the pull request on GitHub.
- **A name that says what it is.** `foundry_save` and `foundry_edit` turn back names like "Mockup", "Option B", "New design" or "v2", and names over six words. Options keep their letter in the version's note.
- **Search.** `foundry_read` with `query` lists the mockups whose name, description, version names, whys or asks hold every word, not only the newest fifty.
