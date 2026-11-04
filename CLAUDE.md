# MPC (pickleball scheduling site)

A single-file page, `index.html`, that runs as a published Claude Artifact. It handles account sign-up and log in, roles, a session schedule with sign-ups and waitlists, session editing, and admin menus.

Published copy: https://claude.ai/artifact/HkcE3XFhhgEVB3Xn9BdF22 (private to the owner until shared from the Share menu). To update it, republish this file to that same URL with the Artifact tool.

## Push workflow

- Edits to `index.html` stay local until the owner says "push" (or "publish", "deploy", "update the site").
- On "push": read the live artifact first if this session has not read or published it, merge any newer live changes, then republish `index.html` to the URL above. Omit `icon`. Omit `capabilities` too, unless the stored declaration differs from the list under "How it works"; in that case pass the full list (a non-empty `capabilities` replaces the whole declaration).
- "Push" also saves to GitHub (repository https://github.com/kitworks-hub/Pickleball-project, branch `main`, remote `origin`). After the artifact publish succeeds, commit `index.html` and `CLAUDE.md` (`git add index.html CLAUDE.md`, a short commit message describing the change, ending with the Co-Authored-By line from the attribution reminder) and run `git push origin main`. Skip the commit if nothing changed. If the git push fails (for example the sign-in expired, or the remote has new commits: `git pull --rebase origin main` first), say so; the live site is already updated. Never force-push. Git sign-in cannot be done from the background shell, so run `git push` in the user's Terminal panel if it asks for a login.
- Never push without being asked. After a push, report the live URL, what changed, and that it was saved to GitHub.
- The page only works on claude.ai, because it relies on the Artifact `db` and `user` capabilities. Hosting it on a custom domain would need a real backend (for example Supabase or Firebase) and a real login service in place of those capabilities.

## How it works

- Everything lives in `index.html` (HTML, CSS and JS together). The only external resource is the Google Fonts stylesheet.
- Shared data uses the Artifact `db` capability. The `user` capability is used only for `isOwner()`, `canEdit()` and `can('data.write')`. There is no separate backend.
- **Accounts are keyed by email, not by Claude sign-in.** The account id (`state.me`) is the first 32 hex characters of SHA-256 of `'kitchen-line:' + lowercased email`. The same email is the same account on any Claude sign-in, and one Claude sign-in can hold many accounts (log out, then sign up with another email). The logged-in id is kept in localStorage as `kl-acct`.
- Capabilities declared when publishing (the declaration changed from the old per-Claude-user rules, so pass it explicitly on the next push):
  - `user: {}`
  - `db: {}` with no rules. Every collection uses the default: signed-in viewers read, Contributors write. (The platform refuses a rule where read needs a higher level than write, so emails cannot be kept admin-only while members write them. Emails are therefore not stored at all.)
- Branding: the business name is MPC. The logo (the supplied artwork, resized to 480px) is embedded once as the `--logo` CSS variable and shown in the header on a white rounded tile (`.logo`). Fonts are Montserrat (headings; the `MPC` wordmark is 800 italic) and Inter (body), plus IBM Plex Mono for small labels. Colours come from the logo: navy `--band`, royal blue `--accent`, yellow `--ball`; dark mode has its own navy palette. The text `'kitchen-line:'` in `emailId()` is the site's old name and must stay, because every account id is a hash that includes it.
- Layout: `.wrap` fills the screen width (capped at 1920px) with side padding of `clamp(16px, 3vw, 48px)`; the top bar, header, filters and session cards all sit inside it so their left and right edges line up.
- Navigation: a top bar in the header has a three-line menu (Dashboard = the session schedule, Profile, Users = member management, Role access, Add new session; Users, Role access and Add new session only when the role allows it) and, at the top right, the signed-in name, role and a Log out button. The new-session form is hidden until "Add new session" is picked.
- Session choices are not fixed: the lists for level, format, court number, venue and length live in `config/options` and are managed on the "Session options" page (below). Defaults (`DEFAULT_OPTIONS`): levels Open play, Beginner 2.0–2.5, Intermediate 3.0–3.5, Advanced 4.0+; formats Open play, Ladder, Clinic, Round robin; courts and venues empty; lengths 60, 90, 120, 150, 180 minutes. Sessions saved before the rename have level "All levels"; `lvl()` shows and filters those as "Open play". When adding or editing a session, an empty name, court or venue is saved as "-" (day and start time are still required, and an empty capacity falls back to 12).
- Destructive actions use the `--danger` red (`.link.danger`, lighter in dark mode): the second step of removing a session or a user shows "Tap again to remove" in bold red, and reverts after 4 seconds if not confirmed.
- Joining rules (`join`, `myActiveSession`, page-enforced like the other rules): once someone joins a session, including the waitlist, they cannot leave it (there is no Leave button) until it ends and is deleted, and they cannot join another session while they are in an upcoming one (the other cards' Join buttons are disabled with a note). Join also tidies `signups` entries for sessions that no longer exist. Consequence: someone on a waitlist stays locked to that session until it ends.
- Session options page (menu item "Session options", `renderOptions`) for roles with the `options` feature (on by default for admin and staff; super admin always; can be changed in Role access). Each list has Add, Remove and Reset to defaults. Levels, formats and lengths must keep at least one entry. Lengths are whole minutes from 15 to 600. When courts or venues exist, the add and edit forms show them as a list (with "-" for none); with none, people type them. Removing an option never changes existing sessions, and the filters still list any level or format an existing session uses.
- A session cannot be created, or moved, into the past: adding or editing shows an inline error ("That date and time have already passed. Pick a start time in the future.") when the start (`isPast`, local clock) is earlier than now. This applies to every role that can add or edit sessions. When editing, the check runs only if the date or start time was changed, so a session that is already running can still have its name, court or venue fixed. Like the other role checks it is enforced by the page, not the server.
- Session cards on the Dashboard are deliberately minimal: time, title, venue, chips, a "N spots left" line (or "Full · N waitlisted"), and a "View players" button, which is the first item in the card, left-aligned above the time and title. No capacity bars, no "x of y" count, no names on the card. "View players" opens a pop-up (`#modal`, `renderModal`) with the session's title and time, the numbered players, and the waitlist below; it closes with the × or Close button, Escape, or a click outside, keeps keyboard focus inside while open, and updates live. Roles without the `roster` feature see no button.
- The Dashboard shows a calendar icon button (`renderCalendar`) with a status line beside it (how many sessions are upcoming, or scheduled on the picked date). Clicking the icon opens a month date picker as a popover: a dot marks days with sessions, past days are disabled, the arrows move through the next 12 months, and picking a day closes it and filters the list to that date (pick it again, or use "Show all upcoming", to clear). It also closes on Escape or a click outside. An empty day shows "No sessions on this day" with, for roles that can host, "Add a session for this day" (prefills the form date). The Level, Format and "Only my sessions" filters still apply to the dots and counts.
- Profile page (every logged-in user, `renderProfile`): full name and email shown read-only, an optional level rating (2.0 to 5.0+ in half steps, saved as `members/{id}.rating`, cleared by choosing "Not set", shown to admins on the Users page), and "Reset password", which asks for the current password plus a new one twice. The email is not in the database: it is the one typed at log in or sign-up and is kept only in this browser (`kl-email` in localStorage, next to `kl-acct`). A saved login without `kl-email` (from before this existed) is dropped so the person logs in once more.
- Screens when logged out: Log in (email and password, then "Forgot your password?" and a "Sign up" link below it) and Sign up (name, email, password of 8+ characters, with a "Log in" link). A saved login is dropped if the account was removed or an admin reset its password.
- Passwords are a lock screen, not server security. Each is stored only as a salted PBKDF2-SHA-256 hash (200,000 rounds, email mixed into the input) in `logins/{id}` (`salt`, `hash`, `iter`, `setAt`). Never store a plaintext password. Because there is no server, `logins` must be readable by every signed-in viewer to check a login, and any Contributor can overwrite any record. Anyone with access to the data can attempt offline password guessing or tamper with other people's records. Share the site only with people you trust. Five wrong tries lock the form for 30 seconds.
- Forgot password: an admin (or super admin) clicks "Reset password" on the Users page, which sets `roles/{id}.pwReset`. The person enters their email on the Log in screen and is asked to choose a new password (no old one needed); the flag clears when `members/{id}.pwSetAt` is newer. Until then anyone who knows that email can claim the account. The site owner (Claude `isOwner()`) also sees "Reset password for this email" on the Log in screen, as recovery if the owner account is locked out. There is no email reset, because the site cannot send email, and emails are not verified.

## Data model (db collections)

- `sessions/{id}`: `title`, `date` (YYYY-MM-DD), `start` (HH:MM), `duration` (minutes), `court`, `venue`, `level`, `format`, `capacity`, `hostId` (an account id), `hostName`, `createdAt`. A session is deleted once its end time (start + duration, in the viewer's local time) passes: any signed-in viewer with write access deletes it on load or within 15 seconds (`purgeEnded` / `clockTick`). Nothing keeps a history of past sessions.
- `members/{id}`: `name`, `createdAt`, `pwSetAt` (the account profile, written at sign-up).
- `logins/{id}`: the password hash, described above.
- No email is stored anywhere. The Users page lists members by name. Do not add a plaintext email field without a way to keep it private.
- `roles/{id}`: `role`, `suspended?`, `owner?`, `pwReset?`, `by`, `at` (written by managers).
- `signups/{id}`: `joined` as `{ sessionId: joinTimestamp }`; the roster and waitlist order come from these timestamps.
- `config/roles`: `defs` as `{ roleKey: { label, perms } }` for the role access table.
- `config/options`: `levels`, `formats`, `courts`, `venues` (arrays of text) and `durations` (array of minutes). Any key that is missing falls back to `DEFAULT_OPTIONS`.
- The older collections `accounts`, `players`, `contacts` and `data/users/*` (keyed by Claude sign-in, from before email accounts) are no longer read. Their docs can be deleted.

## Roles and permissions

- Built-in roles: super admin (always everything), admin, staff, player. Super admin can add custom roles.
- Features: view, join, roster, host, edit, remove, people, options. Defaults are in `DEFAULTS` in the script. `people` opens the Users page (`renderUsers`): overview tiles, member search, role changes, Reset password, pause access, and Remove (super admin only; deletes that account's members, roles, signups and logins docs).
- Super admin: the first account the site owner (Claude `isOwner()`) signs up with becomes super admin (`roles/{id}`: `role: super_admin, owner: true`) when no super admin exists yet. Later accounts, including ones the owner makes while testing, start as players, so the owner can test other roles by creating accounts and logging in as them.
- Role checks are enforced by the page, not the server. Someone with Contributor access to the artifact could bypass them. Hard limits come from the Share menu levels.

## Sample data

Eight sample sessions (ids `seed01` to `seed08`) were added with placeholder venues. Edit or remove them in the page, or replace them with real ones.

## Ideas for next steps

- Real venue and court list shared by all sessions
- Recurring weekly sessions
- Export a session roster
- Email or message reminders (needs a connector)
