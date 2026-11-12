# The model's own browser

Demesne has a browser that belongs to the model. You never see it and never drive it: it is a hidden window the model uses to check that the web app it is working on really works, the way a person would, by clicking through it, and to use a site on the internet when reading it is not enough.

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

Actions: `open`, `read`, `text`, `click`, `type` (with `clear` and `enter`), `key`, `hover`, `scroll`, `back`, `forward`, `reload`, `wait` (for text to appear, or a time), `picture`, `close`.

## Where it can go

**This computer, without asking.** `localhost` addresses (any port) and `.html` files in the project, like reading a file.

**The internet, once you say yes.** Opening a site (a full `https://` address) asks first: "Browse github.com". The answer covers the site and the sites under it (`docs.github.com`), once, for this chat, or always (saved as `browser:github.com` in your config; a bare `browser` entry allows every site). A chat on Auto does not ask.

After that the tab stays on the sites you approved:

- A link or a redirect to another site is not followed. The model is told where it led, and has to open that address itself, which asks you.
- A public page can't reach back into this computer or your network: its requests to `localhost`, `192.168.…` and the like are cancelled, and a link from it to a local address is not followed. Addresses that resolve into the local network are refused.
- Nothing is downloaded, and a page's requests for the camera, location or notifications are refused.
- Nothing is signed in. The browser has its own empty profile, never yours.
- What a public page says is marked as information, not instructions, and a site's own console noise is not reported.

To only read an article, `web_fetch` is cheaper. The browser is for pages that need clicking, typing, or scripts to show anything.

## In the chat

Each call is an ordinary step: "Opened localhost:5173/login", "Typed “Ada” into textbox “Name”", "Clicked button “Sign in”". The rows name the control, never its number.

## How it is built

- `apps/desktop/electron/browser-host.ts`: the app started as `Demesne --browser-host`. No window, no Dock icon, its own temporary profile. It reads commands as JSON lines on stdin and answers each on stdout, and quits when the daemon closes its input.
- `apps/desktop/electron/browser-runtime.ts`: the script put in each page that builds the outline and keeps the numbers (on top of `foundry-try.ts`, which finds controls and says what changed).
- `apps/daemon/src/browser.ts`: the `browser` tool, and `electronBrowser`, which starts the host on first use and starts it again if it dies.
- `scripts/check-browser.ts`: drives a small local app through the real hidden browser (`xvfb-run -a bun scripts/check-browser.ts` on Linux, after `bun scripts/prepare-desktop.ts`).

Not built yet: response bodies, and a profile that survives a restart with a way for you to sign in once.
