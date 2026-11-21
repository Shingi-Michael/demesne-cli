# The model's own browser

Demesne has a browser that belongs to the model. It is a hidden window the model uses to check that the web app it is working on really works, the way a person would, by clicking through it, and to use a site on the internet when reading it is not enough. You don't drive it, but you can watch it beside the chat, and when a site needs a person (a sign-in) the model hands the page to you.

It is the `browser` tool. It is different from `look_at_page`, which takes one fresh look and forgets:

- **It stays open.** Each chat has one hidden tab that keeps its page, cookies and place between the model's calls. The model can sign in, go several pages deep, and come back. Another chat (or a thread) has its own tab and its own cookies. A tab left alone for 20 minutes is closed, and deleting a chat closes its tab.
- **It reads structure, not pixels.** A page comes back as an outline: its headings, and every control on a numbered line.

  ```
  # Sign in
  [1] textbox "Name"
  [2] button "Sign in"
  [3] link "The list"  → /list
  ```

  The model says `click` with `ref: 2`. A number holds for as long as that control is on the page, so the outline is sent again only when the address changes (or the model asks with `read`). A control's visible name works too.
- **It says what happened.** After each action the model is told what a person would have seen change ("new text “Signed in as Ada”", "went to /list", "nothing visible changed"), plus any new console errors and failed requests (`GET /api/save → 500`). A page's `alert`, `confirm` or `prompt` is answered and reported, since nobody is there to press OK.
- **Pictures only when asked.** `picture` returns a screenshot, at most six a turn. The outline and `text` (the page's words, 6,000 characters at a time) are far cheaper.
- **It can hand the page to you.** `hand_over` (with a `reason`, like "Sign in to the Slow Pour admin") gives you the open page for something only you should do: a sign-in, a code sent to your phone, a captcha. The model waits until you press Hand back, then reads the page again. It never sees what you typed, and it is told never to type your password or ask for it in the chat.

Actions: `open`, `read`, `text`, `click`, `type` (with `clear` and `enter`), `key`, `hover`, `scroll`, `back`, `forward`, `reload`, `wait` (for text to appear, or a time), `picture`, `hand_over`, `close`.

## Beside the chat (pass 248 D)

The first time a turn uses the browser, the window splits: the chat on the left, the model's browser on the right, live. It shows the page the model is on, the address at the top with a small light (blue while the model drives it, amber while the page is yours), and under the page what the model is doing.

- **Watching costs the model nothing.** The model still reads the page as an outline. The pictures are for you: while the split shows, the hidden tab sends a small JPEG of itself each time it repaints, at most five a second, and stops a few seconds after the split closes. The page is drawn as tall as the split, at the width the model uses.
- **A sign-in is yours.** When the model hands the page over, the line under it turns amber and says what to do. Click into the page and type: your clicks, scrolling, keys and pastes go to the page, and only while it is yours. Press Hand back when you are done. If you don't within 15 minutes, or the turn is stopped, the model is told and carries on without it.
- **It stays until you close it.** After the answer the last page stays, so you can look at it. × gives the chat the whole window back; the split then stays closed for that turn, and opens again the next time a turn browses, when the model hands you a page, or when you click one of the browser's steps. Drag the line between chat and browser to change its width; the width is kept.
- **Sign-ins are kept per project.** Each project has its own browser profile on disk (`browser-profile/` beside Demesne's database), shared by its chats, so you sign in to a site once. A site that keeps you signed in ("remember me") stays signed in after a restart; a sign-in that lasts only for the session ends when Demesne quits. A chat outside a project has its own cookies, kept in memory only.

Read more: [Visibility of system status](https://www.nngroup.com/articles/visibility-system-status/) (why showing what the model is doing matters), [offscreen rendering in Electron](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering) (how a hidden page still paints, and sends its frames), [`webContents.sendInputEvent`](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent) (how your clicks and keys reach it), [sessions and `persist:` partitions](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options) (how a project's cookies are kept on disk), and [HTTP cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies) (why a session cookie ends when the browser does, and a persistent one does not).

## Where it can go

**This computer, without asking.** `localhost` addresses (any port) and `.html` files in the project, like reading a file.

**The internet, once you say yes.** Opening a site (a full `https://` address) asks first: "Browse github.com". The answer covers the site and the sites under it (`docs.github.com`), once, for this chat, or always (saved as `browser:github.com` in your config; a bare `browser` entry allows every site). A chat on Auto does not ask.

After that the tab stays on the sites you approved:

- A link or a redirect to another site is not followed. The model is told where it led, and has to open that address itself, which asks you.
- A public page can't reach back into this computer or your network: its requests to `localhost`, `192.168.…` and the like are cancelled, and a link from it to a local address is not followed. Addresses that resolve into the local network are refused.
- Nothing is downloaded, and a page's requests for the camera, location or notifications are refused.
- Nothing of yours is signed in. The browser has its own profile per project, never your own browser's, holding only what you signed in to when the model handed you a page.
- What a public page says is marked as information, not instructions, and a site's own console noise is not reported.

To only read an article, `web_fetch` is cheaper. The browser is for pages that need clicking, typing, or scripts to show anything.

## In the chat

Each call is an ordinary step: "Opened localhost:5173/login", "Typed “Ada” into textbox “Name”", "Clicked button “Sign in”". The rows name the control, never its number.

## How it is built

- `apps/desktop/electron/browser-host.ts`: the app started as `Demesne --browser-host`. No window, no Dock icon, its own temporary profile. It reads commands as JSON lines on stdin and answers each on stdout, and quits when the daemon closes its input.
- `apps/desktop/electron/browser-runtime.ts`: the script put in each page that builds the outline and keeps the numbers (on top of `foundry-try.ts`, which finds controls and says what changed).
- `apps/daemon/src/browser.ts`: the `browser` tool, and `electronBrowser`, which starts the host on first use and starts it again if it dies.
- `apps/desktop/workspace/browser-split.ts` and `renderBrowserSplit` in `live.ts`: the split beside the chat, the picture loop (`browser-frame`), and your input while the page is yours (`browser-input`, `browser-hand-back`). The daemon routes are `GET /v1/sessions/:id/browser/frame`, `POST …/browser/input` and `POST …/browser/hand-back`; input is refused unless the model has handed the page over.
- `scripts/check-browser.ts`: drives a small local app through the real hidden browser (`xvfb-run -a bun scripts/check-browser.ts` on Linux, after `bun scripts/prepare-desktop.ts`), then watches it, hands it over, and checks that a sign-in is shared by a project's chats and lasts a restart.
- `scripts/check-browser-split.ts`: the real app with a scripted model that opens a page and hands it over; it checks the split opens, your click and keys reach the page, Hand back, and ×.

Not built yet: response bodies.
