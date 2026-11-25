# Carnet design rules

Dark, neutral interface, in the style of a classic video editor. No gradients, no decorative shadows. A tool first: plain labels, no exclamation marks, no motivational wording.

## Colours

| Role | Value | Use |
|---|---|---|
| Background | `#1b1c1f` | App background, timeline, fields |
| Panel | `#232428` | Top bar, right panel, windows |
| Panel 2 | `#2b2d31` | Buttons, list items |
| Border | `#36383d` | Separators, outlines |
| Text | `#e6e7ea` | Main text |
| Secondary text | `#9a9ca3` | Labels, info |
| Accent | `#00b8a9` | Main button, clips on the timeline, selection, "shows" status |
| Accent hover | `#00a396` | Hover of the main button |
| Recording | `#e5484d` | Record button, REC light |
| Video track | `#3d4f63` | Pieces of the original video on the timeline, notebook of the icon |
| Waiting | `#f3d27a` | Waiting statuses, the person's own words, "changing" status, "understood" steps forward |
| Moved past | `#9fb4c7` | "Moved past" steps forward |

Kinds of steps forward (Progress page, Remember, cards): a small outlined label and a left border in the colour of the kind: done or settled in the accent, understood in the waiting yellow, moved past in blue grey. "Then" labels are secondary grey, "Now" labels the accent.

Timelines of the steps forward: a time axis with month ticks (weeks under 50 days) and faint vertical lines, today marked in the accent. The line of a step is dotted grey before the step and 4 px in the colour of its kind (45 % opacity) after it. Marks: started, a grey ring; came up, a small grey dot; the step, a 15 px dot in the colour of its kind; held, an accent dot; did not hold, a light red dot (`#ff8a8d`); your answers, rings (accent or light red); subject concluded, a small accent square; next check, a dashed grey ring. The same marks sit on the vertical line of the timeline of one step, with the date on the left and the time between two events in grey italics.

All subjects timeline: the page is wider (1240 px). A subject's line is 3 px, blue grey (`#5d7086`) while open, the accent at 50 % once concluded, dotted up to today while open. A dot per video in grey blue (`#8b9bb0`), 7 to 13 px depending on how many ideas of the subject the video has; yellow when where you stand changed; a white ring for the first time; an accent square when concluded (a hollow one when reopened).

## Type

- Font: Segoe UI (Windows system font); on a Mac, the system font (San Francisco)
- Base size: 13 px
- Section titles: 12 px, capitals, secondary grey

## Shapes

- Radius: 6 px (buttons, fields, panels), 8 px (windows)
- Height of buttons and fields: 30 px
- Base spacing: 12 px

## Buttons

- Main: accent background, white text (Export, OK)
- Normal: Panel 2 background, border (Open, Cancel)
- Recording: red border with a red dot, red background while recording
- Danger: light red text (Delete)

## Scrollbars

Thin (10 px track, 6 px thumb), dark grey thumb `#3a3d43` with rounded ends on a transparent track, lighter on hover, accent while dragged; no arrows. The same everywhere (lists, panels, settings, text fields). `color-scheme: dark` keeps the lists of the selects and the other native controls dark.

## Progress reel

1280x720 at 30 frames per second. Cards on the background colour, text centred in Segoe UI Bold (Arial Bold on a Mac): the kind in the accent (32 px), the situation in secondary grey, the step in the main text colour (50 px, 5 lines at most), the date and subject in secondary grey. Moments of videos are fitted in the frame with black bars, "Then · date" or "Now · date" at the top left on a black box at 55 %. Short fades between pieces.

## Icon

`build/icon.svg`: a thick "C" in the accent colour with the red recording dot in its centre, flat colours, on a transparent background. Exported to `build/icon.png` (512 px) and `build/icon.ico` (16 to 256 px; from 32 px down, a thicker C and a bigger dot).

Mac: `build/icon-mac.svg`, the same C and dot on a rounded square in the background colours (`#2e3035` to `#1b1c1f`, from top to bottom), with the margins and the shadow of macOS icons; exported to `build/icon.icns` (16 to 1024 px). In the menu bar, `build/trayTemplate.png` (18 px) and `@2x` (36 px): the C and the dot alone, black on transparent, a little thicker; macOS colours them like the other icons there.

On a Mac, the window, its title bar and the menus stay dark whatever the system setting, like the rest of Carnet.

The colours are defined once in `src/renderer/styles.css` (`:root` block).
