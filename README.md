# Carnet

A video journal that works as a second brain. You talk to the camera; Carnet transcribes, picks out every idea and files it under **subjects** that carry on from one video to the next. For each subject it keeps where you're at, what is still to decide, and leads for next time. It also keeps a short description of **you**, built from what you say about yourself, and your own list of strengths and weaknesses, with suggestions drawn from your videos and a way to see where you are on each one.

What you sort out does not disappear: every **step forward** (something done or settled, a realization about how to act or how to see a situation, something you left behind) is kept on the **Progress** page with the moment it started and the moment it happened, and comes back at growing intervals so you can check that it held.

Carnet is a tool first. It records, files and reminds you of what you said. It does not coach, grade or motivate: the texts it writes are plain notes, in the second person, with your own words when they fit. No advice you did not ask for, no self-help vocabulary, no diagnosis. The tone is set in `Journal instructions.md`, which you can edit.

Before recording, you can pick a subject: your notes on it stay next to the camera while you talk.

Carnet runs on Windows and on macOS (Apple Silicon and Intel): see **Install on Windows** and **Install on a Mac** below.

## Getting started

On first launch, the "To get started" card offers two steps (also in **Settings**):
1. **Journal folder**: the journal videos (subfolder `Journal videos`), `Journal.md`, the transcripts and the instructions are kept there. Videos made with **Export…** go to a separate folder (by default `Videos\Carnet - Exports`, `Movies/Carnet - Exports` on a Mac, changeable in **Settings**).
2. **Gemini key**: a free key from aistudio.google.com/apikey. It is checked, then saved encrypted with your Windows account (on a Mac, in your keychain).

**Transcription** (Settings):
- **Gemini** (default): the sound of the video (mono, compressed, about 2 MB for 10 minutes) is sent with the request for the card. One call does both the transcript and the card. Fast, but the timings are less precise than with whisper.
- **whisper, on this computer**: free and offline, but slow on a modest laptop. **Fast** model (60 MB) or **Accurate** (190 MB). The spoken language is detected. On a Mac, whisper comes with Carnet (and uses the graphics chip on Apple Silicon); only the model is downloaded.

Privacy: the picture never leaves the computer. With Gemini, the sound is sent to Google; with whisper, only the text. With a free key, Google may use what it receives to improve its products.

The app used to be called Raccord: on first launch, Carnet takes over its settings (folder, key, whisper). Old `raccord://` links in Markdown files still work.

## Languages

English by default, plus French, Spanish and German: **Settings > Language**. At the top of **Settings**, the list of sections (Journal folder, Transcription, Gemini, Recording, Reminder, Language, Export all data) goes straight to each one. The choice applies to the whole window, to the phone page, to `Journal.md` (rewritten right away) and to what Gemini writes from then on (cards, subjects, summaries, what Carnet knows about you). Texts written before stay in the language they were written in until they are redone. Transcripts always stay word for word, in the language you speak.

The translations are in `src/i18n/` (`fr.js`, `es.js`, `de.js`): each one maps the English text of the app to its translation.

## The journal

- **Before you talk** (home screen):
  - **Remember** (when there is something): the look-back when a month has passed, the realizations and things left behind whose time has come to be checked, a subject that stopped coming up, and where you stood a month ago on a subject (see **Progress** below);
  - the **summary** of the chosen period (last 7 days, last 7 videos or this month): what occupied your mind, what moved forward, what was left hanging, what you said and then contradicted, and what you could pick up in the next video;
  - **your open subjects**: for each one, where you're at and what is still to decide, with a **Talk about it** button;
  - subjects **left aside** for more than two weeks, and your videos of the last 7 days.
- **You**: what Carnet knows about you, and your strengths and weaknesses (see below).
- **Progress**: everything you did, understood and left behind, each step on its own timeline, with **Look back**, **How far you’ve come** and the **Progress reel** (see below).
- **Weeks**: one summary per calendar week, Monday to Sunday, most recent first. Each summary receives the one of the week before and starts with **compared with the week before** (what got unstuck, what is still stuck, subjects that appeared or disappeared, a change of mood). Then **what was planned** (the "for the following week" points of the week before: done, partly, or not picked up), in short, what moved forward, left hanging, to clarify, and **for the following week**. A week without videos is skipped: the comparison is made with the last week that has some.
  - The summary of a week is made automatically once the week is over (on Monday), from the oldest to the newest, keeping 3 Gemini calls in reserve. For the current week, **Make the provisional summary**; it is redone automatically at the end of the week.
  - If videos are added or analysed again after the summary, the week says so, with **Redo**.
- **A subject**: where you're at, to decide, leads for next time, its line **over time** (the same as in All subjects, bigger), **how it changed, video by video** (for each video: what it changed compared with the previous one, a new argument, a change of mind, a question settled or "nothing new", then where you were after it), the **steps forward on this subject** (on a time axis, a click opens the timeline of one), then **the thread**: video by video, everything you said about it, with a link to the moment in the video. Buttons **Pin** (stays at the top), **Mark as concluded** (you write your conclusion), **Reopen**, **Merge with…** (when Gemini created two subjects for the same thing), **Rename**, **Delete**.
- A subject is concluded when you reach a decision in a video (Gemini marks it) or by hand. If you come back to it later, it reopens.
- **All subjects**: a timeline, one line per subject on the same time axis. The line runs from the first video where the subject came up to the last one (blue grey while open, green once concluded), then dotted up to today while it is open and not discussed. A dot for each video where it came up, bigger when more was said about it, yellow when the video changed where you stand, a square when it was concluded. Hover a dot for the date, the video and what changed; a click on a dot opens that video, a click elsewhere on the line opens the subject.
  - **Sort by**: most videos, last discussed, oldest first, newest first, longest (time between the first and the last video), most changes, A to Z. The choice is kept.
  - Filters: all, open, concluded, pinned, a category; period: everything, 12, 6 or 3 months.
  - **Reorganise the subjects** makes Gemini read all the cards again to redo the list (duplicates, subjects that are too broad).
- **Videos**: the videos by month. **Search** (at the top): in subjects, titles, summaries, ideas, people and transcripts, ignoring accents.
- **Card of a video**: the video, its summary, **progress in this video** (the steps forward said in it, and the earlier realizations it applied or went against), **compared with before** (for each subject discussed, what the video changes), the ideas grouped by subject with the moment they are said (click to go there), the full transcript. Buttons **Open in the editor**, **Analyse again**, **Transcribe again**, **Remove from the journal** (the video stays in the folder).
- **Import**: adds videos you already made (copied into the journal folder).

### You

Two short lists, nothing else.

**About you**: plain sentences ("You work night shifts as a nurse."). Carnet adds a line when you talk about yourself in a video, and updates or removes it when you say something changed. Only what you state, never a guess. × removes a line, the field below adds one. A line you remove is not added back from older videos. Hover a line to see where it comes from.

**Strengths and weaknesses**: your own list, same controls. **Update** (1 Gemini call) looks at your videos and does two things:
- a dot before each item shows where you are in your recent videos (the last 30 days, or the last 6 videos): it shows, it is changing, or it was not seen lately. Hover the item for what shows it.
- about 10 new suggestions per column, in italics, together in a box under your items, drawn from what you actually said, in your terms, and spread over different sides of your life (work, people, decisions, habits, time and money, how you talk about yourself). ✓ adds one to your list, × sets it aside for good, **Add all** puts the whole column in your list. Hover for why. Each Update starts from three angles drawn at random and from other older videos, and leaves out the suggestions shown the time before, so they change from one time to the next. Items already in your list and suggestions set aside are never suggested.

### Progress

A **step forward** is one of three things, always from what you say, never guessed:
- **Done** (or **Settled**): something you had planned, put off or had to decide, now done or decided. A video that says a to-do of the last 60 days is done, or that settles a "to decide" of a subject, closes it. A concluded subject is a settled step too (put aside again if the subject reopens).
- **Understood**: a realization, either **how to act** in a kind of situation or **how to see** a kind of situation, with the situation it applies to ("when plans change at the last minute").
- **Moved past**: something that no longer weighs on you, in your words.

Each one keeps two moments: **then** (where it started: the video where the plan was said, or the first time the subject came up) and **now** (the moment in the video where you say it). **Then and now** plays the two side by side, or one after the other. Most videos have none, some one or two.

Where they come from:
- **each analysed video** (in the same Gemini call): the steps it contains, and the **links** to earlier ones: when a video applies an earlier realization, goes against it, or meets the same kind of situation, it is noted under it ("Since then: 31/10 · applied");
- **concluded subjects**;
- **Look through my earlier videos** (1 call, once): for a journal started before progress was followed, Gemini reads the cards of the last 250 videos and notes their steps forward with their moments;
- **Add by hand**.

**Remember** (in Before you talk): a realization comes back 3 days after it was noted, then 7, 14, 30, 90 and 180 days, as long as it holds: **I applied it** (or **I saw it this way**) moves it to the next interval, **I forgot it** brings it back in 3 days, **No longer true** puts it aside. Something left behind comes back after 30, 90 and 180 days: **Still behind me**, or **It came back** (puts it aside; a subject concluded as behind you opens again). A later video that applies it counts like **I applied it**; one that goes against it brings it back the next day. Three at a time; the others wait on the Progress page (**To check**).

A subject discussed in at least 3 videos that has not come up for 4 weeks, while you made 3 videos or more, gets a question: **Is it behind you?** Yes: it becomes a step forward and the subject is concluded. **Not really**: asked again in two months.

**The Progress page**: the counts (done or settled, understood, moved past, to check), then one line per step forward on a shared time axis, newest first. Each line is dotted from where it started to the step, then in the colour of its kind while it is followed, with a mark for each event: it started, its subject came up, the step, each later video where it held or not, your answers in Remember. Hover a mark to see what it is. Filters: All, To check, Done, Understood, Moved past, Put aside; period: everything, 12, 6 or 3 months.

**The timeline of a step** (a click on its line, or **Its timeline** in Remember and in a look-back): its line over time up to its next check, then every event in order, with the time between them: where it started, each video where its subject came up before it (with what that video changed), the step, each later video that applied it or went against it (with what happened), your answers in Remember, the subject concluded, put aside, the next check. Each event opens its video at that moment. Buttons **Then and now**, **Edit**, **Put aside** (hidden from the list and from Remember, can be brought back), **Delete**.

**Look back** (once a month, or when you want): what happened since the last look-back (the steps forward, the earlier realizations met again and how, the subjects then and now, the videos), and questions for a video. The questions are written without Gemini from that material; **Prepare the questions with Gemini** (1 call) writes questions that make you compare then and now. **Record your look-back** opens the recording with the questions in the notes next to the camera. That video is analysed with the look-back in mind: what you say is linked to the earlier moments. When a month has passed and you made at least 3 videos, Remember offers it (**Not now** waits a week).

**How far you’ve come**: over 3, 6 or 12 months, the counts (videos, steps forward by kind, subjects concluded), and **Write it** (1 call): where you stood at the start and where you stand now, what changed (then, now, and the videos that show it), what you learned, what is still the same and why, what keeps coming back. Plain report, no judgement. The last 12 are kept.

**Progress reel**: one MP4 in the exports folder, named `DD-MM-YY HHhMM Progress reel.mp4`: for each step forward of the period (10 at most, those with both moments first), a card with what it is, then 7 seconds of the moment it started and 10 seconds of the moment it happened, with "Then" and "Now" and the date on the picture. Made on the computer, no Gemini call. **Cancel** stops it.

**Daily reminder** (Settings > Reminder, off by default): once a day at the chosen time, a notification with what there is to check, a look-back, or a subject that stopped coming up; when there is nothing to check, where you stood a month ago on a subject. A click opens Carnet on Before you talk. If the computer is asleep at that time, it shows when it wakes up, up to 6 hours later. While the reminder is on, Carnet starts with Windows without opening its window and stays in the notification area when you close the window (right-click its icon to quit). On a Mac, it opens at login without its window, with an icon in the menu bar (click it to open or quit Carnet); macOS asks once whether Carnet may send notifications. **Try it** shows the notification of today right away.

### Clarifications and permanent facts

**Clarification of a video**: when something was misunderstood in a video (two names for the same person, a misheard word, a misread situation), write it in the **Clarification** card of that video, then **Correct this video** (1 call). Gemini receives only that video: its card, the subjects it fed, what Carnet knows about you, the steps forward that came from it and its transcript. It rewrites what the clarification changes (not a simple word replacement) and can merge a subject of this video with another one that turns out to be the same. The rest of the journal is not sent and does not change. The clarification stays with the video and is used again only if that video is analysed again. The previous "where you're at" stays in the history of the subject ("corrected with your clarifications"). Transcripts do not change: they stay word for word what was said.

**Permanent facts** (left menu): what Carnet should always know, for example "Sam is my neighbour" or "when I say the club, I mean my running club". They go with the analysis of each new video and with the summaries, a few words each, and never change what is already written. After a correction, Carnet offers to keep the clarification as a permanent fact (Gemini suggests a short sentence; you can edit it). Clarifications "for the whole journal" of earlier versions became permanent facts.

**To check**: when a video says something that does not fit the journal, the analysis sorts it:
- a change of feelings, opinion or plans is an evolution of the subject, as usual;
- a fact the video says has changed ("Sam moved out") replaces the old one;
- two versions of the same fact with nothing said about a change (Sam is your neighbour, then a colleague) is a confusion: the journal keeps its version, and the difference goes to **To check**, on the Permanent facts page, on the video page and as a notice in Before you talk.

For each one: **Keep** the journal version (the new video is corrected, 1 call), **Take** the new one (the video the journal version came from is corrected, 1 call), or **Both are true** (nothing changes). The answer can also become a permanent fact (ticked by default).

### Recording with your notes

**New entry** (N key) or **Talk about it** on a subject: the recording window opens full screen, with a notes panel to the right of the camera.
- With a subject chosen: where you're at, what is still to decide, the leads, and what you already said (the latest ideas, with their date).
- With a subject chosen, also what you understood about it.
- With **Free subject**: what is to check in Remember, the leads of the last summary and your open subjects (click one to show it).
- With a look-back (**Record your look-back**, or chosen in the list): its questions, the steps forward of the time it covers and the subjects then and now.
- The cross hides the panel, the **Notes** button brings it back.

The chosen subject gives its title to the video and is sent to Gemini with it, so that what you say is linked to the right thread.

### What Gemini does

- **Word-for-word transcript**: with Gemini, everything you say is written as is, hesitations, repetitions, slang and unfinished sentences included; only punctuation is added. With whisper, the text is whisper's, which tends to drop hesitations.
- **Your own words in the summaries**: when you used a word that sums up exactly how you feel ("drained", "going round in circles"), Gemini reuses it as is in the summary, the "where you're at" or the period summary, between the quotation marks of your language. Only if such a word exists: it does not invent one. In Carnet these words are in yellow italics; when they are found in a transcript, a click opens the video at the moment you say them.
- For each video, 1 call: transcript, card, the subjects discussed (where you're at, to decide, leads, concluded or not), what the video says about you, its steps forward with the links to earlier ones, and what does not fit the journal (To check). Gemini receives your subjects with their state (and the previous "where you're at", to notice when you change your mind), to pick up existing threads instead of creating new ones, plus your permanent facts. Videos are analysed from the oldest to the newest.
- **Search memory**: when your journal no longer fits in one request (about 24,000 tokens of subjects, steps forward and what Carnet knows about you), each video gets your most recent subjects in full, the older ones close to what it says (found by meaning with vectors, and by the names in their titles) in full too, the titles of all the others, and up to 5 older videos close to it. The vectors are made by Gemini's embedding model (`gemini-embedding-001`, a separate quota: the day's calls do not change), in the background once the journal reaches 60 % of the limit, then for each new or changed item; they are kept in `search-memory.json`. With transcription by Gemini, a video then takes 2 calls: the transcript first, so that the search can read it, then the card. Until the vectors are ready, or if the search fails, Carnet sends the 80 most recent open subjects and 40 concluded ones, as before. Each video says how it was analysed ("Analysed with all your journal", or with search memory, with the list of what was found), and **Settings** shows the state of search memory, with **Build now** or **Build again**.
- Summary: 1 call, with **Make the summary**, or automatically at most once a day when there are new videos (can be turned off).
- A journal made with an earlier version of Carnet is organised into subjects automatically on first launch (1 call).

### Gemini: free key, quota and overloads

One video = 1 call (transcription included; 2 with search memory and transcription by Gemini), correcting a video with a clarification = 1 call, a summary (of a period or a week) = 1 call, reorganising the subjects = 1 call, **Update** on the You page = 1 call, the look-back questions, **How far you’ve come** and **Look through my earlier videos** = 1 call each. The number of calls per day is set in **Settings** (20 by default) and resets at midnight California time (9:00 in Paris). When it is reached, videos wait for the reset. The automatic summary always keeps 3 calls in reserve.

**Free or paid key**: when you save the key, Carnet sends one tiny request to a model that the free tier does not offer: a free key gets "limit: 0" back (nothing is charged), a paid key a one-word answer. Gemini errors that mention the free tier also mark the key as free. **Settings** shows the result, with a **Check** button.

**When Gemini is overloaded** (503, "model overloaded", "high demand") or refuses for too many requests per minute, Carnet tries again on its own: after 4, 8, 16, 32 seconds, then once a minute, or after the delay Gemini gives. With a free key (the first to be refused when Gemini is busy) it keeps trying for up to 20 minutes, with a paid key 4 minutes. If Gemini still refuses, analyses pause and pick up later without you: after 10 minutes (5 with a paid key), at the time Gemini gives, after the daily reset when the day's quota is used up, or after an hour when the spending cap or prepaid credits are reached. The video is not marked as failed: it is analysed as soon as Gemini answers again. The top bar shows "Gemini is busy, trying again in 12 s" or "resumes at 14:05", and each waiting video says so. Overloads are not counted in the day's calls.

### Files in the folder

- `Journal.md`: what Carnet knows about you, your progress by month (with links to the then and now moments), weekly summaries, latest summary, open subjects (where you're at, to decide, leads, the thread), concluded subjects, then all the videos by month. Each idea has a link that opens Carnet on the video, at the moment it is said (works in Obsidian, VS Code and most Markdown readers once Carnet is installed). Written again at every change, in the language of the app: do not edit it by hand.
- `Journal videos/`: the videos, named `DD-MM-YY HHhMM Title.mp4` (for example `27-10-26 08h41 Weekly review.mp4`). Journals started with an earlier version keep their `Vidéos du journal/` folder. When added, a video takes the title of the edit; after the analysis, it is renamed with the title Gemini found. If the video is playing, the renaming happens as soon as it is free.
- `Transcripts/`: the full text of each video.
- `Journal instructions.md`: what Gemini must do (tone, card, subjects, about you, strengths and weaknesses, progress, look-back, how far you’ve come, reorganisation, summaries). When Carnet adds new sections and you edited the file, they are added at the end of your version. You can edit it; **Analyse again** applies new instructions to a video. If you never edited it, it is updated automatically with new versions of Carnet.
- `search-memory.json`: the vectors of search memory (an index only: the text stays in `journal.json`). If it is deleted or damaged, Carnet makes it again.
- `journal.json`: the app's data. At every save, the previous version is kept in `journal.json.bak`, and one copy a day goes to `Backups/` (the last 14 days).
  - If `journal.json` is damaged (power cut during a write, incomplete sync), Carnet puts it aside (`journal.json.damaged-…`) and starts again from the last healthy copy, with a message.
  - If no copy can be read, Carnet writes nothing more to the journal and says so, instead of starting from an empty journal.

Folders named in French by earlier versions (`Transcriptions/`, `Sauvegardes/`, `Instructions du journal.md`) are renamed once.

## Editor

Reached from **New entry**, **Open in the editor**, or by opening a video (right click > Open with > Carnet). **← Journal** goes back to the journal.

1. Open a video (Open button, drag and drop, or right click on a file > Open with > Carnet), or click **New video** (N key) to record it straight from the camera. The recorded video is trimmed like a clip, then becomes the working video.
2. Pause at the right moment, click **Insert a clip here** (or R key).
3. The recording window opens full screen, with the date and time at the bottom right. Pick the camera and microphone (and, with the phone, who records; see below), wait for the button to go from "Preparing…" to **Start**, click, wait for the countdown (3, 2, 1), talk, **Stop**. The 3 seconds of countdown are removed from the clip automatically. **Quality**, under the picture: **Full** (up to 1080p, 60 frames per second) or **Light** (720p, 30), for a computer that cannot keep up.
4. Trim the clip with the two handles, check with the play button, adjust the position if needed.
5. **OK** to insert, **Cancel** to throw away, **Start over** to redo the take.
6. Select a clip in the list or on the timeline: you can move it (position field or "Move to the playhead"), trim it again or delete it.
7. **Scissors** (or C key): put the playhead at the start of the part and click **Start here** (I key), put it at the end and click **End here** (O key), then **Delete the part** (or Del) to confirm. The points are taken exactly at the playhead; the , and . keys move one frame back or forward. The selection can span the video and the clips. The timeline shows the sound wave of each piece: a flat line means a passage with no sound. On hover, the tooltip gives the time and the level in dB. Silences are removed automatically when a video is opened, after a new recording and when a clip is inserted: in each silence, 1 s is kept at the start and 1 s at the end, only the middle goes (so only silences longer than 2 s get shorter). A message offers **Undo**; later, **Put the silences back** (right panel) or **Restore** on each line. The remaining silences show as dark grey blocks; a click on one selects it to delete it by hand. Deleted parts are listed on the right with a **Restore** button.
8. **Chapter** (M key): adds a chapter at the playhead; type its title right in the right panel. Chapters show above the timeline, a click on one goes there. They follow the video when a clip is inserted or a part deleted. When a video is opened, chapters are loaded automatically from the `name-chapters.txt` file next to it (or `name-chapitres.txt`, `name.txt`), otherwise from the chapters inside the MP4.
9. The **title** is set at the top, in the middle. **Export** makes a final MP4 (same resolution as the original video), named `DD-MM-YY HHhMM Title.mp4` with the date and time of the export, for example `21-10-26 12h35 Weekend in the mountains.mp4`. The recording date and time are burned in at the bottom right of clips and of videos recorded in Carnet. Chapters are written into the MP4, and a `name-chapters.txt` file is created next to it, ready to paste into a YouTube description. During the export (or the adding to the journal), **Cancel** stops it at once: the partial file is deleted and the edit stays intact.

The clip is inserted: the original video stops at the chosen point, the clip plays, then the video picks up where it stopped.

Shortcuts: Space play/pause, left/right arrows (1 s, 5 s with Shift), N new video, R record a clip, C scissors, I start of cut, O end of cut, , and . frame by frame, M chapter, Del delete the selection or the selected clip, Esc cancel the recording.

## Export all data

**Export all data** (bottom left of the journal, or in **Settings**) makes a single file, as you choose:
- **A single text file (.md)**: the whole journal, readable with any editor: weeks, summaries, subjects and how they changed, video cards, full transcripts, what Carnet knows about you, settings and instructions.
- **A single data file (.json)**: all of Carnet's raw data (journal, subjects, summaries, weeks, profile, settings, register of recordings), to reuse elsewhere or keep as a backup.
- **An archive (.zip)**: the two files above and the instructions, plus, if you want, the journal videos and the kept recordings. Progress is shown, **Cancel** works; archives over 4 GB are handled (ZIP64).

The Gemini key is never exported.

## The phone as a camera

For a computer without a webcam (or for a better picture): the phone becomes the camera, over Wi-Fi, with no app to install.

**Recorded by**, under the picture once the phone is the camera:
- **The phone (best quality)**, the default: the phone records the picture and the sound itself, with its own encoder, at the camera's full size and frame rate, and with its own microphone. The window on the computer only shows a preview (smaller while recording, to leave the Wi-Fi and the phone's encoder to the recording). The speed of the computer and the quality of the Wi-Fi no longer matter for the result: a choppy preview gives a smooth video. **Start** and **Stop** stay on the computer, with the same countdown; the phone shows "Rec" and the time.
- **This computer**: the computer records the picture it receives from the phone, with its own microphone (the way it worked before). Useful with a good microphone plugged into the computer.

How the phone sends its recording, so that nothing gets lost:
- The file leaves in pieces of about a second, while recording. Each piece is written to the computer's disk, then acknowledged; the phone keeps every piece until then, in memory and in its browser's storage.
- Wi-Fi cut, phone page reloaded, Carnet closed or restarted: the phone sends again what was not acknowledged as soon as it reaches the computer, and Carnet picks up exactly where the file stopped (bytes written but not acknowledged before a crash are cut, then written again).
- After **Stop**, the window waits for the end of the file ("Receiving the recording from the phone…", with the progress), then opens the trimming as usual. If nothing arrives for a few seconds, it says so and offers **Use what has arrived**: what is on the disk is prepared at once, and if the rest arrives later, the complete version shows up in **Recordings**, with a message.
- On the phone, "Sending…" then "Recording sent to the computer." Keep the page open until then. If the computer cannot be reached, the phone says so and goes on by itself when it can.
- The phone's microphone is opened only while Carnet asks the phone to record (record window open, "Recorded by: the phone"), and closed 20 seconds after. If the phone refuses the microphone, Carnet says so: the recording would have no sound.
- **Stop recording** on the phone ends the recording there too. If the phone's page is hidden or its screen locks, the recording ends at that moment, and what it holds is kept.
- Format: what the phone's browser records (MP4 with H.264 on iPhone, WebM or MP4 with H.264 on Android, otherwise VP8 or VP9), stored as MP4 when the video is H.264. A picture turned with ↺ ↻ is marked as turned in the MP4 (no re-encoding); another format is re-encoded once, turned.

- If the computer has no webcam, the recording window shows a QR code instead of the preview. Otherwise, pick **Phone (Wi-Fi, QR code)** in the **Camera** list, or **Use the phone** when the webcam won't start.
- The phone and the computer must be on the same Wi-Fi. Scan the QR code with the phone's camera. The first time, the browser warns that the connection is "not private": **Show Details** (iPhone) or **Advanced** (Android), then **visit this website** or **Proceed**. Then **Start camera**; **Switch camera** goes from the front camera to the back one.
- Keep the page open and the phone's screen on while recording (Carnet asks the phone not to sleep when the browser allows it). For a long recording, plug the phone in.
- **Phone held sideways**: the ↺ and ↻ buttons next to the **Camera** list rotate the picture a quarter turn. Useful when the phone's rotation lock is on (the picture then arrives lying down). The rotation is kept for the next recordings; it is set before starting, not during.
- Recorded by this computer, if the phone disconnects during a recording, the recording goes on with the computer's sound: a gap of less than 3 seconds just freezes the last picture, a longer one shows a waiting screen, and the picture comes back on its own when the phone reconnects. Recorded by the phone, the phone goes on recording by itself; only the preview is missing.
- The QR code stays the same from one launch to the next: a tab left open on the phone reconnects on its own. **New QR code** replaces it (the old one stops working).
- Under the QR code, Carnet says where the phone is at (page open, old QR code, page from an older version of Carnet to close and scan again, picture on its way). If the phone has not reached the computer after 25 seconds, help shows up, with **Allow Carnet in the firewall** (Windows asks for administrator confirmation; the rule applies to all network types, "Public" included). On a Mac, the help says where to allow Carnet: **Privacy & Security > Local Network** in System Settings, and incoming connections in **Network > Firewall** if the firewall is on.

How it works (same idea as [OmniCam](https://github.com/Orest-Z/OmniCam), MIT licence): Carnet serves a web page over HTTPS on the local network (port 28451, self-signed certificate kept in `%APPDATA%\Carnet\tls`, or `~/Library/Application Support/Carnet/tls` on a Mac, hence the warning the first time). The QR code holds the address of the page and a secret code, kept from one launch to the next; without it, the phone cannot connect. The phone opens its camera (and its microphone only when it records) and sends the picture straight to the computer: nothing goes through the Internet. The installer adds a Windows firewall rule for Carnet; without administrator rights, Windows asks the first time. On a Mac, macOS asks the first time whether Carnet may find devices on the local network: the direct video needs it.

Two paths for the picture, chosen on their own:

- **Fallback mode**, always first: the phone sends the picture over a WebSocket connection on the same path as the page (HTTPS). If the page opened, this path works, whatever the firewall, VPN or network: the picture arrives in a fraction of a second. The phone sends real video there, compressed by its own processor (H.264, otherwise VP8, with WebCodecs): 1280x720, at the camera's frame rate (60 frames per second when the camera can). If the phone cannot compress 60 frames per second at that size, the picture gets smaller (960, then 640 pixels wide) before the frame rate drops to a steady 30, about 2 Mbit/s, five times less than JPEG pictures. Carnet acknowledges each frame: if the Wi-Fi can't keep up, the phone lowers the bitrate instead of falling behind. If Carnet cannot read a format, the phone moves to the next one; a browser without WebCodecs sends JPEG pictures, and if the WebSocket does not open, JPEG pictures over HTTPS. The phone shows "Live (fallback mode)", Carnet's preview "Fallback mode".
- **Direct video** (WebRTC, H.264 encoded by the phone, sharper, up to 1920x1080 at 60 frames per second): tried at the same time. Carnet draws each frame as soon as it is decoded, at the phone's pace. If the network gets tight, the frame rate is kept and the resolution drops a little; the size of the recording stays the camera's. The phone only switches to it when Carnet confirms it really receives its frames, and goes back to the fallback as soon as they stop (in under 3 seconds; the picture freezes during the switch, the recording goes on). If it does not get through (UDP blocked by the firewall, VPN, company or guest Wi-Fi, tethering), the phone tries again less and less often: 10 s, 20 s, 40 s, 80 s, then every 2 minutes.
- A tab left in the background on the phone sends nothing (no frozen picture). A page opened with an earlier version of Carnet reloads on its own and starts the camera again; a very old one is refused, and Carnet asks to close the tab and scan again.

## Recordings: nothing gets lost

- Format: H.264, encoded by the graphics card, when the computer can (tried for one second, invisibly, when the preview starts), stored as MP4; otherwise VP8 in WebM. Bitrate by size and frame rate (6 Mbit/s, 10 in 1080p at 60 frames per second). The export takes the highest frame rate among the video and its clips: a clip filmed at 60 stays smooth inside a video filmed at 30.
- 60 frames per second: browsers tend to pick 1080p at 30 over 720p at 60, so once the camera is open, Carnet asks the same camera (phone or webcam) for at least 50 frames per second, without going below 720p. A camera that cannot do that stays at 30 (most laptop webcams).
- **Jerky playback but a smooth preview** means the computer could not compress the video fast enough while recording: the preview only shows the camera, the recording also has to compress every frame. After each recording, Carnet compares the frames kept in the file with those the camera sent. If far fewer were kept, it says so and switches to light recording (720p at 30 frames per second; **Quality** under the picture, or **Settings > Recording**). With the phone as camera, **Recorded by: the phone** avoids the problem altogether: the phone compresses the video itself. Background work (whisper transcription, sound extraction) runs at a lower priority, drops to the lowest while you record, and no new job starts until the recording ends.
- The phone shows its camera format at the top (for example 1920x1080 · 60 fps); Carnet's preview shows the path, size and frame rate actually received (for example "Direct · 1920x1080 · 60 fps").
- During a recording (clip or new video), the video is written to the disk every second, in `%APPDATA%\Carnet\clips` (`~/Library/Application Support/Carnet/clips` on a Mac). A long recording (an hour or more) does not fill the memory, and if Carnet is closed or crashes, what was filmed stays on the disk.
- If Windows suddenly refuses to write during a recording (disk full, antivirus, permissions), the rest is written to a rescue folder (`Carnet - rescue`, in the temporary folder, Videos, Documents or the home folder), a message says so, and the pieces are joined when you stop. If no folder accepts writing, the recording goes on in memory and can be copied in full wherever you want.
- If preparing fails after **Stop**, the recording is not thrown away: the window shows the cause, with **Try again** and **Save a copy…** (exact copy of the file, wherever you want, instantly).
- While trimming, **Save a copy…** does the same, so you are never stuck adding a clip.
- **Cancel**, **Start over** or deleting a clip does not delete right away: the recording is kept for 7 days. A recording longer than a minute asks for confirmation before being cancelled (Esc included).
- **Recordings** (bottom left of the journal) lists the recordings not used yet in an export or the journal: interrupted, could not be prepared, left in an edit that was not exported, or deleted less than 7 days ago. For each: **Open as a video**, **Insert as a clip here** (when a video is open), **Save a copy…**, **Delete**. The list opens on its own at launch when a recording was interrupted or not used.
- If Windows refuses to write to a folder (permissions, or the "Controlled folder access" protection of Windows Security), the message says so and explains how to allow Carnet.

## If the camera does not start

The recording window shows the cause and buttons to fix it:
- **Windows camera settings**: turn on "Let desktop apps access your camera".
- Close the other apps using the camera (Teams, Zoom, a browser, the Camera app).
- **Compatible mode**: uses the old Windows camera driver (DirectShow), which fixes the problem on many built-in webcams. Carnet restarts to apply it.
- Carnet takes the default Windows camera. If it does not answer, it takes any available camera. Another camera can be picked in the list.

On a Mac, macOS asks before the first recording whether Carnet may use the camera and the microphone. If the answer was no, **macOS camera settings** opens System Settings > Privacy & Security > Camera: turn on Carnet, then quit and reopen it (same for the microphone, under Microphone). Close the other apps using the camera (FaceTime, Zoom, Teams, a browser). There is no compatible mode on a Mac.

## Install on Windows

Requirement: Node.js LTS (https://nodejs.org).

Double-click `build-windows.bat`. The installer is created in `dist\Carnet-Setup-<version>.exe`. The next times, `compiler.bat` only rebuilds the installer, without installing the dependencies again. Once installed, Carnet shows up in "Open with" for mp4, mov, mkv, webm, avi and m4v files.

To run without installing (development): `npm install` then `npm start`.

## Install on a Mac

In the Releases of the GitHub page, take the disk image for your Mac: `Carnet-<version>-mac-arm64.dmg` for Apple Silicon (M1 and later), `Carnet-<version>-mac-x64.dmg` for an Intel Mac (Apple menu > About This Mac says which). Open it and drag Carnet into Applications.

Carnet is not signed with an Apple developer account, so macOS blocks it the first time:
1. Open Carnet from Applications. macOS says it cannot check it: click **Done** (or **OK**).
2. In System Settings > Privacy & Security, at the bottom, next to "Carnet was blocked", click **Open Anyway**, then confirm with your password.

Or, in Terminal (also the way out if macOS says Carnet "is damaged"): `xattr -dr com.apple.quarantine /Applications/Carnet.app`, then open Carnet normally.

macOS then asks, each thing once: the camera and the microphone (first recording), the local network (phone as a camera), notifications (daily reminder), and the keychain, where the Gemini key is kept (**Always Allow**). After installing a new version, it may ask again. On a Mac, a closed window does not quit Carnet: it stays in the Dock (Cmd+Q quits).

whisper is included in the Mac version. If it is missing (version built without it), Carnet says to install it with Homebrew: `brew install whisper-cpp`.

### Build the Mac version

On a Mac: Node.js LTS (https://nodejs.org) and Apple's command line tools (`xcode-select --install`); for whisper, cmake too (`brew install cmake`). Then, in Terminal, from the Carnet folder: `bash build-mac.sh`. The disk image is created in `dist/` (`-mac-arm64.dmg` on Apple Silicon, `-mac-x64.dmg` on Intel).

Without a Mac, GitHub builds it: push a tag such as `v0.2.0` (`git tag v0.2.0` then `git push origin v0.2.0`). `.github/workflows/build.yml` then builds Windows and both Macs, and creates a draft release with the three files; check it and publish it on GitHub. **Run workflow** in the Actions tab builds the same files without a release (under Artifacts on the page of the run).

The date on the clips and the progress reel need the drawtext filter of FFmpeg. If the GitHub build warns that the FFmpeg of a Mac version lacks it, that version exports without the date and cannot make the reel; everything else works.

## Structure

- `src/main.js`: window, opening files, "Open with", recording clips, export, Gemini calls with retries and pauses, progress reel, daily reminder and notification area (menu bar and menus on a Mac)
- `src/render.js`: FFmpeg commands (analysis, conversion, assembly, progress reel)
- `src/preload.js`: bridge between the interface and the system
- `src/whisper.js`: installing and running whisper.cpp (downloaded on Windows, included or from Homebrew on a Mac)
- `src/gemini.js`: requests to Gemini, embeddings for search memory, error types, free or paid key, daily call counter
- `src/journal.js`: journal data (videos, subjects, summaries, profile, progress, look-backs, clarifications, permanent facts, checks), requests sent to Gemini (and what they contain when search memory is used), Markdown files
- `src/memory.js`: search memory (vectors kept in `search-memory.json`, what changed, similarity)
- `src/instructions-journal.md`: default instructions, copied into the journal folder
- `src/i18n/`: languages (`index.js` and one dictionary per language)
- `src/renderer/journal-ui.js`: journal screen (before you talk, you, progress, look back, how far you’ve come, weeks, subjects, videos) and the notes of the recording
- `src/phonecam.js`, `src/selfcert.js`, `src/wslite.js`, `src/phone/index.html`, `src/renderer/phonecam.js`: phone camera (local server, certificate, WebSocket, phone page, receiving and decoding in the window)
- `src/phonerec.js`: recordings made by the phone (pieces written in order and acknowledged, resuming after a cut, partial then complete version, rotation written in the MP4)
- `src/vendor/qrcode.js`: QR code generation (Kazuhiko Arase, MIT licence)
- `src/renderer/`: interface (HTML, CSS, JS)
- `build/icon.svg`: the icon (a "C" with the red recording dot), exported to `icon.png` and `icon.ico` (a simpler drawing for 16 to 32 px); `build/icon-mac.svg`, the Mac icon (on a rounded square), exported to `icon.icns`; `trayTemplate.png` and `trayTemplate@2x.png`, the icon of the Mac menu bar
- `build-windows.bat`, `compiler.bat`: Windows installer; `build-mac.sh`: Mac disk image; `.github/workflows/build.yml`: both, on GitHub
- `DESIGN.md`: design rules

Recorded clips are stored in `%APPDATA%\Carnet\clips` (`~/Library/Application Support/Carnet/clips` on a Mac).

## Licence

Carnet is free software: you can redistribute it and change it under the terms of the GNU General Public License, version 3 or (at your option) any later version. It comes with no warranty. The full text is in `LICENSE`.

`src/vendor/qrcode.js` is by Kazuhiko Arase, under the MIT licence (`src/vendor/qrcode-LICENSE.txt`).

## Ideas for later

- Save and reopen a project
- Drag a clip on the timeline to move it
- Face cam as a picture in picture (small window in a corner), besides insertion
- Undo / redo
- Zoom on the timeline
