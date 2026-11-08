# Design: Aegean

The visual identity of the chat PWA. Tokens live in `public/style.css`; this file records the intent and the roles. Changing the look means updating both in the same change.

## Purpose and audience

A private coaching chat used on a phone, one-handed, often in short sessions (a morning check-in, a food photo, a quick question). The reader wants calm, readable prose from a coach and a place to answer quickly. The app presents advice and the person's own numbers, so the style stays quiet and serious: no playful chrome, no decoration that competes with the text.

## Mood and direction

Aegean blue and limestone: a pale warm stone ground, deep sea blue for action and the person's own messages, ink-dark text. The coach speaks in serif prose straight on the page, with no bubble, like a letter. The person's messages are small sans-serif blocks on the right. A single gold sun in the header is the only decoration.

## Palette roles

Both sets are defined once as CSS custom properties; rules use the role names only (a test fails on raw colours outside the token blocks).

| Role                       | Use                                                             | Light                 | Dark                  |
| -------------------------- | --------------------------------------------------------------- | --------------------- | --------------------- |
| `--bg`                     | page and composer ground                                        | `#ecebe4`             | `#0d1b24`             |
| `--surface`                | header, drawer head, input, tables                              | `#f6f5f0`             | `#14262f`             |
| `--text`                   | body text                                                       | `#14262f`             | `#e4e9e6`             |
| `--muted`                  | secondary text, interim status                                  | `#55656c`             | `#92a4ac`             |
| `--line`                   | hairline rules and borders                                      | `#d3d2c8`             | `#25404f`             |
| `--edge`                   | input field boundary (3:1 against the ground)                   | `#7b878d`             | `#557382`             |
| `--accent`                 | send, focus ring, secondary actions, active row bar             | `#1f4e6b`             | `#78aacb`             |
| `--on-accent`              | text and icons on accent                                        | `#f6f5f0`             | `#0d1b24`             |
| `--mine` / `--on-mine`     | the person's message block                                      | `#1f4e6b` / `#f3f6f7` | `#1d4560` / `#eaf1f4` |
| `--gold`                   | the sun mark in the header, nowhere else                        | `#9c7a2c`             | `#d6b360`             |
| `--danger` / `--on-danger` | offline banner, error note, Delete and Delete all; nothing else | `#a8341f` / `#fbf8f2` | `#f0846f` / `#0d1b24` |
| `--shadow`                 | the drawer's only shadow                                        | translucent ink       | translucent black     |
| `--scrim`                  | dimming layer behind the open drawer                            | translucent ink       | translucent black     |

Measured contrast (WCAG): text on ground 13.0 (light) and 14.3 (dark); muted on ground 5.1 and 6.8; on-mine on mine 8.2 and 8.9; on-accent on accent 8.2 and 7.0; accent on ground 7.4 and 7.0; on-danger on danger 6.2 and 6.9; sun mark on surface 3.7 (light) and 7.8 (dark); input edge on ground 3.1 and 3.5.

## Type

- **Literata** (serif, variable weight and optical size): coach prose, headings, the chat title, the interim status line (italic). Line height 1.65, measure about 34em.
- **Public Sans** (sans, variable weight): all UI (buttons, the person's messages, table cells, input).
- Both are self-hosted woff2 (latin subset) with system serif and sans fallbacks and `font-display: swap`. Sizes, radii, spacing and tap size are tokens (`--text-*`, `--radius-*`, `--space-*`, `--tap`).

## Shape and motion

- Radii 8, 12 and 16px; the person's block has a small corner (4px) bottom right; the input and Stop are pills.
- Hairline borders and a tinted surface carry structure; the drawer is the only element with a shadow.
- The drawer opens over a scrim (`--scrim`) and behaves as a modal dialog: tapping the scrim or pressing Escape closes it, focus moves into it on open and returns to the menu button on close, and the page behind is inert meanwhile. No animation is required for it.
- The active chat row has an inset accent bar on its left edge.
- Copy is an icon-only button (two overlapping sheets, `--muted`) in a row under each message, outside the bubble: a `.turn` wrapper holds the message and the row and owns alignment. The glyph is 20px, the target is `--tap`, the row is not selectable text.
- Motion is limited to short colour transitions on buttons, declared only under `prefers-reduced-motion: no-preference`.
- Targets are at least 40px, and 44px on coarse pointers (`--tap`); small glyphs keep the full target through padding. Focus is a 2px accent ring with offset on every control.
- Mobile first: the base is the phone layout; the column is centred and capped at 760px on wide screens. Safe-area insets are kept.

## Daily logs screen

A read-only screen that takes the place of the message list and composer, reached from the "Daily logs" button in the chats drawer (the same secondary-button style as "Copy conversation", above the destructive action). It adds no new identity: it reuses the existing roles and type.

- **Header:** the sun mark and the title "Daily logs"; a back arrow (the icon-button style of the menu button) replaces the menu and new-chat buttons while it is open. Back, Escape and the phone's back gesture each go one step back (day, then list, then chat). The chat, its draft and any running reply are untouched underneath.
- **Dates:** rows with a hairline underline; the date label (weekday, day, month, plus the year when it is not the current one) is Literata, the file count is small muted Public Sans. "Load older" is the existing secondary button.
- **A day:** the date as a Literata heading; when there is more than one file, pill buttons named by file (without `.md`) switch between them (pressed = filled accent, others outlined accent, as the secondary buttons elsewhere); a single file opens directly. The text is rendered with the chat renderer inside a `.msg.apollo` container, so headings, bullets, bold and tables look as in a reply. Prose keeps the reading measure; a table may use the whole column.
- **Tables on a phone:** tables keep their frame and scroll sideways inside it (checked at 390 and 320 wide: the page does not widen, and the first column is fully readable before scrolling). A sticky first column was considered and not used: it would take about half of a 390px frame and leave little room for the other columns, so the plain scroll is easier to read.
- **States:** one calm muted sentence each for no logs ("No daily logs yet."), an unavailable gateway or other failure ("Daily logs are not available right now."), offline ("Daily logs are not available offline."), a missing file and a file that is too large. There is no retry button; the existing offline bar still shows. Nothing from the server is displayed in these messages.
- Colours are tokens only; targets are `--tap`; the focus ring is the global one; focus moves to the back button on opening and to the menu button on leaving.

## Dark mode

A designed second set, not an inversion: a deep sea-blue ground, lighter accent, and gold re-tuned for contrast on the dark ground. It follows the OS preference (`prefers-color-scheme`); there is no switch. `theme-color` has light and dark variants; the manifest carries one light `theme_color` and the dark `background_color` for the splash.

## Home-screen icon

`npm run icons` draws a gold sun on the accent blue (`scripts/make-icons.mjs`). The colours there mirror `--accent` and the dark gold.
