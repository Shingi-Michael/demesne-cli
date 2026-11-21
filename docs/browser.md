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

- **Watching costs the model nothing.** The model still reads the page as an outline. The pictures are for you: while the split shows, the page streams JPEGs of itself (Chromium draws them small and encodes them, and sends the next only once the last is taken), at most ten a second, and stops a few seconds after the split closes. The page is drawn as wide and as tall as the split.
- **Pages follow Demesne's light or dark.** A site that has a dark version (`prefers-color-scheme`) shows it when Demesne's theme is dark, and its light one when Demesne is light, whatever the computer is set to. A site with only one look keeps it: nothing is recoloured, so the model checks pages as people see them. Read more: [`prefers-color-scheme`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme), [Electron `nativeTheme`](https://www.electronjs.org/docs/latest/api/native-theme).
- **A hidden page draws sparingly.** An offscreen page copies every frame it draws, so a tab nobody watches draws 10 frames a second and a watched one 12, not 60. On this computer's pages the browser follows requests (for `requests` and `response`); on public sites it doesn't. Measured on an animated page: 89% of a core to 16% unwatched, 128% to 60% watched.
- **A sign-in is yours.** When the model hands the page over, the line under it turns amber and says what to do. Click into the page and type: your clicks, scrolling, keys and pastes go to the page, and only while it is yours. Press Hand back when you are done. If you don't within 15 minutes, or the turn is stopped, the model is told and carries on without it.
- **It stays until you close it.** After the answer the last page stays, so you can look at it. × gives the chat the whole window back; the split then stays closed for that turn, and opens again the next time a turn browses, when the model hands you a page, or when you click one of the browser's steps. Drag the line between chat and browser to change its width; the width is kept.
- **Sign-ins are kept per project.** Each project has its own browser profile on disk (`browser-profile/` beside Demesne's database), shared by its chats, so you sign in to a site once. A sign-in stays after a restart, including one that lasts only for the session (it is saved when Demesne quits). A chat outside a project has its own cookies, kept in memory only.

Read more: [Visibility of system status](https://www.nngroup.com/articles/visibility-system-status/) (why showing what the model is doing matters), [offscreen rendering in Electron](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering) (how a hidden page still paints, and why its frame rate matters), [CDP `Page.startScreencast`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast) (how the page streams its pictures), [`webContents.sendInputEvent`](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent) (how your clicks and keys reach it), [sessions and `persist:` partitions](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options) (how a project's cookies are kept on disk), and [HTTP cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies) (why a session cookie ends when the browser does, and a persistent one does not).

## More of a real browser

- **Where it clicked.** A soft blue ring shows on the page where the model last clicked, hovered or typed, and fades in about a second and a half.
- **The page fits the split.** While you watch, a desktop-width page is laid out at the width the split shows it, so it is shown at its own size: nothing is shrunk, and a responsive site arranges itself for the room it has. Drag the line between chat and browser and the page follows. When nobody watches, the page is 1280 wide again for the model's own work; a page the model opened at phone width keeps it.
- **As sharp as your screen.** A hidden tab draws at the sharpness of the screen the split is on (two device pixels per page pixel on a Retina screen), so text in the split is crisp and sites serve their high-resolution images. It is fixed when a tab is made: a Mac is taken as Retina until a split has said otherwise. Read more: [`devicePixelRatio`](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio), [offscreen rendering's `deviceScaleFactor`](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering).
- **Smooth while it is yours.** A page you hold draws and sends 30 pictures a second (12 while you only watch), and the next picture is asked for at once. Measured in the real app: 10 pictures a second and 112 ms from a scroll tick to the picture before, 30 and about 64 ms now (`scripts/check-browser-smooth.ts`).
- **Take over any time.** **Take over** under the page makes it yours without the model asking. The bar gains back, forward and reload, and the address becomes yours to type (a bare `example.com` gets `https://`; a local network address is refused). While you hold it the model's next browser step waits for you, and when you hand it back the model is told you used the browser and reads the page again before acting. You can go to any public site while it is yours, and those sites stay open to the tab afterwards.
- **Pages it went to.** Under the page, **Pages** lists the last pages the chat's browser went to. Click one to see it as it looked then, and **Back to live** to return.
- **Tabs and sign-in windows.** A page's new window (a "Sign in with Google" popup, a link that opens a new tab) opens as another tab of the chat, still linked to the page that opened it, so a popup sign-in can finish. Up to six tabs. The model sees the list (`tabs`), switches (`switch`) and closes them (`close_tab`); a click that opened one says so and puts the model on it; a popup that closes itself puts it back on the tab before. With more than one tab, chips above the page show them, and while the page is yours a chip switches to it.
- **Files.** `upload` puts project files into a page's file field (only real files inside the project, up to ten). A download lands in the project's `.demesne/downloads/` folder, up to 50 MB, and the model is told where; a chat outside a project downloads nothing.
- **Session sign-ins last.** A sign-in that lasts only for the session is saved when Demesne quits and restored the next time the project's browser starts, so you sign in once.
- **For the model's own pages.** On this computer's pages the model can list the requests the page made (`requests`), read what the server answered (`response`, up to 6,000 characters) and see how a control is drawn (`inspect`: its box and the styles that place and colour it).

Read more: [CDP `Network.getResponseBody`](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getResponseBody) (how the server's answer is read), [CDP `DOM.setFileInputFiles`](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-setFileInputFiles) (how a file reaches a file field without a dialog), [`setWindowOpenHandler`](https://www.electronjs.org/docs/latest/api/window-open) (how a popup becomes a tab), [Electron `DownloadItem`](https://www.electronjs.org/docs/latest/api/download-item) (where downloads go), [`window.open` and the opener](https://developer.mozilla.org/en-US/docs/Web/API/Window/open) (why a sign-in popup needs the page that opened it), and [`getComputedStyle`](https://developer.mozilla.org/en-US/docs/Web/API/Window/getComputedStyle) (the styles `inspect` reads).

## Where it can go

**This computer, without asking.** `localhost` addresses (any port) and `.html` files in the project, like reading a file.

**The internet, once you say yes.** Opening a site (a full `https://` address) asks first: "Browse github.com". The answer covers the site and the sites under it (`docs.github.com`), once, for this chat, or always (saved as `browser:github.com` in your config; a bare `browser` entry allows every site). A chat on Auto does not ask.

After that the tab stays on the sites you approved:

- A link or a redirect to another site is not followed. The model is told where it led, and has to open that address itself, which asks you.
- A public page can't reach back into this computer or your network: its requests to `localhost`, `192.168.…` and the like are cancelled, and a link from it to a local address is not followed. Addresses that resolve into the local network are refused.
- A page's requests for the camera, location or notifications are refused. Downloads go only into the project's `.demesne/downloads/`.
- Nothing of yours is signed in. The browser has its own profile per project, never your own browser's, holding only what you signed in to when the model handed you a page.
- What a public page says is marked as information, not instructions, and a site's own console noise is not reported.

To only read an article, `web_fetch` is cheaper. The browser is for pages that need clicking, typing, or scripts to show anything.

## In the chat

Each call is an ordinary step: "Opened localhost:5173/login", "Typed “Ada” into textbox “Name”", "Clicked button “Sign in”". The rows name the control, never its number.

## How it is built

- `apps/desktop/electron/browser-host.ts`: the app started as `Demesne --browser-host`. No window, no Dock icon, its own temporary profile. It reads commands as JSON lines on stdin and answers each on stdout, and quits when the daemon closes its input.
- `apps/desktop/electron/browser-runtime.ts`: the script put in each page that builds the outline and keeps the numbers (on top of `foundry-try.ts`, which finds controls and says what changed).
- `apps/daemon/src/browser.ts`: the `browser` tool, and `electronBrowser`, which starts the host on first use and starts it again if it dies.
- `apps/desktop/workspace/browser-split.ts` and `renderBrowserSplit` in `live.ts`: the split beside the chat, the picture loop (`browser-frame`), and your input while the page is yours (`browser-input`, `browser-take`, `browser-go`, `browser-hand-back`, `browser-visit`). The daemon routes are `GET /v1/sessions/:id/browser/frame` and `…/browser/visit`, and `POST …/browser/take`, `…/go`, `…/input` and `…/hand-back`; input and going somewhere are refused unless the page is yours.
- `scripts/check-browser.ts`: drives a small local app through the real hidden browser (`xvfb-run -a bun scripts/check-browser.ts` on Linux, after `bun scripts/prepare-desktop.ts`), then watches it, hands it over, and checks that a sign-in is shared by a project's chats and lasts a restart; then popups and tabs, an upload and a download, a server's answer, a control's styles, taking the page and going back, and a session sign-in after a restart.
- `scripts/check-browser-scroll.ts`: the real app while a taken page scrolls; the split is photographed throughout and must never be blank between pictures (they are drawn on a canvas once decoded, never swapped as an image's `src`).
- `scripts/check-browser-split.ts`: the real app with a scripted model that opens a page, hands it over and clicks; it checks the split opens, your click and keys reach the page, the click ring, Hand back, Take over with a typed address, back, an earlier page, and ×.

A window a page opens comes up offscreen with no size in Electron, so it takes no clicks; the host gives it one through the debugger once its page is up.
