'use strict';
// Journal screen: before you talk (summary and open subjects), you, weeks, clarifications, subjects, videos by
// month, search, card of a video. Text goes through t() and tn() (src/i18n), dates through Intl.
(function () {
  let S = null;                // state received from the main process
  let view = { type: 'prep' }; // prep | you | progress | step | lookback | report | semaines | precisions | sujets | sujet | month | search | entry
  let busyMsg = null;
  const PERIODS = { jours7: 'Last 7 days', videos7: 'Last 7 videos', mois: 'This month' };
  const DAY = 864e5, ASLEEP = 14 * DAY;
  const p2 = (x) => String(x).padStart(2, '0');
  const loc = () => i18n.locale;
  const monthKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`; };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const monthLabel = (k) => { const [y, m] = k.split('-'); return cap(new Date(+y, +m - 1, 1).toLocaleDateString(loc(), { month: 'long', year: 'numeric' })); };
  const shortDay = (ts) => new Date(ts).toLocaleDateString(loc(), { day: '2-digit', month: '2-digit' });
  const clock = (ts) => new Date(ts).toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayLabel = (ts) => `${shortDay(ts)} · ${clock(ts)}`;
  const fullDay = (ts) => cap(new Date(ts).toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  const longDay = (ts) => new Date(ts).toLocaleDateString(loc(), { day: 'numeric', month: 'long', year: 'numeric' });
  const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const ago = (ts) => {
    const days = Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / DAY);
    return days <= 0 ? t('today') : days === 1 ? t('yesterday') : days < 7 ? tn(days, '{n} day ago', '{n} days ago') : t('on {date}', { date: shortDay(ts) });
  };
  const fmtT = (x) => { x = Math.max(0, Math.floor(x || 0)); const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = x % 60; return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`; };
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const title = (e) => (e.analysis && e.analysis.titre) || e.title || t('Untitled');
  const sorted = () => [...S.entries].sort((a, b) => b.date - a.date);
  const months = () => [...new Set(sorted().map((e) => monthKey(e.date)))];
  const main = () => $('jMain');
  const sub = (id) => S.sujets.find((s) => s.id === id);
  const entryById = (id) => S.entries.find((e) => e.id === id);
  const hasIdeas = (e) => !!(e.analysis && (e.analysis.idees || []).length);
  const anyJob = () => Object.keys(S.jobs).length > 0;
  const nVideos = (n) => tn(n, '{n} video', '{n} videos');
  const periodName = (b) => (b.period && PERIODS[b.period] ? t(PERIODS[b.period]) : b.label || '');
  const jobText = (job) => (job.step === 'Transcription' ? t('Transcription {pct} %', { pct: Math.round((job.pct || 0) * 100) }) : t(job.step) + '…');

  // ---------- Subjects ----------
  // For each subject: its ideas (with their video, in order), its videos, the first and the last time.
  let statsCache = null;
  function stats() {
    if (statsCache && statsCache.S === S) return statsCache.m;
    const m = new Map(S.sujets.map((s) => [s.id, { ideas: [], entries: [], first: Infinity, last: 0 }]));
    for (const e of [...S.entries].sort((a, b) => a.date - b.date)) {
      for (const i of (e.analysis && e.analysis.idees) || []) {
        const st = i.sujet && m.get(i.sujet);
        if (!st) continue;
        st.ideas.push({ ...i, entry: e });
        if (!st.entries.includes(e)) st.entries.push(e);
        st.first = Math.min(st.first, e.date);
        st.last = Math.max(st.last, e.date);
      }
    }
    statsCache = { S, m };
    return m;
  }
  const st = (s) => stats().get(s.id) || { ideas: [], entries: [], first: 0, last: 0 };
  // Pinned first, then from the most recently discussed to the oldest.
  function subjects(filter) {
    return S.sujets.filter(filter || (() => true)).sort((a, b) => (b.epingle ? 1 : 0) - (a.epingle ? 1 : 0) || st(b).last - st(a).last || a.titre.localeCompare(b.titre));
  }
  const openSubjects = () => subjects((s) => s.etat !== 'conclu');
  const subjectsOf = (e) => [...new Set(((e.analysis && e.analysis.idees) || []).map((i) => i.sujet).filter((id) => id && sub(id)))].map(sub);
  const subChip = (s) => `<span class="chip sub-chip${s.etat === 'conclu' ? ' done' : ''}" data-sub="${s.id}" title="${esc(s.etat === 'conclu' ? t('Concluded subject') : t('Open subject'))}">${esc(s.titre)}</span>`;

  // Link to the moment of an idea: opens the card and plays the video from there.
  const momentRef = (i, withDate) => `<span class="ref" data-id="${i.entry.id}" data-t="${i.t ?? ''}">${withDate ? shortDay(i.entry.date) + (i.t !== null && i.t !== undefined ? ' · ' : '') : ''}${i.t !== null && i.t !== undefined ? fmtT(i.t) : ''}</span>`;
  const videoRef = (id) => { const e = entryById(id); return e ? `<span class="ref" data-id="${e.id}">${shortDay(e.date)} · ${esc(title(e))}</span>` : ''; };

  // The person's own words, quoted by Gemini between the quotation marks of the language (« » “ ” „ “):
  // highlighted, and linked to the moment of the video where they are said when the transcript has them
  // (first in the videos given).
  const words = (x) => norm(x).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const spokenCache = new WeakMap();
  function spoken(e) {
    if (!e.transcript) return null;
    let c = spokenCache.get(e);
    if (!c) {
      c = { full: ' ', marks: [] };
      for (const sg of e.transcript.segments) { c.marks.push([c.full.length, sg.from]); c.full += words(sg.text) + ' '; }
      spokenCache.set(e, c);
    }
    return c;
  }
  function findSaid(q, entries) {
    const nq = words(q);
    if (!nq) return null;
    for (const e of [...(entries || []), ...sorted()]) {
      const c = spoken(e);
      const i = c ? c.full.indexOf(' ' + nq + ' ') : -1;
      if (i < 0) continue;
      let at = 0;
      for (const [pos, from] of c.marks) { if (pos <= i + 1) at = from; else break; }
      return { e, t: at };
    }
    return null;
  }
  const unesc = (x) => x.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const QUOTED = /(«\s*|“|„)([^«»“”„\n]{1,160}?)(\s*»|”|“)/g;
  function said(text, entries, link = true) {
    const sp = i18n.lang === 'fr' ? '&nbsp;' : '';
    return esc(text).replace(QUOTED, (m, open, q, close) => {
      const o = open.trim(), c = close.trim();
      const shown = o === '«' ? `«${sp}${q.trim()}${sp}»` : `${o}${q}${c}`;
      const hit = link && findSaid(unesc(q), entries);
      return hit
        ? `<span class="said-word" data-id="${hit.e.id}" data-t="${hit.t}" title="${esc(t('Your words, on {date} at {time}: click to hear them again', { date: shortDay(hit.e.date), time: fmtT(hit.t) }))}">${shown}</span>`
        : `<span class="said-word" title="${esc(t('Your words'))}">${shown}</span>`;
    });
  }

  // ---------- Gemini: waiting and pauses ----------
  const geminiWait = () => (S.gemini.wait && S.gemini.wait.until > Date.now() - 1000 ? S.gemini.wait : null);
  const geminiPause = () => (S.gemini.pause && S.gemini.pause.until > Date.now() ? S.gemini.pause : null);
  function geminiText() {
    const g = S.gemini;
    if (!g.hasKey) return '';
    const w = geminiWait(), p = geminiPause();
    if (w) return t('Gemini is busy, trying again in {s} s', { s: Math.max(1, Math.ceil((w.until - Date.now()) / 1000)) });
    if (p && p.kind === 'daily') return t('Gemini limit for today reached, resumes at {time}', { time: clock(p.until) });
    if (p && p.kind === 'quota') return t('Gemini quota used up, trying again at {time}', { time: clock(p.until) });
    if (p) return t('Gemini is busy, resumes at {time}', { time: clock(p.until) });
    return `Gemini ${g.usage.count}/${g.usage.budget}`;
  }

  // Where an entry is at: text + class for display.
  function status(e) {
    const job = S.jobs[e.id];
    if (job) return { cls: 'work', text: jobText(job) };
    if (!e.exists) return { cls: 'err', text: t('Video not found in the folder') };
    if (e.transcriptError) return { cls: 'err', text: t('Transcription failed') };
    if (!e.transcript && S.transcriber === 'whisper') return S.whisper.installed ? { cls: 'wait', text: t('Waiting for transcription') } : { cls: 'wait', text: t('Transcription to install (Settings)') };
    if (e.analysisError) return { cls: 'err', text: t('Analysis failed') };
    if (!e.analysis) {
      if (!S.gemini.hasKey) return { cls: 'wait', text: t('Gemini key to add (Settings)') };
      if (S.gemini.usage.left <= 0) return { cls: 'wait', text: t('Gemini calls used up for today: analysis after {time}', { time: clock(S.gemini.resetAt) }) };
      const p = geminiPause();
      if (p) return { cls: 'wait', text: t('Waiting for Gemini (resumes at {time})', { time: clock(p.until) }) };
      return { cls: 'wait', text: e.transcript ? t('Waiting for analysis') : t('Waiting for transcription') };
    }
    return null;
  }
  const canCall = () => S.gemini.hasKey && S.gemini.usage.left > 0;

  // ---------- Sidebar ----------
  function renderChip() {
    const job = Object.values(S.jobs)[0];
    const parts = [];
    if (job) parts.push(jobText(job));
    if (busyMsg) parts.push(busyMsg);
    const g = geminiText();
    if (g) parts.push(g);
    $('jChip').textContent = parts.join(' · ');
    $('jChip').classList.toggle('hidden', !parts.length);
    $('jChip').classList.toggle('waiting', !!(S.gemini.hasKey && (geminiWait() || geminiPause())));
  }
  // The countdown of a retry or a pause moves every second.
  setInterval(() => { if (S && (S.gemini.wait || S.gemini.pause)) renderChip(); }, 1000);

  function renderSide() {
    const inProgress = ['progress', 'lookback', 'report', 'step'].includes(view.type);
    document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('sel', view.type === b.dataset.nav || (inProgress && b.dataset.nav === 'progress')));
    const due = dueItems().length;
    $('jNavProgressN').textContent = due ? tn(due, '{n} to check', '{n} to check') : activeItems().length || '';
    $('jNavSujetsN').textContent = S.sujets.length || '';
    $('jNavSemainesN').textContent = Object.keys(S.semaines || {}).length || '';
    const toCheck = (S.checks || []).length;
    $('jNavPrecisionsN').textContent = toCheck ? tn(toCheck, '{n} to check', '{n} to check') : (S.faits || []).length || '';
    const open = openSubjects();
    const recent = open.filter((s) => s.epingle || Date.now() - st(s).last < ASLEEP).slice(0, 14);
    $('jSubjects').innerHTML = recent.length
      ? recent.map((s) => `<li data-sub="${s.id}" class="${view.type === 'sujet' && view.id === s.id ? 'sel' : ''}"><span class="t">${s.epingle ? `<span class="pin" title="${esc(t('Pinned'))}">●</span>` : ''}${esc(s.titre)}</span><span class="n">${shortDay(st(s).last)}</span></li>`).join('')
      : `<li class="muted small">${S.rebuild || S.jobs.rebuild ? t('Organising subjects…') : open.length ? t('No subject discussed in the last two weeks.') : t('Subjects appear once videos have been analysed.')}</li>`;
    $('jSubjects').querySelectorAll('li[data-sub]').forEach((li) => (li.onclick = () => go({ type: 'sujet', id: li.dataset.sub })));
    const ms = months();
    $('jMonths').innerHTML = ms.length
      ? ms.map((k) => `<li data-k="${k}" class="${view.type === 'month' && view.key === k ? 'sel' : ''}"><span>${monthLabel(k)}</span><span class="n">${S.entries.filter((e) => monthKey(e.date) === k).length}</span></li>`).join('')
      : `<li class="muted small">${t('No videos')}</li>`;
    $('jMonths').querySelectorAll('li[data-k]').forEach((li) => (li.onclick = () => go({ type: 'month', key: li.dataset.k })));
    renderChip();
  }
  document.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => go({ type: b.dataset.nav })));

  // ---------- Shared cards ----------
  function setupCard() {
    const steps = [
      { ok: !!S.dir, text: t('Choose the journal folder'), act: t('Choose'), fn: () => window.api.journalChooseDir().then(update) },
      { ok: S.gemini.hasKey, text: t('Add a free Gemini key: it transcribes the videos and follows your subjects'), act: t('Add'), fn: openSettings },
      ...(S.transcriber === 'whisper' ? [{ ok: S.whisper.installed, text: t('Install whisper (transcription on this computer)'), act: t('Install'), fn: openSettings }] : []),
    ];
    if (steps.every((x) => x.ok)) return '';
    const html = `<div class="card"><h3>${t('To get started')}</h3><ul class="setup-steps">${steps.map((x, i) =>
      `<li><span class="${x.ok ? 'ok' : 'todo'}">${x.ok ? '✓' : i + 1}</span><span class="txt">${x.text}</span>${x.ok ? '' : `<button class="btn" data-step="${i}">${x.act}</button>`}</li>`).join('')}</ul></div>`;
    setTimeout(() => main().querySelectorAll('[data-step]').forEach((b) => (b.onclick = steps[+b.dataset.step].fn)), 0);
    return html;
  }

  function entryCard(e, q) {
    const a = e.analysis;
    const s = status(e);
    const sum = a && a.resume ? (q ? highlight(a.resume, q) : said(a.resume, [e], false)) : '';
    const snippet = q ? searchSnippet(e, q) : '';
    const subs = subjectsOf(e);
    return `<article class="card entry-card" data-id="${e.id}">
      <div class="ec-top"><h4>${highlight(title(e), q)}</h4><span class="ec-date">${dayLabel(e.date)}</span></div>
      ${sum ? `<p class="ec-sum">${sum}</p>` : ''}
      ${snippet ? `<p class="ec-sum small">${snippet}</p>` : ''}
      ${subs.length ? `<div class="chips">${subs.map(subChip).join('')}</div>` : ''}
      <div class="ec-foot"><span>${fmtT(e.duration)}</span>${a && a.humeur ? `<span>${esc(a.humeur)}</span>` : ''}${s ? `<span class="status ${s.cls}">${s.text}</span>` : ''}</div>
    </article>`;
  }

  // Shared links: video cards, subject chips, moments, "Talk about it" buttons.
  function bind() {
    main().querySelectorAll('.entry-card').forEach((c) => (c.onclick = (ev) => {
      if (ev.target.closest('[data-sub]')) return;
      go({ type: 'entry', id: c.dataset.id });
    }));
    main().querySelectorAll('[data-sub]').forEach((x) => (x.onclick = (ev) => { ev.stopPropagation(); go({ type: 'sujet', id: x.dataset.sub }); }));
    main().querySelectorAll('.ref[data-id]').forEach((r) => (r.onclick = (ev) => { ev.stopPropagation(); go({ type: 'entry', id: r.dataset.id, t: r.dataset.t === '' || r.dataset.t === undefined ? null : +r.dataset.t }); }));
    main().querySelectorAll('[data-talk]').forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); startEntry(b.dataset.talk || null); }));
    main().querySelectorAll('.said-word[data-id]').forEach((w) => (w.onclick = (ev) => { ev.stopPropagation(); go({ type: 'entry', id: w.dataset.id, t: +w.dataset.t }); }));
    bindProgress();
  }
  const itemLine = (it, list) => `<li>${it.sujet && sub(it.sujet) ? `<b class="sub-link" data-sub="${it.sujet}">${esc(sub(it.sujet).titre)}</b>: ` : it.titre ? `<b>${esc(it.titre)}</b>: ` : ''}${said(it.texte, list)}</li>`;

  // ---------- Before you talk ----------
  function bilanCard() {
    const b = S.bilans[S.bilans.length - 1];
    const job = S.jobs.bilan;
    const period = S.bilanPeriod || 'jours7';
    const newer = b ? S.entries.filter((e) => e.analysis && e.analysis.at && e.analysis.at > b.at && (e.analysis.idees || []).length).length : 0;
    const bE = b ? (b.entries || []).map(entryById).filter(Boolean) : [];
    const item = (it) => itemLine(it, bE);
    const body = b ? `
      <p class="muted small">${[periodName(b), t('from {from} to {to}', { from: shortDay(b.from), to: shortDay(b.to) }), nVideos(b.n), t('made {when}', { when: ago(b.at) })].map(esc).join(' · ')}${newer ? ` · <span class="status wait">${tn(newer, '{n} video analysed since', '{n} videos analysed since')}</span>` : ''}</p>
      ${b.en_bref ? `<p>${said(b.en_bref, bE)}</p>` : ''}
      ${b.a_dire.length ? `<div class="to-say"><h4>${t('For the next video')}</h4><ul>${b.a_dire.map((x) => `<li>${said(x, bE)}</li>`).join('')}</ul></div>` : ''}
      ${b.avance.length ? `<h4>${t('What moved forward')}</h4><ul>${b.avance.map(item).join('')}</ul>` : ''}
      ${b.en_suspens.length ? `<h4>${t('Left hanging')}</h4><ul>${b.en_suspens.map(item).join('')}</ul>` : ''}
      ${b.contradictions.length ? `<h4>${t('To clarify')}</h4><ul>${b.contradictions.map((x) => `<li>${said(x, bE)}</li>`).join('')}</ul>` : ''}`
      : `<p class="muted">${S.entries.some((e) => e.analysis) ? t('No summary yet. It sums up what you said over the period, what moved forward, what was left hanging, and what you could pick up next.') : t('The summary will be possible once at least one video has been analysed.')}</p>`;
    return `<div class="card bilan">
      <div class="card-headrow"><h3>${t('Summary')}</h3><div class="spacer"></div>
        <select id="bilanPeriod" title="${esc(t('Period of the summary'))}">${Object.entries(PERIODS).map(([k, l]) => `<option value="${k}" ${k === period ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}</select>
        <button class="btn" id="btnBilan" ${canCall() && !job && !S.jobs.rebuild && S.entries.some((e) => e.analysis) ? '' : 'disabled'} title="${esc(t('Uses 1 Gemini call'))}">${job ? t('Summary in progress…') : b ? t('Redo the summary') : t('Make the summary')}</button>
      </div>
      ${S.bilanError ? `<p class="status err">${esc(S.bilanError)}</p>` : ''}
      ${body}</div>`;
  }

  // An open subject, as shown before you talk: where you're at, what is still to decide.
  function subjectBlock(s) {
    const x = st(s);
    return `<div class="sub-block" data-open="${s.id}">
      <div class="sb-top"><b class="sub-link" data-sub="${s.id}">${s.epingle ? '<span class="pin">●</span>' : ''}${esc(s.titre)}</b>
        <span class="muted small">${[s.categorie, nVideos(x.entries.length), t('last time {when}', { when: ago(x.last) })].filter(Boolean).map(esc).join(' · ')}</span>
        <div class="spacer"></div><button class="btn small-btn talk" data-talk="${s.id}" title="${esc(t('Record a video on this subject, with your notes on screen'))}">${t('Talk about it')}</button></div>
      ${s.ou_j_en_suis ? `<p>${said(s.ou_j_en_suis, x.entries)}</p>` : ''}
      ${s.evolution ? `<p class="sb-change"><span class="muted small">${t('Last video:')}</span> ${said(s.evolution, x.entries)}</p>` : ''}
      ${s.a_trancher.length ? `<div class="sb-open"><span class="muted small">${t('To decide')}</span><ul>${s.a_trancher.map((q) => `<li>${said(q, x.entries)}</li>`).join('')}</ul></div>` : ''}
    </div>`;
  }

  // Things to check: a video says something else than the journal (Permanent facts page).
  function checksBanner() {
    const n = (S.checks || []).length;
    if (!n) return '';
    return `<div class="card notice">${esc(tn(n, '{n} thing to check: a video says something different from your journal, without saying it changed.', '{n} things to check: videos say something different from your journal, without saying it changed.'))}
      <button class="btn small-btn" data-nav-prec>${t('Check')}</button></div>`;
  }
  function bindPrecisionButtons() {
    main().querySelectorAll('[data-nav-prec]').forEach((b) => (b.onclick = () => go({ type: 'precisions' })));
  }

  function rebuildBanner() {
    if (S.jobs.rebuild) return `<div class="card notice"><span class="status work">${t('Organising your videos into subjects…')}</span> ${t('Gemini reads all the cards again to find the threads you follow from one video to the next (1 call).')}</div>`;
    if (S.rebuild) return `<div class="card notice">${t('Your videos will be organised into subjects as soon as a Gemini call is available.')}${S.rebuildError ? ` <span class="status err">${esc(S.rebuildError)}</span>` : ''}</div>`;
    if (S.rebuildError) return `<div class="card notice"><span class="status err">${esc(t('Could not organise the subjects: {error}', { error: S.rebuildError }))}</span> <button class="btn small-btn" id="btnRebuildRetry">${t('Try again')}</button></div>`;
    return '';
  }

  function renderPrep() {
    if (!S.entries.length) {
      main().innerHTML = `<div class="j-wrap">${setupCard()}<div class="empty-j"><h2>${t('Your journal is empty')}</h2><p>${t('Talk to the camera. Carnet keeps track for you: it transcribes, picks out your ideas and follows each subject from one video to the next, where you are and what is still open.')}</p><button class="btn record-cta" data-talk=""><span class="dot"></span>${t('New entry')}</button></div></div>`;
      bind();
      return;
    }
    const open = openSubjects();
    const active = open.filter((s) => s.epingle || Date.now() - st(s).last < ASLEEP);
    const asleep = open.filter((s) => !active.includes(s));
    const last = sorted()[0];
    const recent = sorted().filter((e) => e.date >= Date.now() - 7 * DAY).slice(0, 8);
    main().innerHTML = `<div class="j-wrap">${setupCard()}
      <div class="j-head"><h1>${t('Before you talk')}</h1><span class="muted">${esc(tn(open.length, '{n} open subject', '{n} open subjects'))} · ${esc(t('last video {when}', { when: ago(last.date) }))}</span>
        <div class="spacer"></div><button class="btn record-cta" data-talk=""><span class="dot"></span>${t('New entry')}</button></div>
      ${rebuildBanner()}
      ${checksBanner()}
      ${rememberCard()}
      ${bilanCard()}
      <div class="card"><h3>${t('Your open subjects')}</h3>
        ${active.length ? active.map(subjectBlock).join('') : `<p class="muted">${asleep.length ? t('No subject discussed in the last two weeks.') : t('Subjects appear once videos have been analysed.')}</p>`}
      </div>
      ${asleep.length ? `<div class="card"><h3>${t('Left aside for more than two weeks')}</h3><ul class="asleep">${asleep.map((s) => `<li><b class="sub-link" data-sub="${s.id}">${esc(s.titre)}</b><span class="muted small">${esc(t('last time on {date}', { date: shortDay(st(s).last) }))}${s.a_trancher.length ? ' · ' + esc(s.a_trancher[0]) : ''}</span><div class="spacer"></div><button class="btn small-btn" data-talk="${s.id}">${t('Talk about it')}</button></li>`).join('')}</ul></div>` : ''}
      ${recent.length ? `<div class="card"><h3>${t('Your videos of the last 7 days')}</h3><ul class="recent">${recent.map((e) => `<li data-entry="${e.id}"><span class="muted small">${shortDay(e.date)}</span><span class="t">${esc(title(e))}</span><span class="chips">${subjectsOf(e).slice(0, 3).map(subChip).join('')}</span></li>`).join('')}</ul></div>` : ''}
    </div>`;
    bind();
    bindPrecisionButtons();
    main().querySelectorAll('[data-entry]').forEach((li) => (li.onclick = (ev) => { if (!ev.target.closest('[data-sub]')) go({ type: 'entry', id: li.dataset.entry }); }));
    if ($('btnRebuildRetry')) $('btnRebuildRetry').onclick = rebuild;
    $('bilanPeriod').onchange = () => window.api.journalSettings({ bilanPeriod: $('bilanPeriod').value }).then((s) => { S = s; });
    $('btnBilan').onclick = async () => {
      $('btnBilan').disabled = true;
      $('btnBilan').textContent = t('Summary in progress…');
      try { S = await window.api.journalBilan($('bilanPeriod').value); } catch (err) { showToast(cleanErr(err)); await update(); }
      render();
    };
  }

  // ---------- You ----------
  // What Carnet knows about the person (kept up to date by the analyses, editable), and their strengths and
  // weaknesses: their own list, a dot for where they are on each item, and suggestions. "Update" asks Gemini for
  // both in one call. Details (where a line comes from, why, what shows it) are in the tooltips.
  const prof = () => S.profile || { facts: [], removed: [], strengths: [], weaknesses: [], suggestions: null, dismissed: [], check: null, changes: [] };
  const DOT = { shows: 'Shows in recent videos', changing: 'Changing', not_seen: 'Not in recent videos' };
  const ICON_X = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>';
  const ICON_OK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  function factRow(f) {
    const e = f.entry && entryById(f.entry);
    const from = f.source === 'video' ? (e ? t('From the video of {date}', { date: shortDay(e.date) }) : t('From a video')) : t('Added by you');
    return `<li class="yrow" data-fact="${f.id}"><span class="ytext" title="${esc(from)}">${esc(f.text)}</span><button class="yico yx" data-del title="${esc(t('Remove'))}">${ICON_X}</button></li>`;
  }
  function itemRow(kind, it, check) {
    const c = check && check.items.find((x) => x.id === it.id);
    const dot = check ? `<span class="ydot ${c ? c.status : 'none'}" title="${esc(c ? t(DOT[c.status]) : t('Not checked yet'))}"></span>` : '';
    return `<li class="yrow" data-item="${it.id}" data-kind="${kind}">${dot}<span class="ytext"${c && c.note ? ` title="${esc(c.note)}"` : ''}>${esc(it.text)}</span><button class="yico yx" data-del title="${esc(t('Remove'))}">${ICON_X}</button></li>`;
  }
  function suggestionRow(kind, s) {
    return `<li class="yrow ysug" data-sugg="${s.id}" data-kind="${kind}"><span class="ytext"${s.why ? ` title="${esc(s.why)}"` : ''}>${esc(s.text)}</span>`
      + `<button class="yico yok" data-ok title="${esc(t('Add to your list'))}">${ICON_OK}</button><button class="yico yx" data-dismiss title="${esc(t('Dismiss'))}">${ICON_X}</button></li>`;
  }
  function renderYou() {
    const p = prof();
    const analysed = S.entries.some(hasIdeas);
    const can = canCall() && analysed && !anyJob();
    const last = Math.max((p.check && p.check.at) || 0, (p.suggestions && p.suggestions.at) || 0);
    const sug = p.suggestions || {};
    const tip = !S.gemini.hasKey ? t('Add a Gemini key in Settings first.') : !analysed ? t('Possible once a video has been analysed.') : t('Looks at your videos: where you are on each item, and about ten new suggestions of each kind (1 Gemini call)');
    // Your items first; the suggestions together below them, in one dashed box, with "Add all".
    const col = (k) => {
      const ss = sug[k] || [];
      return `<div class="ycol"><h4>${k === 'strengths' ? t('Strengths') : t('Weaknesses')}</h4>
        <ul class="ylist">${p[k].map((it) => itemRow(k, it, p.check)).join('')}</ul>
        ${ss.length ? `<div class="ysugs"><div class="ysugs-head"><span>${esc(tn(ss.length, '{n} suggestion', '{n} suggestions'))}</span><button class="link-btn" data-addall="${k}" title="${esc(t('Adds all the suggestions of this column to your list'))}">${t('Add all')}</button></div>
          <ul class="ylist">${ss.map((x) => suggestionRow(k, x)).join('')}</ul></div>` : ''}
        <input type="text" class="yadd" data-add="${k}" placeholder="${esc(k === 'strengths' ? t('Add a strength') : t('Add a weakness'))}" spellcheck="false"></div>`;
    };
    main().innerHTML = `<div class="j-wrap you">
      <div class="j-head"><h1>${t('You')}</h1><span class="muted">${t('what Carnet knows about you')}</span></div>
      ${S.profileError ? `<p class="status err">${esc(S.profileError)}</p>` : ''}
      <div class="card"><h3>${t('About you')}</h3>
        ${p.facts.length ? `<ul class="ylist">${p.facts.map(factRow).join('')}</ul>` : `<p class="muted small">${t('Nothing yet. Carnet adds what you say about yourself in your videos.')}</p>`}
        <input type="text" class="yadd" id="factInput" placeholder="${esc(t('Add something about you'))}" spellcheck="false"></div>
      <div class="card">
        <div class="card-headrow"><h3>${t('Strengths and weaknesses')}</h3><div class="spacer"></div>
          ${last ? `<span class="muted small">${esc(t('updated {when}', { when: ago(last) }))}</span>` : ''}
          <button class="btn small-btn" id="btnReview" ${can ? '' : 'disabled'} title="${esc(tip)}">${S.profileJob ? t('Updating…') : t('Update')}</button></div>
        <div class="ycols">${col('strengths')}${col('weaknesses')}</div>
        ${p.check && p.strengths.length + p.weaknesses.length ? `<p class="ylegend muted small"><span class="ydot shows"></span>${t('shows in your recent videos')}<span class="ydot changing"></span>${t('changing')}<span class="ydot not_seen"></span>${t('not seen lately')}</p>` : ''}
      </div>
    </div>`;
    const act = async (a) => {
      try { S = await window.api.journalProfile(a); } catch (err) { showToast(cleanErr(err)); await update(); return; }
      render.lastKey = null;
      render();
    };
    main().querySelectorAll('.yadd').forEach((inp) => (inp.onkeydown = (ev) => {
      if (ev.key !== 'Enter') return;
      const text = inp.value.trim();
      if (!text) return;
      act(inp.dataset.add ? { action: 'addItem', kind: inp.dataset.add, text } : { action: 'addFact', text });
    }));
    main().querySelectorAll('[data-fact] [data-del]').forEach((b) => (b.onclick = () => act({ action: 'removeFact', id: b.closest('[data-fact]').dataset.fact })));
    main().querySelectorAll('[data-item] [data-del]').forEach((b) => { const li = b.closest('[data-item]'); b.onclick = () => act({ action: 'removeItem', kind: li.dataset.kind, id: li.dataset.item }); });
    main().querySelectorAll('[data-addall]').forEach((b) => (b.onclick = () => act({ action: 'addAll', kind: b.dataset.addall })));
    main().querySelectorAll('[data-sugg]').forEach((li) => {
      const k = li.dataset.kind, s = (sug[k] || []).find((x) => x.id === li.dataset.sugg);
      if (!s) return;
      li.querySelector('[data-ok]').onclick = () => act({ action: 'addItem', kind: k, text: s.text, fromSuggestion: s.id });
      li.querySelector('[data-dismiss]').onclick = () => act({ action: 'dismiss', kind: k, id: s.id });
    });
    $('btnReview').onclick = async () => {
      $('btnReview').disabled = true;
      $('btnReview').textContent = t('Updating…');
      await act({ action: 'review' });
    };
  }

  // ---------- Progress ----------
  // What was done or settled, understood (how to act, how to see a situation) and left behind, each with the moment
  // it started ("then") and the moment it happened ("now"). Realizations and things left behind come back in
  // "Remember" (Before you talk) at growing intervals, and later videos that meet them are noted under them.
  const prog = () => S.progress || { items: [], asked: {}, lookbacks: [], reports: [], backfilled: 0 };
  const itemById = (id) => prog().items.find((x) => x.id === id);
  const activeItems = () => prog().items.filter((x) => x.status === 'active');
  const kindCls = (x) => (x.kind === 'done' ? 'done' : x.kind === 'moved' ? 'moved' : 'understood');
  const kindLabel = (x) => (x.kind === 'done' ? (x.settled ? t('Settled') : t('Done')) : x.kind === 'moved' ? t('Moved past') : x.how === 'see' ? t('Understood (how to see it)') : t('Understood (how to act)'));
  const dueItems = () => activeItems().filter((x) => x.kind !== 'done' && x.review && x.review.due <= Date.now()).sort((a, b) => a.review.due - b.review.due);
  // A moment of a video: opens its card and plays it from there.
  const hasT = (m) => m && m.t !== null && m.t !== undefined;
  const moment = (m, label) => { const e = m && entryById(m.entry); return e ? `<span class="ref pg-mom" data-id="${e.id}" data-t="${hasT(m) ? m.t : ''}" title="${esc(title(e))}">${esc(label)} · ${shortDay(e.date)}${hasT(m) ? ' · ' + fmtT(m.t) : ''}</span>` : ''; };
  const playable = (m) => { const e = m && entryById(m.entry); return !!(e && e.exists); };
  const bothMoments = (x) => playable(x.then) && playable(x.now);
  const thenNowBtn = (x) => (bothMoments(x) ? `<button class="btn small-btn" data-tn="${x.id}" title="${esc(t('The two moments side by side'))}">${t('Then and now')}</button>` : '');
  // What happened since: later videos that met it, and the answers given in Remember.
  // Under "how to see it", "applied" means "seen this way".
  const EFFECT = {
    act: { applied: 'applied', against: 'not applied', similar: 'same kind of situation' },
    see: { applied: 'seen this way', against: 'not seen this way', similar: 'same kind of situation' },
    moved: { applied: 'still behind you', against: 'came back', similar: 'came up again' },
  };
  const effectText = (x, eff) => t((EFFECT[x.kind === 'moved' ? 'moved' : x.how === 'see' ? 'see' : 'act'] || EFFECT.act)[eff] || 'same kind of situation');
  const ANSWER = { applied: 'applied', forgot: 'forgotten', still: 'still behind you', stale: 'no longer true', back: 'came back' };
  const answerText = (x, a) => t(a === 'applied' && x.how === 'see' ? 'seen this way' : ANSWER[a] || a);
  function sinceLine(x) {
    const ev = [
      ...(x.track || []).map((k) => ({ date: k.date, text: effectText(x, k.effect), cls: k.effect, entry: k.entry, t: k.t, note: k.note })),
      ...((x.review && x.review.log) || []).map((l) => ({ date: l.at, text: answerText(x, l.answer), cls: l.answer === 'forgot' || l.answer === 'back' || l.answer === 'stale' ? 'against' : 'applied' })),
    ].sort((a, b) => a.date - b.date);
    if (!ev.length) return '';
    return `<div class="pg-since"><span class="muted small">${t('Since then:')}</span>${ev.slice(-6).map((k) => (k.entry && entryById(k.entry)
      ? `<span class="ref pg-ev ${k.cls}" data-id="${k.entry}" data-t="${k.t ?? ''}" title="${esc(k.note || title(entryById(k.entry)))}">${shortDay(k.date)} · ${esc(k.text)}</span>`
      : `<span class="pg-ev ${k.cls}" title="${esc(t('Your answer in Remember'))}">${shortDay(k.date)} · ${esc(k.text)}</span>`)).join('')}</div>`;
  }
  const ASIDE = { reopened: 'Put aside: the subject was reopened.', merged: 'Put aside: its subject was merged into another one.', stale: 'Put aside: you said it is no longer true.', back: 'Put aside: you said it came back.', hand: 'Put aside by you.' };
  let pgEditing = null; // id of the step being edited
  let pgDraft = null;   // the "Add by hand" form while it is open: { kind, situation, text, subject }
  function progressItem(x) {
    if (pgEditing === x.id) return editItemForm(x);
    const s = x.subject && sub(x.subject);
    const due = x.status === 'active' && x.kind !== 'done' && x.review && x.review.due <= Date.now();
    const meta = [shortDay(x.date), s ? subChip(s) : x.subjectTitle ? esc(x.subjectTitle) : '', x.source === 'manual' ? esc(t('added by you')) : ''].filter(Boolean).join(' · ');
    return `<div class="pg-item ${kindCls(x)}${x.status !== 'active' ? ' aside' : ''}" data-item="${x.id}">
      <div class="pg-top"><span class="pg-kind ${kindCls(x)}">${esc(kindLabel(x))}</span><span class="muted small pg-meta">${meta}</span>${due ? `<span class="status wait small">${t('to check')}</span>` : ''}<div class="spacer"></div>
        <span class="pg-acts"><button class="link-btn" data-pg="edit">${t('Edit')}</button>${x.status === 'active'
          ? `<button class="link-btn" data-pg="archive" title="${esc(t('Hidden from the list and from Remember. You can bring it back.'))}">${t('Put aside')}</button>`
          : `<button class="link-btn" data-pg="restore">${t('Bring back')}</button>`}${x.source !== 'subject' ? `<button class="link-btn danger-link" data-pg="delete">${t('Delete')}</button>` : ''}</span></div>
      ${x.situation ? `<div class="pg-sit">${esc(x.situation)}</div>` : ''}
      <div class="pg-text">${said(x.text, null, false)}</div>
      <div class="pg-moments">${moment(x.then, t('Then'))}${moment(x.now, t('Now'))}${thenNowBtn(x)}<button class="link-btn" data-tl="${x.id}">${t('Its timeline')}</button></div>
      ${sinceLine(x)}
      ${x.status !== 'active' && ASIDE[x.archivedWhy] ? `<div class="muted small">${esc(t(ASIDE[x.archivedWhy]))}</div>` : ''}
    </div>`;
  }
  function editItemForm(x) {
    return `<div class="pg-item editing ${kindCls(x)}" data-item="${x.id}">
      ${x.kind === 'understood' ? `<div class="pg-form-row"><select data-f="how"><option value="act" ${x.how !== 'see' ? 'selected' : ''}>${esc(t('Understood (how to act)'))}</option><option value="see" ${x.how === 'see' ? 'selected' : ''}>${esc(t('Understood (how to see it)'))}</option></select>
        <input type="text" data-f="situation" value="${esc(x.situation || '')}" placeholder="${esc(t('In what situation'))}" spellcheck="false"></div>` : ''}
      <textarea data-f="text" rows="2" spellcheck="false">${esc(x.text)}</textarea>
      <div class="pg-form-row"><button class="btn primary small-btn" data-pg="save">${t('Save')}</button><button class="btn small-btn" data-pg="cancel">${t('Cancel')}</button></div>
    </div>`;
  }
  const ADD_KINDS = [['understood:act', 'Understood (how to act)'], ['understood:see', 'Understood (how to see it)'], ['done', 'Done'], ['moved', 'Moved past']];
  function addForm() {
    const d = pgDraft || {};
    const kind = d.kind || 'understood:act';
    return `<div class="card pg-add" id="pgAdd"><h3>${t('Add a step forward')}</h3>
      <div class="pg-form-row"><select id="pgKind">${ADD_KINDS.map(([v, l]) => `<option value="${v}" ${v === kind ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}</select>
        <select id="pgSub"><option value="">${t('No subject')}</option>${subjects().map((s) => `<option value="${s.id}" ${s.id === d.subject ? 'selected' : ''}>${esc(s.titre)}</option>`).join('')}</select></div>
      <input type="text" id="pgSit" class="${kind.startsWith('understood') ? '' : 'hidden'}" value="${esc(d.situation || '')}" placeholder="${esc(t('In what situation (for example: when someone criticises my work)'))}" spellcheck="false">
      <textarea id="pgText" rows="2" placeholder="${esc(t('What you understood, did or left behind'))}" spellcheck="false">${esc(d.text || '')}</textarea>
      <div class="pg-form-row"><button class="btn primary" id="pgSave">${t('Add')}</button><button class="btn" id="pgCancel">${t('Cancel')}</button></div>
    </div>`;
  }

  async function pAct(a) {
    try { S = await window.api.journalProgress(a); } catch (err) { showToast(cleanErr(err)); await update(); return false; }
    render.lastKey = null;
    render();
    return true;
  }
  // Buttons shared by the pages: answers in Remember, subjects that stopped coming up, then and now, look-back.
  function bindProgress() {
    const root = main();
    root.querySelectorAll('[data-go]').forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); go({ type: b.dataset.go }); }));
    root.querySelectorAll('[data-go-filter]').forEach((b) => (b.onclick = () => go({ type: 'progress', filter: b.dataset.goFilter })));
    root.querySelectorAll('[data-answer]').forEach((b) => (b.onclick = () => pAct({ action: 'answer', id: b.closest('[data-item]').dataset.item, answer: b.dataset.answer })));
    root.querySelectorAll('[data-fade]').forEach((b) => (b.onclick = () => pAct({ action: 'fading', subject: b.closest('[data-fading]').dataset.fading, yes: b.dataset.fade === 'yes' })));
    root.querySelectorAll('[data-tn]').forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); openThenNow(b.dataset.tn); }));
    root.querySelectorAll('[data-tl]').forEach((b) => (b.onclick = (ev) => {
      if (ev.target.closest('[data-tn], [data-sub], .ref')) return;
      ev.stopPropagation();
      go({ type: 'step', id: b.dataset.tl, back: { ...view, back: undefined } });
    }));
    root.querySelectorAll('[data-lb-later]').forEach((b) => (b.onclick = () => pAct({ action: 'later' })));
    root.querySelectorAll('[data-reel]').forEach((b) => (b.onclick = openReel));
    root.querySelectorAll('[data-backfill]').forEach((b) => (b.onclick = backfill));
    // Edit, put aside, bring back, delete a step (Progress page, subject, look-back).
    root.querySelectorAll('.pg-item [data-pg]').forEach((b) => (b.onclick = async (ev) => {
      ev.stopPropagation();
      const box = b.closest('[data-item]'), id = box.dataset.item, act = b.dataset.pg;
      if (act === 'edit') { pgEditing = id; render.lastKey = null; render(); const ta = main().querySelector(`[data-item="${id}"] textarea`); if (ta) ta.focus(); return; }
      if (act === 'cancel') { pgEditing = null; render.lastKey = null; render(); return; }
      if (act === 'save') {
        const val = (f) => { const el = box.querySelector(`[data-f="${f}"]`); return el ? el.value : undefined; };
        const a = { action: 'edit', id, text: val('text'), situation: val('situation'), how: val('how') };
        pgEditing = null;
        await pAct(a);
        return;
      }
      if (act === 'delete' && !confirm(t('Delete this step forward for good? “Put aside” hides it and keeps it.'))) return;
      await pAct({ action: act, id });
    }));
  }
  async function backfill() {
    if (!confirm(t('Look through your earlier videos for steps forward? Gemini reads the cards of your videos (the last 250) and notes what you did, understood or left behind, with the moments (1 call).'))) return;
    busyMsg = t('Looking for steps forward');
    render();
    try {
      const r = await window.api.journalProgress({ action: 'backfill' });
      S = r;
      showToast(r.backfillAdded ? tn(r.backfillAdded, '{n} step forward found in your earlier videos.', '{n} steps forward found in your earlier videos.') : t('No new step forward found.'));
    } catch (err) { showToast(cleanErr(err)); await update(); }
    busyMsg = null;
    render.lastKey = null;
    render();
  }

  // Remember (Before you talk): the look-back when it is time, the realizations and things left behind to check
  // (3 at a time), a subject that stopped coming up, and where you stood a month ago.
  function rememberCard() {
    const due = dueItems();
    const fading = (S.progressFading || [])[0];
    const lb = S.lookback;
    // A look-back that is due, or prepared and not recorded yet; "Not now" hides it for a week.
    const lbShow = !!(lb && (lb.due || (lb.open && Date.now() >= (prog().later || 0))));
    const ma = S.monthAgo || [];
    const month = ma.length ? ma[Math.floor(Date.now() / DAY) % ma.length] : null;
    if (!due.length && !fading && !lbShow && !month) return '';
    return `<div class="card remember">
      <div class="card-headrow"><h3>${t('Remember')}</h3>${due.length ? `<span class="muted small">${esc(tn(due.length, '{n} to check', '{n} to check'))}</span>` : ''}<div class="spacer"></div><button class="link-btn" data-go="progress">${t('All your progress')}</button></div>
      ${lbShow ? lookbackNotice(lb) : ''}
      ${due.slice(0, 3).map(dueBlock).join('')}
      ${due.length > 3 ? `<button class="link-btn rm-more" data-go-filter="check">${esc(tn(due.length - 3, '{n} more to check', '{n} more to check'))}</button>` : ''}
      ${fading ? fadingBlock(fading) : ''}
      ${month ? monthBlock(month) : ''}
    </div>`;
  }
  function lookbackNotice(lb) {
    const text = lb.open ? t('Your look-back since {date} is ready to record.', { date: shortDay(lb.from) })
      : t('A month since {date}: {videos}, {steps}. Time to look back.', { date: shortDay(lb.from), videos: nVideos(lb.videos), steps: tn(lb.items, '{n} step forward', '{n} steps forward') });
    return `<div class="rm-item rm-lb"><div class="rm-q">${esc(text)}</div>
      <div class="rm-foot"><div class="rm-answer"><button class="btn small-btn primary" data-go="lookback">${t('Look back')}</button><button class="btn small-btn" data-lb-later title="${esc(t('Asked again in a week'))}">${t('Not now')}</button></div></div></div>`;
  }
  function dueBlock(x) {
    const s = x.subject && sub(x.subject);
    const q = x.kind === 'moved' ? t('Still behind you?') : x.how === 'see' ? t('Since then, did you see it this way?') : t('Since then, did you apply it?');
    const btns = x.kind === 'moved'
      ? `<button class="btn small-btn primary" data-answer="still">${t('Still behind me')}</button><button class="btn small-btn" data-answer="back">${t('It came back')}</button>`
      : `<button class="btn small-btn primary" data-answer="applied">${x.how === 'see' ? t('I saw it this way') : t('I applied it')}</button><button class="btn small-btn" data-answer="forgot">${t('I forgot it')}</button><button class="btn small-btn" data-answer="stale" title="${esc(t('Put aside: it does not apply any more'))}">${t('No longer true')}</button>`;
    return `<div class="rm-item" data-item="${x.id}">
      <div class="pg-top"><span class="pg-kind ${kindCls(x)}">${esc(kindLabel(x))}</span><span class="muted small pg-meta">${[shortDay(x.date), s ? subChip(s) : ''].filter(Boolean).join(' · ')}</span><div class="spacer"></div><button class="link-btn" data-tl="${x.id}">${t('Its timeline')}</button></div>
      ${x.situation ? `<div class="pg-sit">${esc(x.situation)}</div>` : ''}
      <div class="pg-text">${said(x.text, null, false)}</div>
      ${sinceLine(x)}
      <div class="rm-foot">${moment(x.then, t('Then'))}${moment(x.now, t('Now'))}${thenNowBtn(x)}<div class="rm-answer"><span class="rm-ask">${esc(q)}</span>${btns}</div></div>
    </div>`;
  }
  function fadingBlock(f) {
    return `<div class="rm-item" data-fading="${f.id}">
      <div class="rm-q">${esc(t('“{title}” came up in {videos}, and not since {date}.', { title: f.titre, videos: nVideos(f.videos), date: shortDay(f.last) }))}</div>
      <div class="rm-foot"><button class="link-btn" data-sub="${f.id}">${t('See the subject')}</button><div class="rm-answer"><span class="rm-ask">${t('Is it behind you?')}</span>
        <button class="btn small-btn primary" data-fade="yes" title="${esc(t('It becomes a step forward and the subject is concluded'))}">${t('Yes, it’s behind me')}</button><button class="btn small-btn" data-fade="no" title="${esc(t('Asked again in two months'))}">${t('Not really')}</button></div></div>
    </div>`;
  }
  function monthBlock(m) {
    return `<div class="rm-month">
      <div class="rm-q"><span class="muted small">${t('A month ago')} ·</span> <b class="sub-link" data-sub="${m.id}">${esc(m.titre)}</b></div>
      <p><span class="rm-label">${t('Then')}</span>${said(m.then, null, false)}${m.thenEntry && entryById(m.thenEntry) ? ` <span class="ref small" data-id="${m.thenEntry}">${shortDay(entryById(m.thenEntry).date)}</span>` : ''}</p>
      <p><span class="rm-label now">${t('Now')}</span>${said(m.now, null, false)}${m.nowEntry && entryById(m.nowEntry) ? ` <span class="ref small" data-id="${m.nowEntry}">${shortDay(entryById(m.nowEntry).date)}</span>` : ''}</p>
    </div>`;
  }

  // The Progress page: in numbers, the subjects that stopped coming up, then everything by month.
  function renderProgress() {
    const all = prog().items;
    const act = activeItems();
    const due = dueItems();
    const aside = all.filter((x) => x.status !== 'active');
    const f = view.filter || 'all';
    const list = (f === 'aside' ? aside : f === 'check' ? due : act.filter((x) => f === 'all' || kindCls(x) === f)).sort((a, b) => b.date - a.date);
    const range = view.range || 'all';
    const n = (k) => act.filter((x) => kindCls(x) === k).length;
    const first = act.length ? Math.min(...act.map((x) => x.date)) : 0;
    const chip = (k, label, count) => `<button class="chip${f === k ? ' sel' : ''}" data-filter="${k}">${esc(label)}${count ? `<span class="n">${count}</span>` : ''}</button>`;
    const analysed = S.entries.some(hasIdeas);
    const fading = S.progressFading || [];
    const backfillCard = analysed && !prog().backfilled
      ? `<div class="card notice">${t('Your earlier videos may hold steps forward too: things you did, understood or left behind before Carnet followed them.')}
          <button class="btn small-btn" data-backfill ${canCall() && !anyJob() ? '' : 'disabled'} title="${esc(t('Gemini reads the cards of your videos (the last 250) and notes the steps forward with their moments (1 call)'))}">${S.progressJob === 'backfill' ? t('Looking…') : t('Look through my earlier videos')}</button></div>` : '';
    main().innerHTML = `<div class="j-wrap progress-page">
      <div class="j-head pg-head"><h1>${t('Progress')}</h1><span class="muted pg-sub">${t('what you did, understood and left behind')}</span>
        <span class="pg-head-btns"><button class="btn" data-go="lookback">${t('Look back')}</button>
        <button class="btn" data-go="report">${t('How far you’ve come')}</button>
        <button class="btn" data-reel>${t('Progress reel')}</button></span></div>
      ${S.progressError ? `<p class="status err">${esc(S.progressError)}</p>` : ''}
      <div class="pg-stats">
        <div class="pg-stat done"><b>${n('done')}</b><span>${t('done or settled')}</span></div>
        <div class="pg-stat understood"><b>${n('understood')}</b><span>${t('understood')}</span></div>
        <div class="pg-stat moved"><b>${n('moved')}</b><span>${t('moved past')}</span></div>
        <div class="pg-stat tocheck"><b>${due.length}</b><span>${t('to check')}</span></div>
      </div>
      ${first ? `<p class="muted small pg-since-first">${esc(t('Since {date}, the first step forward noted.', { date: longDay(first) }))}</p>` : ''}
      ${fading.length ? `<div class="card remember"><h3>${t('Stopped coming up')}</h3>${fading.slice(0, 5).map(fadingBlock).join('')}${fading.length > 5 ? `<p class="muted small">${esc(tn(fading.length - 5, '{n} more after these', '{n} more after these'))}</p>` : ''}</div>` : ''}
      ${backfillCard}
      <div class="pg-filters">${chip('all', t('All'), act.length)}${chip('check', t('To check'), due.length)}${chip('done', t('Done'), n('done'))}${chip('understood', t('Understood'), n('understood'))}${chip('moved', t('Moved past'), n('moved'))}${aside.length ? chip('aside', t('Put aside'), aside.length) : ''}
        <div class="spacer"></div>${prog().backfilled && analysed ? `<button class="link-btn" data-backfill ${canCall() && !anyJob() ? '' : 'disabled'} title="${esc(t('Gemini reads the cards of your videos again (1 call)'))}">${t('Look through earlier videos again')}</button>` : ''}<button class="btn small-btn" id="pgAddBtn">${t('Add by hand')}</button></div>
      ${pgDraft ? addForm() : ''}
      ${list.length ? chart(list, range, true)
        : `<p class="muted">${f === 'all' ? t('Nothing yet. Each analysed video adds what you say you did, understood or left behind, with the moment you say it. Concluded subjects come here too.') : t('Nothing here.')}</p>`}
    </div>`;
    bind();
    main().querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => { view.filter = b.dataset.filter; render.lastKey = null; render(); }));
    main().querySelectorAll('[data-range]').forEach((b) => (b.onclick = () => { view.range = b.dataset.range; render.lastKey = null; render(); }));
    $('pgAddBtn').onclick = () => { if (!pgDraft) pgDraft = { kind: 'understood:act', situation: '', text: '', subject: '' }; render.lastKey = null; render(); if ($('pgText')) $('pgText').focus(); };
    if ($('pgAdd')) {
      const sync = () => {
        pgDraft = { kind: $('pgKind').value, situation: $('pgSit').value, text: $('pgText').value, subject: $('pgSub').value };
        $('pgSit').classList.toggle('hidden', !pgDraft.kind.startsWith('understood'));
      };
      ['pgKind', 'pgSit', 'pgText', 'pgSub'].forEach((id) => { $(id).oninput = sync; $(id).onchange = sync; });
      $('pgCancel').onclick = () => { pgDraft = null; render.lastKey = null; render(); };
      $('pgSave').onclick = async () => {
        sync();
        if (!pgDraft.text.trim()) { $('pgText').focus(); return; }
        const d = pgDraft, [kind, how] = d.kind.split(':');
        pgDraft = null;
        await pAct({ action: 'add', kind, how, text: d.text, situation: d.situation, subject: d.subject || null });
      };
    }
  }

  // ---------- The timeline of a step forward ----------
  // Every event of one step forward, oldest first: where it started, each video where its subject came up before it
  // (what that video changed), the step itself, then each later video that applied it or went against it, your
  // answers in Remember, its subject concluded, put aside, and the next check.
  const TYPE_RANK = { start: 0, mention: 1, step: 2, applied: 3, against: 3, similar: 3, answer: 4, concluded: 5, aside: 6, next: 7 };
  const TRACKED = new Set(['applied', 'against', 'similar']);
  // The to-do a "done" step closes, as it was written in its video.
  function planText(x) {
    const m = /^t-(.+)-(\d+)$/.exec(x.plan || '');
    const e = m && entryById(m[1]);
    return (e && e.analysis && (e.analysis.a_faire || [])[+m[2]]) || '';
  }
  function stepEvents(x) {
    const ev = [];
    const s = x.subject && sub(x.subject);
    if (x.then && entryById(x.then.entry)) ev.push({ type: 'start', date: x.then.date, entry: x.then.entry, t: x.then.t, text: planText(x) || ideaAt(x.then) });
    if (s) {
      // The video of the step is the step itself, not a mention (unless the step was said later, by hand).
      const own = x.now && Math.abs(x.now.date - x.date) < 60e3 ? x.now.entry : null;
      const states = new Map((s.historique || []).filter((h) => h.entry).map((h) => [h.entry, h]));
      if (s.majPar) states.set(s.majPar, s);
      const ideas = new Map();
      for (const i of st(s).ideas) { if (!ideas.has(i.entry)) ideas.set(i.entry, []); ideas.get(i.entry).push(i); }
      for (const e of st(s).entries) {
        if (x.then && (e.id === x.then.entry || e.date <= x.then.date)) continue;
        if (e.id === own || e.date > x.date) continue;
        const h = states.get(e.id), list = ideas.get(e) || [];
        ev.push({ type: 'mention', date: e.date, entry: e.id, t: list.length && hasT(list[0]) ? list[0].t : null, text: (h && (h.evolution || h.ou_j_en_suis)) || list.map((i) => i.texte).join(' · ') });
      }
    }
    const listed = new Set(ev.map((e) => e.entry));
    const nowOk = !!(x.now && entryById(x.now.entry) && !listed.has(x.now.entry));
    ev.push({ type: 'step', date: x.date, entry: nowOk ? x.now.entry : null, t: nowOk ? x.now.t : null, text: x.text });
    for (const k of x.track || []) ev.push({ type: k.effect, date: k.date, entry: entryById(k.entry) ? k.entry : null, t: k.t, text: k.note || '' });
    for (const l of (x.review && x.review.log) || []) ev.push({ type: 'answer', answer: l.answer, date: l.at, text: '' });
    if (s && s.etat === 'conclu' && !x.settled && (s.majLe || 0) > x.date) ev.push({ type: 'concluded', date: s.majLe, entry: s.majPar && entryById(s.majPar) ? s.majPar : null, t: null, text: s.conclusion || '' });
    if (x.status !== 'active' && x.archivedAt) ev.push({ type: 'aside', date: x.archivedAt, text: ASIDE[x.archivedWhy] ? t(ASIDE[x.archivedWhy]) : '' });
    // What comes next: its next check, or "to check" today when its time has come.
    if (x.status === 'active' && x.kind !== 'done' && x.review) {
      if (x.review.due > Date.now()) ev.push({ type: 'next', date: x.review.due, future: true, text: '' });
      else ev.push({ type: 'next', date: Date.now(), due: true, text: '' });
    }
    return ev.sort((a, b) => a.date - b.date || TYPE_RANK[a.type] - TYPE_RANK[b.type]);
  }
  function eventLabel(x, e) {
    if (e.type === 'start') return x.kind === 'done' && x.plan ? t('Planned') : t('It started');
    if (e.type === 'mention') return t('Came up');
    if (e.type === 'step') return kindLabel(x);
    if (TRACKED.has(e.type)) return cap(effectText(x, e.type));
    if (e.type === 'answer') return t('Your answer: {answer}', { answer: answerText(x, e.answer) });
    if (e.type === 'concluded') return t('Subject concluded');
    if (e.type === 'aside') return t('Put aside');
    return e.due ? t('To check') : t('Next check');
  }
  const markCls = (x, e) => (e.type === 'step' ? `step ${kindCls(x)}` : e.type === 'answer' ? `answer ${e.answer === 'forgot' || e.answer === 'back' ? 'neg' : e.answer === 'stale' ? 'stale' : 'pos'}` : e.type);
  // Times it held (applied in a video, or "applied" / "still behind me" in Remember) and times it did not.
  const holds = (ev) => ({
    pos: ev.filter((e) => e.type === 'applied' || (e.type === 'answer' && (e.answer === 'applied' || e.answer === 'still'))).length,
    neg: ev.filter((e) => e.type === 'against' || (e.type === 'answer' && (e.answer === 'forgot' || e.answer === 'back'))).length,
  });
  const holdPills = (c) => `${c.pos ? `<span class="tl-count pos" title="${esc(tn(c.pos, 'held {n} time', 'held {n} times'))}">✓ ${c.pos}</span>` : ''}${c.neg ? `<span class="tl-count neg" title="${esc(tn(c.neg, 'did not hold {n} time', 'did not hold {n} times'))}">✕ ${c.neg}</span>` : ''}`;
  const playIcon = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  const markTip = (x, e) => esc(`${shortDay(e.date)} · ${eventLabel(x, e)}${e.type === 'step' ? ': ' + x.text : e.text ? ': ' + e.text : ''}`);

  // Ticks of a time axis: weeks for a short span, months otherwise (every 2, 3 or 6 months for a long one).
  function axisTicks(from, to) {
    const out = [];
    if (to - from < 50 * DAY) {
      const d = new Date(from); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
      for (; d.getTime() < to; d.setDate(d.getDate() + 7)) out.push({ at: d.getTime(), label: shortDay(d.getTime()) });
      return out;
    }
    const months = (to - from) / (30.5 * DAY);
    const every = months > 30 ? 6 : months > 15 ? 3 : months > 8 ? 2 : 1;
    const d = new Date(from); d.setHours(0, 0, 0, 0); d.setDate(1); d.setMonth(d.getMonth() + 1);
    while (d.getMonth() % every) d.setMonth(d.getMonth() + 1);
    for (let first = true; d.getTime() < to; d.setMonth(d.getMonth() + every), first = false) {
      const m = d.toLocaleDateString(loc(), { month: 'short' });
      out.push({ at: d.getTime(), label: first || d.getMonth() === 0 ? `${m} ${d.getFullYear()}` : m });
    }
    return out;
  }
  // The line of one step and its marks on an axis: dotted from where it started to the step, in its colour after
  // it (while it is followed: up to today for a realization or something left behind).
  function trackHtml(x, ev, from, to, pos, cls = '') {
    const past = ev.filter((e) => !e.future);
    const stepE = past.find((e) => e.type === 'step');
    const start = past[0].date, last = past[past.length - 1].date;
    const end = x.status !== 'active' ? x.archivedAt || last : x.kind === 'done' ? last : Date.now();
    const parts = [];
    if (start < stepE.date) parts.push(`<span class="tl-line before" style="left:${pos(start)}%;width:${Math.max(0, pos(stepE.date) - pos(start))}%"></span>`);
    if (end > stepE.date) parts.push(`<span class="tl-line after ${kindCls(x)}" style="left:${pos(stepE.date)}%;width:${Math.max(0, pos(end) - pos(stepE.date))}%"></span>`);
    if (start < from) parts.push('<span class="tl-clip">‹</span>');
    // The step is drawn last, above the others.
    for (const e of ev.filter((y) => y.date >= from && y.date <= to).sort((a, b) => (a.type === 'step') - (b.type === 'step') || a.date - b.date)) {
      parts.push(`<span class="tl-mark ${markCls(x, e)}" style="left:${pos(e.date)}%" title="${markTip(x, e)}"></span>`);
    }
    return `<div class="tl-track ${cls}">${parts.join('')}</div>`;
  }
  const LEGEND = () => `<div class="tl-legend">
      <span class="tl-leg"><span class="tl-mark start"></span>${t('It started')}</span>
      <span class="tl-leg"><span class="tl-mark mention"></span>${t('Came up')}</span>
      <span class="tl-leg"><span class="tl-mark step understood"></span>${t('Step forward')}</span>
      <span class="tl-leg"><span class="tl-mark applied"></span>${t('Held')}</span>
      <span class="tl-leg"><span class="tl-mark against"></span>${t('Did not hold')}</span>
      <span class="tl-leg"><span class="tl-mark answer pos"></span>${t('Your answer')}</span></div>`;
  // Several steps on one time axis, newest first: a row each, with what it is on the left and its line on the
  // right. A click on a row opens its timeline.
  function chart(items, range = 'all', withRanges = false) {
    const now = Date.now();
    const rows = items.map((x) => ({ x, ev: stepEvents(x) }));
    const dates = rows.flatMap((r) => r.ev.filter((e) => !e.future).map((e) => e.date));
    let from = range === 'all' ? Math.min(...dates) : now - +range * 30.5 * DAY;
    if (!Number.isFinite(from)) from = now - 30 * DAY;
    if (range === 'all') from -= Math.max(2 * DAY, (now - from) * 0.03);
    from = Math.min(from, now - 14 * DAY);
    const pos = (d) => Math.max(0, Math.min(100, ((d - from) / (now - from)) * 100));
    const endOf = ({ x, ev }) => { const past = ev.filter((e) => !e.future); return x.status === 'active' && x.kind !== 'done' ? now : past[past.length - 1].date; };
    const shown = rows.filter((r) => endOf(r) >= from);
    const ticks = axisTicks(from, now);
    const ranges = withRanges ? `<span class="tl-ranges">${[['all', t('Everything')], ['12', tn(12, '{n} month', '{n} months')], ['6', tn(6, '{n} month', '{n} months')], ['3', tn(3, '{n} month', '{n} months')]]
      .map(([k, l]) => `<button class="chip${k === range ? ' sel' : ''}" data-range="${k}">${esc(l)}</button>`).join('')}</span>` : '';
    return `<div class="tl-chart">
      <div class="tl-headrow">${LEGEND()}${ranges}</div>
      ${shown.length ? `<div class="tl-axisrow"><div></div><div class="tl-axis">${ticks.map((k) => `<span class="tl-tick" style="left:${pos(k.at)}%">${esc(k.label)}</span>`).join('')}<span class="tl-today">${t('Today')}</span></div></div>
      <div class="tl-rows"><div class="tl-grid">${ticks.map((k) => `<span style="left:${pos(k.at)}%"></span>`).join('')}</div>
        ${shown.map(({ x, ev }) => {
          const s = x.subject && sub(x.subject);
          const due = x.status === 'active' && x.kind !== 'done' && x.review && x.review.due <= now;
          return `<div class="tl-row${x.status !== 'active' ? ' aside' : ''}" data-tl="${x.id}" title="${esc(t('Open its timeline'))}">
            <div class="tl-label"><div class="tl-top"><span class="pg-kind ${kindCls(x)}">${esc(kindLabel(x))}</span>${due ? `<span class="status wait small">${t('to check')}</span>` : ''}</div>
              <div class="tl-text">${esc(x.text)}</div>
              <div class="tl-sum muted small"><span>${[s ? s.titre : x.subjectTitle, shortDay(x.date)].filter(Boolean).map(esc).join(' · ')}</span>${holdPills(holds(ev))}</div></div>
            ${trackHtml(x, ev, from, now, pos)}</div>`;
        }).join('')}</div>` : `<p class="muted">${t('Nothing in this period.')}</p>`}
    </div>`;
  }
  // Its own line, from where it started to its next check, with today marked.
  function singleStrip(x, ev) {
    const now = Date.now();
    const next = ev.find((e) => e.future);
    let to = Math.max(now, next ? next.date : 0), from = Math.min(ev[0].date, to - 14 * DAY);
    const pad = (to - from) * 0.04;
    from -= pad; to += pad;
    const pos = (d) => Math.max(0, Math.min(100, ((d - from) / (to - from)) * 100));
    const ticks = axisTicks(from, to);
    return `<div class="tl-single">
      <div class="tl-axis">${ticks.map((k) => `<span class="tl-tick" style="left:${pos(k.at)}%">${esc(k.label)}</span>`).join('')}</div>
      <div class="tl-strip"><div class="tl-grid">${ticks.map((k) => `<span style="left:${pos(k.at)}%"></span>`).join('')}<span class="tl-now" style="left:${pos(now)}%"><b>${t('Today')}</b></span></div>
        ${trackHtml(x, ev, from, to, pos, 'big')}</div>
    </div>`;
  }
  // Every event, oldest first, with the time between them.
  function timelineList(x, ev) {
    const out = [];
    ev.forEach((e, i) => {
      if (i) {
        const gap = Math.round((startOfDay(e.date) - startOfDay(ev[i - 1].date)) / DAY);
        if (gap >= 1) out.push(`<li class="tl-gapline"><div></div><div class="tl-node"></div><div class="tl-gaptxt">${esc(e.future ? tn(gap, 'in {n} day', 'in {n} days') : tn(gap, '{n} day later', '{n} days later'))}</div></li>`);
      }
      const ent = e.entry && entryById(e.entry);
      const link = ent ? `<span class="ref tl-play" data-id="${ent.id}" data-t="${hasT(e) ? e.t : ''}" title="${esc(t('Open the video at this moment'))}">${playIcon}${esc(title(ent))}${hasT(e) ? ' · ' + fmtT(e.t) : ''}</span>` : '';
      const body = e.type === 'step'
        ? `${x.situation ? `<div class="tl-sit">${esc(x.situation)}</div>` : ''}<div class="tl-steptext">${said(x.text, null, false)}</div>`
        : e.text ? `<div class="tl-txt">${said(e.text, null, false)}</div>` : '';
      out.push(`<li class="tl-ev ${e.type}${e.future ? ' future' : ''}">
        <div class="tl-when">${esc(longDay(e.date))}</div>
        <div class="tl-node"><span class="tl-mark ${markCls(x, e)}"></span></div>
        <div class="tl-body"><div class="tl-what ${markCls(x, e)}">${esc(eventLabel(x, e))}</div>${body}${link ? `<div class="tl-link">${link}</div>` : ''}</div></li>`);
    });
    return `<ol class="tl-list">${out.join('')}</ol>`;
  }
  // The name of the page a "back" link goes to.
  function backLabel(back) {
    const e = back.id && entryById(back.id), s0 = back.id && sub(back.id), x = back.id && itemById(back.id);
    return { prep: t('Before you talk'), sujets: t('All subjects'), progress: t('Progress'), lookback: t('Look back'), report: t('How far you’ve come'), you: t('You'), semaines: t('Weeks'), precisions: t('Permanent facts'),
      entry: e ? title(e) : t('Back'), sujet: s0 ? s0.titre : t('Back'), step: x ? x.text.slice(0, 50) : t('Progress'), month: back.key ? monthLabel(back.key) : t('Back'), search: t('Back') }[back.type] || t('Back');
  }
  // The page of one step forward: what it is, its line over time, then every event in order.
  function renderStep() {
    const x = itemById(view.id);
    const back = view.back && view.back.type !== 'step' ? view.back : { type: 'progress' };
    if (!x) { go(back); return; }
    const ev = stepEvents(x);
    const past = ev.filter((e) => !e.future);
    const s = x.subject && sub(x.subject);
    const stepE = past.find((e) => e.type === 'step'), first = past[0];
    const due = x.status === 'active' && x.kind !== 'done' && x.review && x.review.due <= Date.now();
    const facts = [
      first !== stepE ? `<span>${shortDay(first.date)} → ${shortDay(stepE.date)} · ${esc(tn(Math.max(0, Math.round((startOfDay(stepE.date) - startOfDay(first.date)) / DAY)), '{n} day', '{n} days'))}</span>` : `<span>${shortDay(stepE.date)}</span>`,
      holdPills(holds(ev)),
      due ? `<span class="status wait">${t('to check')}</span>` : '',
      x.status !== 'active' ? `<span>${t('Put aside')}</span>` : '',
    ].filter(Boolean).join('');
    main().innerHTML = `<div class="j-wrap step-page">
      <button class="link-btn back-link" id="btnStepBack">← ${esc(backLabel(back))}</button>
      ${pgEditing === x.id ? editItemForm(x) : `<div class="pg-item step-head ${kindCls(x)}${x.status !== 'active' ? ' aside' : ''}" data-item="${x.id}">
        <div class="pg-top"><span class="pg-kind ${kindCls(x)}">${esc(kindLabel(x))}</span>${s ? subChip(s) : x.subjectTitle ? `<span class="muted small">${esc(x.subjectTitle)}</span>` : ''}<div class="spacer"></div>
          <span class="pg-acts always">${thenNowBtn(x)}<button class="link-btn" data-pg="edit">${t('Edit')}</button>${x.status === 'active'
            ? `<button class="link-btn" data-pg="archive" title="${esc(t('Hidden from the list and from Remember. You can bring it back.'))}">${t('Put aside')}</button>`
            : `<button class="link-btn" data-pg="restore">${t('Bring back')}</button>`}${x.source !== 'subject' ? `<button class="link-btn danger-link" data-pg="delete">${t('Delete')}</button>` : ''}</span></div>
        ${x.situation ? `<div class="pg-sit">${esc(x.situation)}</div>` : ''}
        <div class="step-title">${said(x.text, null, false)}</div>
        <div class="step-facts">${facts}</div>
      </div>`}
      <div class="card"><h3>${t('Over time')}</h3>${singleStrip(x, ev)}</div>
      <div class="card"><h3>${t('From the start')}</h3>${timelineList(x, ev)}</div>
    </div>`;
    bind();
    $('btnStepBack').onclick = () => go(back);
  }

  // ---------- Look back ----------
  // What happened since the last look-back (steps forward, earlier realizations met again, subjects then and now),
  // and the questions to answer in a video. That video is analysed with the look-back in mind.
  function renderLookback() {
    const L = S.lookback;
    if (!L) { go({ type: 'progress' }); return; }
    const m = L.material;
    const items = m.items.map(itemById).filter(Boolean);
    const tested = m.tested.map(itemById).filter(Boolean);
    const busy = S.progressJob === 'lookback';
    const vids = m.entries.map(entryById).filter(Boolean);
    main().innerHTML = `<div class="j-wrap">
      <button class="link-btn back-link" data-go="progress">← ${t('Progress')}</button>
      <div class="j-head"><h1>${t('Look back')}</h1><span class="muted">${esc([t('since {date}', { date: longDay(L.from) }), nVideos(L.videos), tn(L.items, '{n} step forward', '{n} steps forward')].join(' · '))}</span></div>
      <p class="muted">${t('Once a month, or when you want: what happened since the last look-back, then a video where you answer the questions. Carnet links what you say to the moments it is about.')}</p>
      ${S.progressError ? `<p class="status err">${esc(S.progressError)}</p>` : ''}
      <div class="card lb-card">
        <div class="card-headrow"><h3>${t('Questions for your video')}</h3>${L.open && L.open.fromGemini ? `<span class="muted small">${t('prepared by Gemini')}</span>` : ''}</div>
        <ol class="lb-q">${L.questions.map((q) => `<li>${esc(q.text)}</li>`).join('')}</ol>
        <div class="card-foot">
          <button class="btn record-cta" id="btnLbRec"><span class="dot"></span>${t('Record your look-back')}</button>
          <button class="btn" id="btnLbAsk" ${canCall() && !anyJob() && S.entries.some(hasIdeas) ? '' : 'disabled'} title="${esc(t('Gemini writes questions from what happened in this time (1 call)'))}">${busy ? t('Preparing…') : L.open && L.open.fromGemini ? t('Other questions') : t('Prepare the questions with Gemini')}</button>
          ${L.due ? `<button class="link-btn" data-lb-later title="${esc(t('Asked again in a week'))}">${t('Not now')}</button>` : ''}
        </div>
        <p class="muted small">${t('During the recording, the questions are in the notes next to the camera.')}</p>
      </div>
      <div class="card"><h3>${esc(t('Steps forward since {date}', { date: shortDay(L.from) }))}</h3>${items.length ? items.slice().reverse().map(progressItem).join('') : `<p class="muted">${t('None in this time.')}</p>`}</div>
      ${tested.length ? `<div class="card"><h3>${t('Earlier realizations met again')}</h3>${tested.map(progressItem).join('')}</div>` : ''}
      ${m.subjects.length ? `<div class="card"><h3>${t('Subjects, then and now')}</h3>${m.subjects.map((s) => `<div class="lb-sub">
          <div><b class="sub-link" data-sub="${s.id}">${esc(s.titre)}</b>${s.etat === 'conclu' ? ` <span class="status work small">${t('concluded')}</span>` : ''}</div>
          <p><span class="rm-label">${t('Then')}</span>${s.then ? said(s.then, null, false) : `<span class="muted">${t('not started yet')}</span>`}</p>
          <p><span class="rm-label now">${t('Now')}</span>${s.now ? said(s.now, null, false) : `<span class="muted">${t('nothing written')}</span>`}</p></div>`).join('')}</div>` : ''}
      ${vids.length ? `<div class="card"><h3>${t('Videos of this time')}</h3><div class="week-vids">${vids.map((e) => `<span class="ref" data-id="${e.id}">${shortDay(e.date)} · ${esc(title(e))}</span>`).join('')}</div></div>` : ''}
      ${L.done.length ? `<div class="card"><h3>${t('Your look-backs')}</h3><ul class="lb-done">${L.done.map((l) => `<li>${esc(t('Since {date}', { date: shortDay(l.from) }))}${l.entry && entryById(l.entry) ? ' · ' + videoRef(l.entry) : ''}</li>`).join('')}</ul></div>` : ''}
    </div>`;
    bind();
    $('btnLbRec').onclick = async () => {
      if (!S.dir) { showToast(t('Choose the journal folder first.')); openSettings(); return; }
      if (!(await pAct({ action: 'lookback-open' }))) return;
      if (S.lookback && S.lookback.open) startEntry('lookback:' + S.lookback.open.id);
    };
    $('btnLbAsk').onclick = async () => {
      $('btnLbAsk').disabled = true;
      $('btnLbAsk').textContent = t('Preparing…');
      await pAct({ action: 'lookback-questions' });
    };
  }

  // ---------- How far you've come ----------
  // Over 3, 6 or 12 months: the numbers (no Gemini call), and Gemini's comparison of then and now (1 call).
  function renderReport() {
    const reps = prog().reports;
    const latest = reps[reps.length - 1];
    const months = view.months || (latest ? latest.months : 3);
    const r = view.rid ? reps.find((x) => x.id === view.rid) : [...reps].reverse().find((x) => x.months === months);
    const from = Date.now() - months * 30.5 * DAY;
    const inP = activeItems().filter((x) => x.date >= from);
    const nk = (k) => inP.filter((x) => kindCls(x) === k).length;
    const vids = S.entries.filter((e) => e.date >= from).length;
    const concluded = S.sujets.filter((s) => s.etat === 'conclu' && (s.majLe || 0) >= from).length;
    const busy = S.progressJob === 'report';
    const can = canCall() && !anyJob() && S.entries.some(hasIdeas);
    const refs = (ids) => (ids || []).filter((id) => entryById(id)).map((id) => `<span class="ref small" data-id="${id}">${shortDay(entryById(id).date)}</span>`).join(' ');
    const body = r ? `
      <p class="muted small">${esc(t('Written {when}, for {from} to {to}.', { when: ago(r.at), from: shortDay(r.from), to: shortDay(r.to) }))}</p>
      ${r.then_now ? `<div class="card rp-main"><h3>${t('Then and now')}</h3><p>${said(r.then_now, null)}</p></div>` : ''}
      ${r.changes.length ? `<div class="card"><h3>${t('What changed')}</h3>${r.changes.map((c) => `<div class="rp-change"><div class="rp-text">${said(c.text, null)}</div>
          ${c.then ? `<p><span class="rm-label">${t('Then')}</span>${said(c.then, null)}</p>` : ''}${c.now ? `<p><span class="rm-label now">${t('Now')}</span>${said(c.now, null)}</p>` : ''}
          ${c.videos.length ? `<div class="rp-refs">${refs(c.videos)}</div>` : ''}</div>`).join('')}</div>` : ''}
      ${r.learned.length ? `<div class="card"><h3>${t('What you learned')}</h3><ul>${r.learned.map((x) => `<li>${said(x, null)}</li>`).join('')}</ul></div>` : ''}
      ${r.still.length ? `<div class="card"><h3>${t('Still the same')}</h3><ul>${r.still.map((x) => `<li>${said(x.text, null)}${x.why ? `<div class="muted small">${said(x.why, null)}</div>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${r.patterns.length ? `<div class="card"><h3>${t('What keeps coming back')}</h3><ul>${r.patterns.map((x) => `<li>${said(x.text, null)} ${refs(x.videos)}</li>`).join('')}</ul></div>` : ''}`
      : `<p class="muted">${t('Gemini compares where you stood at the start of the period with where you stand now, from what you said: what changed, what you learned, what has not moved, what keeps coming back (1 call).')}</p>`;
    main().innerHTML = `<div class="j-wrap">
      <button class="link-btn back-link" data-go="progress">← ${t('Progress')}</button>
      <div class="j-head"><h1>${t('How far you’ve come')}</h1><div class="spacer"></div>
        <span class="pg-periods">${[3, 6, 12].map((m) => `<button class="chip${m === months ? ' sel' : ''}" data-months="${m}">${esc(tn(m, '{n} month', '{n} months'))}</button>`).join('')}</span>
        <button class="btn" id="btnReport" ${can ? '' : 'disabled'} title="${esc(t('Uses 1 Gemini call'))}">${busy ? t('Writing…') : r ? t('Write it again') : t('Write it')}</button></div>
      ${S.progressError ? `<p class="status err">${esc(S.progressError)}</p>` : ''}
      <div class="pg-stats">
        <div class="pg-stat"><b>${vids}</b><span>${esc(tn(vids, 'video', 'videos'))}</span></div>
        <div class="pg-stat done"><b>${nk('done')}</b><span>${t('done or settled')}</span></div>
        <div class="pg-stat understood"><b>${nk('understood')}</b><span>${t('understood')}</span></div>
        <div class="pg-stat moved"><b>${nk('moved')}</b><span>${t('moved past')}</span></div>
        <div class="pg-stat"><b>${concluded}</b><span>${esc(tn(concluded, 'subject concluded', 'subjects concluded'))}</span></div>
      </div>
      <p class="muted small pg-since-first">${esc(t('From {from} to today.', { from: longDay(from) }))}</p>
      ${body}
      ${reps.length > 1 ? `<div class="card"><h3>${t('Written before')}</h3><ul class="lb-done">${[...reps].reverse().map((x) => `<li><button class="link-btn${r && x.id === r.id ? ' sel' : ''}" data-rid="${x.id}">${esc(tn(x.months, 'The last {n} month', 'The last {n} months'))} · ${esc(t('written on {date}', { date: shortDay(x.at) }))}</button></li>`).join('')}</ul></div>` : ''}
    </div>`;
    bind();
    main().querySelectorAll('[data-months]').forEach((b) => (b.onclick = () => go({ type: 'report', months: +b.dataset.months })));
    main().querySelectorAll('[data-rid]').forEach((b) => (b.onclick = () => { const x = reps.find((y) => y.id === b.dataset.rid); go({ type: 'report', months: x ? x.months : months, rid: b.dataset.rid }); }));
    $('btnReport').onclick = async () => {
      $('btnReport').disabled = true;
      $('btnReport').textContent = t('Writing…');
      if (await pAct({ action: 'report', months })) go({ type: 'report', months });
    };
  }

  // ---------- Then and now ----------
  // The two moments of a step forward side by side: the one where it started and the one where it happened.
  function ideaAt(m) {
    const e = m && entryById(m.entry);
    if (!e || !e.analysis) return '';
    if (!hasT(m)) return '';
    let best = null;
    for (const i of e.analysis.idees || []) if (hasT(i) && (!best || Math.abs(i.t - m.t) < Math.abs(best.t - m.t))) best = i;
    return best && Math.abs(best.t - m.t) <= 45 ? best.texte : '';
  }
  let tnTimer = null;
  function openThenNow(id) {
    const x = itemById(id);
    if (!x || !bothMoments(x)) return;
    const side = (m, which) => {
      const e = entryById(m.entry);
      const v = $(which === 'then' ? 'tnThen' : 'tnNow');
      v.dataset.t = hasT(m) ? Math.max(0, m.t - 1) : 0;
      v.onloadedmetadata = () => { v.currentTime = +v.dataset.t; };
      v.src = e.url;
      $(which === 'then' ? 'tnThenLabel' : 'tnNowLabel').textContent = `${which === 'then' ? t('Then') : t('Now')} · ${longDay(e.date)}${hasT(m) ? ' · ' + fmtT(m.t) : ''}`;
      const said_ = ideaAt(m);
      $(which === 'then' ? 'tnThenCtx' : 'tnNowCtx').innerHTML = said_ ? said(said_, null, false) : `<span class="muted">${esc(title(e))}</span>`;
      $(which === 'then' ? 'tnThenOpen' : 'tnNowOpen').onclick = () => { closeThenNow(); go({ type: 'entry', id: e.id, t: hasT(m) ? m.t : null }); };
    };
    $('tnTitle').textContent = kindLabel(x);
    $('tnText').innerHTML = `${x.situation ? `<span class="muted">${esc(x.situation)}:</span> ` : ''}${esc(x.text)}`;
    side(x.then, 'then');
    side(x.now, 'now');
    $('tnThen').onplay = () => $('tnNow').pause();
    $('tnNow').onplay = () => { $('tnThen').pause(); };
    show('thenNowModal', true);
  }
  function closeThenNow() {
    clearInterval(tnTimer);
    for (const id of ['tnThen', 'tnNow']) { const v = $(id); v.pause(); v.removeAttribute('src'); v.load(); }
    show('thenNowModal', false);
  }
  // "One after the other": ten seconds of the first moment, then the second one.
  $('btnTnBoth').onclick = () => {
    const a = $('tnThen'), b = $('tnNow');
    clearInterval(tnTimer);
    b.pause();
    b.currentTime = +b.dataset.t || 0;
    a.currentTime = +a.dataset.t || 0;
    const stopAt = a.currentTime + 10;
    a.play().catch(() => {});
    tnTimer = setInterval(() => {
      if (a.ended || a.currentTime >= stopAt) { clearInterval(tnTimer); a.pause(); b.play().catch(() => {}); }
    }, 200);
  };
  $('btnTnClose').onclick = closeThenNow;
  $('btnTnClose2').onclick = closeThenNow;

  // ---------- Progress reel ----------
  function openReel() {
    const sel = $('reelPeriod');
    const count = () => {
      const m = +sel.value, from = m ? Date.now() - m * 30.5 * DAY : 0;
      const n = Math.min(10, activeItems().filter((x) => x.date >= from && x.now && entryById(x.now.entry) && entryById(x.now.entry).exists).length);
      $('reelCount').textContent = n ? tn(n, '{n} step forward with its moments.', '{n} steps forward with their moments.') : t('No step forward with a video moment in this period.');
      $('btnReelGo').disabled = !n;
    };
    sel.onchange = count;
    count();
    show('reelModal', true);
  }
  $('btnReelCancel').onclick = () => show('reelModal', false);
  $('btnReelGo').onclick = async () => {
    show('reelModal', false);
    $('exportBar').style.width = '0';
    $('exportMsg').textContent = '0 %';
    $('exportTitle').textContent = t('Making the progress reel');
    show('btnShowFile', false); show('btnExportClose', false); show('btnExportCancel', true);
    $('btnExportCancel').disabled = false;
    show('exportModal', true);
    try {
      const r = await window.api.progressReel({ months: +$('reelPeriod').value });
      show('btnExportCancel', false);
      $('exportBar').style.width = '100%';
      $('exportTitle').textContent = t('Progress reel ready');
      $('exportMsg').textContent = r.output + (r.skipped ? '\n' + tn(r.skipped, '{n} moment could not be read and was left out.', '{n} moments could not be read and were left out.') : '');
      show('btnShowFile', true); show('btnExportClose', true);
      $('btnShowFile').onclick = () => window.api.showInFolder(r.output);
    } catch (err) {
      show('btnExportCancel', false);
      if (String(err.message || err).includes('EXPORT_ANNULE')) { show('exportModal', false); showToast(t('Reel cancelled.')); return; }
      $('exportTitle').textContent = t('The reel could not be made');
      $('exportMsg').textContent = cleanErr(err).slice(0, 900);
      show('btnExportClose', true);
    }
  };
  window.api.onReelProgress((p) => {
    $('exportBar').style.width = (p * 100).toFixed(1) + '%';
    $('exportMsg').textContent = Math.round(p * 100) + ' %';
  });

  // ---------- Weeks ----------
  // One summary per calendar week (Monday to Sunday), compared with the week before.
  const weekStart = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const weekKey = (ts) => { const d = new Date(weekStart(ts)); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
  const weekFrom = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const weekTo = (k) => weekFrom(k) + 7 * DAY - 1;
  const weekLabel = (k) => t('Week of {from} to {to}', { from: shortDay(weekFrom(k)), to: shortDay(weekTo(k)) });
  function renderSemaines() {
    const W = S.semaines || {};
    const keys = [...new Set([...S.entries.map((e) => weekKey(e.date)), ...Object.keys(W)])].sort().reverse();
    const busy = S.jobs.semaine;
    const card = (k) => {
      const w = W[k];
      const vids = sorted().filter((e) => weekKey(e.date) === k).reverse();
      const analysed = vids.filter(hasIdeas);
      const cur = Date.now() <= weekTo(k);
      const newer = w ? analysed.filter((e) => !w.entries.includes(e.id) || (e.analysis.at && e.analysis.at > w.at)).length : 0;
      const err = S.weekError && S.weekError.key === k ? S.weekError.message : null;
      const wE = w ? w.entries.map(entryById).filter(Boolean) : [];
      const item = (it) => itemLine(it, wE);
      const tag = w ? (w.enCours ? `<span class="status wait">${t('provisional, week not over')}</span>` : '') + (newer ? ` <span class="status wait">${tn(newer, '{n} video since the summary', '{n} videos since the summary')}</span>` : '')
        : cur ? `<span class="muted small">${t('current week')}</span>` : analysed.length ? `<span class="status wait">${t('summary to make')}</span>` : `<span class="muted small">${t('videos not analysed yet')}</span>`;
      const can = canCall() && analysed.length && !anyJob();
      const btn = analysed.length ? `<button class="btn small-btn" data-week="${k}" ${can ? '' : 'disabled'} title="${esc(t('Uses 1 Gemini call'))}">${busy && busy.key === k ? t('Summary in progress…') : w ? t('Redo') : cur ? t('Make the provisional summary') : t('Make the summary')}</button>` : '';
      const body = w ? `
        <div class="to-say"><h4>${t('Compared with the week before')}</h4><p>${w.precedente ? said(w.evolution_semaine || t('No comparison.'), wE) : t('First week of the journal: no week before.')}</p></div>
        ${w.suivi.length ? `<h4>${t('What was planned for this week')}</h4><ul>${w.suivi.map((x) => `<li>${said(x, wE)}</li>`).join('')}</ul>` : ''}
        ${w.en_bref ? `<h4>${t('In short')}</h4><p>${said(w.en_bref, wE)}</p>` : ''}
        ${w.avance.length ? `<h4>${t('What moved forward')}</h4><ul>${w.avance.map(item).join('')}</ul>` : ''}
        ${w.en_suspens.length ? `<h4>${t('Left hanging')}</h4><ul>${w.en_suspens.map(item).join('')}</ul>` : ''}
        ${w.contradictions.length ? `<h4>${t('To clarify')}</h4><ul>${w.contradictions.map((x) => `<li>${said(x, wE)}</li>`).join('')}</ul>` : ''}
        ${w.a_dire.length ? `<h4>${t('For the following week')}</h4><ul>${w.a_dire.map((x) => `<li>${said(x, wE)}</li>`).join('')}</ul>` : ''}`
        : `<p class="muted">${cur ? t('The summary of the week is made automatically on Monday, once the week is over. You can make a provisional summary now.') : analysed.length ? (S.gemini.autoSemaine ? t('The summary will be made automatically as soon as a Gemini call is available.') : t('No summary for this week yet.')) : t('The summary will be possible once the videos have been analysed.')}</p>`;
      return `<div class="card week" id="w-${k}">
        <div class="card-headrow"><h3>${esc(weekLabel(k))}</h3><span class="muted small">${nVideos(vids.length)}</span>${tag}<div class="spacer"></div>${btn}</div>
        ${err ? `<p class="status err">${esc(err)}</p>` : ''}
        ${body}
        ${vids.length ? `<div class="week-vids">${vids.map((e) => `<span class="ref" data-id="${e.id}">${shortDay(e.date)} · ${esc(title(e))}</span>`).join('')}</div>` : ''}
      </div>`;
    };
    main().innerHTML = `<div class="j-wrap">
      <div class="j-head"><h1>${t('Weeks')}</h1><span class="muted">${t('one summary per week, Monday to Sunday, compared with the week before')}</span></div>
      ${keys.length ? keys.map(card).join('') : `<p class="muted">${t('No videos yet.')}</p>`}
    </div>`;
    bind();
    main().querySelectorAll('[data-week]').forEach((b) => (b.onclick = async () => {
      b.disabled = true; b.textContent = t('Summary in progress…');
      try { S = await window.api.journalSemaine(b.dataset.week); } catch (err) { showToast(cleanErr(err)); await update(); }
      render();
    }));
  }

  // ---------- Clarifications, permanent facts, checks ----------
  // A clarification corrects one video (its card and the subjects it fed, 1 call), then can become a permanent fact.
  // Permanent facts go with every new analysis and summary; they never change what is already written.
  let fixOffer = null; // { entry, text }: after a correction, "keep it as a permanent fact?"
  const fixSummary = (n) => {
    const parts = [n.fiche || n.idees ? t('the card') : null, n.sujets && tn(n.sujets, '{n} subject', '{n} subjects'), n.profile && tn(n.profile, '{n} fact about you', '{n} facts about you'),
      n.progress && tn(n.progress, '{n} step forward', '{n} steps forward'), n.fusions && tn(n.fusions, '{n} merge of subjects', '{n} merges of subjects')].filter(Boolean);
    return parts.length ? t('Video corrected: {list}.', { list: parts.join(', ') }) : t('Video read again: nothing to correct.');
  };
  async function clarify(e, texte) {
    busyMsg = t('Correcting this video');
    render();
    try {
      const r = await window.api.journalClarify({ entry: e.id, texte });
      S = r.state;
      if (r.pending) showToast(e.analysis ? t('Clarification kept on the video. Gemini is not available right now: click “Correct this video” later.') : t('Clarification kept: it is used when this video is analysed.'));
      else {
        showToast(fixSummary(r.summary || {}));
        const text = (r.summary && r.summary.fait) || texte;
        if (text && !(S.faits || []).some((f) => f.text.toLowerCase() === String(text).toLowerCase())) fixOffer = { entry: e.id, text };
      }
    } catch (err) { showToast(cleanErr(err)); await update(); }
    busyMsg = null;
    render.lastKey = null;
    render();
  }
  function precisionRow(p) {
    return `<li class="prec" data-prec="${p.id}">
      <div class="prec-text">${esc(p.texte)}</div>
      <div class="prec-meta muted small">${shortDay(p.at)} · ${p.appliquee ? t('applied to this video') : `<span class="status wait">${t('not applied yet')}</span>`}
        <button class="link-btn danger-link" data-prec-del="${p.id}">${t('Delete')}</button></div>
    </li>`;
  }
  function bindPrecisionForm(entry) {
    const add = $('btnPrecAdd');
    if (add) add.onclick = async () => {
      const texte = $('precText').value.trim();
      if (!texte) { $('precText').focus(); return; }
      if (entry) await clarify(entry, texte);
    };
    const retry = $('btnPrecApply');
    if (retry && entry) retry.onclick = () => clarify(entry, '');
    main().querySelectorAll('[data-prec-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm(t('Delete this clarification? What was already corrected with it stays corrected.'))) return;
      S = await window.api.journalPrecision({ action: 'delete', id: b.dataset.precDel });
      render.lastKey = null; render();
    }));
    const keep = $('btnFactKeep');
    if (keep) keep.onclick = async () => {
      const text = $('factOfferText').value.trim();
      if (text) S = await window.api.journalFact({ action: 'add', text, entry: fixOffer && fixOffer.entry, source: 'clarification' });
      fixOffer = null;
      showToast(t('Kept as a permanent fact: it goes with every next analysis.'));
      render.lastKey = null; render();
    };
    const no = $('btnFactNo');
    if (no) no.onclick = () => { fixOffer = null; render.lastKey = null; render(); };
  }
  // On the page of a video: the clarification form, what waits, and what was applied.
  function precisionsCard(e) {
    const mine = (S.precisions || []).filter((p) => p.entry === e.id);
    const waiting = mine.filter((p) => !p.appliquee).length;
    const offer = fixOffer && fixOffer.entry === e.id ? fixOffer : null;
    const busy = !!(S.jobs[e.id] && S.jobs[e.id].step === 'Correcting this video');
    return `<div class="card prec-card"><h3>${t('Clarification')}</h3>
      <p class="muted small">${e.analysis ? t('Something was misunderstood in this video? Write it here: Carnet corrects the card of this video and the subjects it fed (1 call). The rest of the journal stays as it is.') : t('Something might be misunderstood? Write it here: it is used when this video is analysed.')}</p>
      <div class="prec-form">
        <textarea id="precText" rows="2" placeholder="${esc(t('For example: Sam is my neighbour, not my brother.'))}"></textarea>
        <button class="btn primary small-btn" id="btnPrecAdd" ${busy || (e.analysis && !canCall()) ? 'disabled' : ''}>${busy ? t('Correcting…') : e.analysis ? t('Correct this video') : t('Add')}</button>
      </div>
      ${offer ? `<div class="fact-offer"><span>${t('Keep it as a permanent fact, for the next videos?')}</span>
        <input type="text" id="factOfferText" value="${esc(offer.text)}"><button class="btn primary small-btn" id="btnFactKeep">${t('Keep')}</button><button class="btn small-btn" id="btnFactNo">${t('No')}</button></div>` : ''}
      ${e.fixError ? `<p class="status err small">${esc(e.fixError)}</p>` : ''}
      ${waiting && e.analysis ? `<div class="prec-actions"><span class="status wait">${esc(tn(waiting, '{n} clarification not applied yet', '{n} clarifications not applied yet'))}</span> <button class="btn small-btn" id="btnPrecApply" ${canCall() && !busy ? '' : 'disabled'} title="${esc(t('Uses 1 Gemini call'))}">${t('Correct this video')}</button></div>` : ''}
      ${mine.length ? `<ul class="precs">${mine.map(precisionRow).join('')}</ul>` : ''}
      ${(S.faits || []).length ? `<p class="muted small">${esc(tn(S.faits.length, '{n} permanent fact goes with every new analysis.', '{n} permanent facts go with every new analysis.'))} <button class="link-btn" data-nav-prec>${t('See them')}</button></p>` : ''}
    </div>`;
  }
  // A check: what the journal says, what the video says, and the person's answer.
  function checkRow(c) {
    const e = entryById(c.entry), b = c.beforeEntry && entryById(c.beforeEntry);
    const where = (x) => (x ? t('video of {date} · {title}', { date: shortDay(x.date), title: title(x) }) : t('your journal'));
    return `<li class="check-item" data-check="${c.id}">
      <div class="ck-about"><b>${esc(c.about)}</b></div>
      <div class="ck-row"><span class="ck-tag">${t('Your journal')}</span><span>${esc(i18n.quote(c.before))}</span> <span class="muted small">${b ? `<span class="ref" data-id="${b.id}">${esc(where(b))}</span>` : ''}</span></div>
      <div class="ck-row"><span class="ck-tag new">${t('This video')}</span><span>${esc(i18n.quote(c.now))}</span> <span class="muted small">${e ? `<span class="ref" data-id="${e.id}">${esc(where(e))}</span>` : ''}</span></div>
      ${c.corrected ? `<div class="muted small">${t('One of these videos was corrected since: check that this still applies.')}</div>` : ''}
      <div class="ck-actions">
        <button class="btn small-btn" data-ck="before" title="${esc(t('The video is corrected (1 call)'))}">${esc(t('Keep {text}', { text: i18n.quote(c.before) }))}</button>
        <button class="btn small-btn" data-ck="now" title="${esc(t('The video the journal version came from is corrected (1 call)'))}">${esc(t('Take {text}', { text: i18n.quote(c.now) }))}</button>
        <button class="btn small-btn" data-ck="both">${t('Both are true')}</button>
        <label class="check small"><input type="checkbox" data-ck-keep checked> ${t('Keep the answer as a permanent fact')}</label>
      </div>
    </li>`;
  }
  function checksCard(list) {
    if (!list.length) return '';
    return `<div class="card checks-card"><h3>${t('To check')}</h3>
      <p class="muted small">${t('A video says something different from your journal, without saying it changed. Your journal kept its version until you decide.')}</p>
      <ul class="checks">${list.map(checkRow).join('')}</ul></div>`;
  }
  function bindChecks() {
    main().querySelectorAll('[data-check]').forEach((li) => li.querySelectorAll('[data-ck]').forEach((b) => (b.onclick = async () => {
      const keep = li.querySelector('[data-ck-keep]').checked;
      busyMsg = t('Correcting this video');
      render();
      try {
        const r = await window.api.journalCheck({ id: li.dataset.check, choice: b.dataset.ck, keep });
        S = r.state;
        if (r.pending) showToast(t('Answer saved. The video will be corrected from its page when Gemini is available.'));
        else if (r.summary) showToast(fixSummary(r.summary));
        else showToast(keep ? t('Answer saved, and kept as a permanent fact.') : t('Answer saved.'));
      } catch (err) { showToast(cleanErr(err)); await update(); }
      busyMsg = null;
      render.lastKey = null;
      render();
    })));
    main().querySelectorAll('.check-item .ref[data-id]').forEach((x) => (x.onclick = () => go({ type: 'entry', id: x.dataset.id })));
  }
  // Permanent facts: edit and delete.
  function factRow(f) {
    const e = f.entry && entryById(f.entry);
    const from = { clarification: t('from a clarification'), check: t('from a check'), earlier: t('from an earlier clarification') }[f.source] || t('written by you');
    return `<li class="prec" data-fact="${f.id}">
      <div class="prec-text">${esc(f.text)}</div>
      <div class="prec-meta muted small">${esc(from)}${e ? ` · <span class="ref" data-id="${e.id}">${esc(t('video of {date}', { date: shortDay(e.date) }))}</span>` : ''} · ${shortDay(f.at)}
        <button class="link-btn" data-fact-edit="${f.id}">${t('Edit')}</button><button class="link-btn danger-link" data-fact-del="${f.id}">${t('Delete')}</button></div>
    </li>`;
  }
  function bindFacts() {
    const add = $('btnFactAdd');
    if (add) add.onclick = async () => {
      const text = $('factText').value.trim();
      if (!text) { $('factText').focus(); return; }
      S = await window.api.journalFact({ action: 'add', text });
      render.lastKey = null; render();
      showToast(t('Kept as a permanent fact: it goes with every next analysis.'));
    };
    main().querySelectorAll('[data-fact-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm(t('Delete this permanent fact? The next analyses will no longer get it; what is already written does not change.'))) return;
      S = await window.api.journalFact({ action: 'delete', id: b.dataset.factDel });
      render.lastKey = null; render();
    }));
    main().querySelectorAll('[data-fact-edit]').forEach((b) => (b.onclick = () => {
      const f = (S.faits || []).find((x) => x.id === b.dataset.factEdit);
      const li = b.closest('[data-fact]');
      li.querySelector('.prec-text').innerHTML = `<textarea rows="2" class="prec-edit">${esc(f.text)}</textarea><button class="btn primary small-btn">${t('Save')}</button>`;
      const ta = li.querySelector('.prec-edit');
      ta.focus();
      li.querySelector('.prec-text .btn').onclick = async () => { S = await window.api.journalFact({ action: 'edit', id: f.id, text: ta.value }); render.lastKey = null; render(); };
    }));
    main().querySelectorAll('[data-fact] .ref[data-id]').forEach((x) => (x.onclick = () => go({ type: 'entry', id: x.dataset.id })));
  }
  function renderPrecisions() {
    const facts = [...(S.faits || [])].sort((a, b) => b.at - a.at);
    main().innerHTML = `<div class="j-wrap">
      <div class="j-head"><h1>${t('Permanent facts')}</h1><span class="muted">${t('what Carnet should always know')}</span></div>
      <p class="muted">${t('They go with the analysis of each new video and with the summaries, so the same mistake is not made again: who someone is, a name the transcript gets wrong, what a word means for you. They never change what is already written: to correct a video, add a clarification on its page.')}</p>
      ${checksCard(S.checks || [])}
      <div class="card"><h3>${t('Add a permanent fact')}</h3>
        <div class="prec-form"><textarea id="factText" rows="2" placeholder="${esc(t('For example: Sam is my neighbour. When I say “the club”, I mean my running club.'))}"></textarea>
        <button class="btn primary small-btn" id="btnFactAdd">${t('Add')}</button></div></div>
      <div class="card"><h3>${t('Your permanent facts')}</h3>${facts.length ? `<ul class="precs">${facts.map(factRow).join('')}</ul>` : `<p class="muted">${t('No permanent fact yet.')}</p>`}</div>
    </div>`;
    bind();
    bindFacts();
    bindChecks();
  }


  // ---------- All subjects ----------
  // ---------- All subjects: a timeline ----------
  // Each subject on one time axis: a line from the first video where it came up to the last one, dotted up to today
  // while it is still open; a dot per video (bigger when more was said about it), yellow when the video changed where
  // you stand, a square when it was concluded. Sorted and filtered as chosen; a click opens the subject.
  const SUBJECT_SORTS = [['videos', 'Most videos'], ['recent', 'Last discussed'], ['first', 'Oldest first'], ['new', 'Newest first'], ['long', 'Longest'], ['changes', 'Most changes'], ['title', 'A to Z']];
  let subjectsSort = 'videos';
  try { subjectsSort = localStorage.getItem('carnet.subjectsSort') || 'videos'; } catch (_) {}
  const samePos = (a, b) => norm(a || '').replace(/\s+/g, ' ').trim() === norm(b || '').replace(/\s+/g, ' ').trim();
  function subjectEvents(s) {
    const x = st(s);
    // The successive states of the subject (where you stood after each video), oldest first. States brought in by
    // a merge belong to the other subject's line.
    const states = [...(s.historique || []).filter((h) => !h.titre), { ...s, entry: s.majPar, date: s.majLe }];
    const byEntry = new Map(), extra = [];
    let prev = null;
    for (const h of states) {
      const info = {
        changed: !!prev && !samePos(prev.ou_j_en_suis, h.ou_j_en_suis),
        concluded: h.etat === 'conclu' && (!prev || prev.etat !== 'conclu'),
        reopened: !!prev && prev.etat === 'conclu' && h.etat !== 'conclu',
        text: h.evolution || (h.etat === 'conclu' ? h.conclusion : h.ou_j_en_suis) || '',
      };
      if (h.entry) byEntry.set(h.entry, info);
      else if ((info.concluded || info.reopened) && h.date) extra.push({ type: info.concluded ? 'concluded' : 'reopened', date: h.date, entry: null, n: 0, text: info.text, hand: true });
      prev = h;
    }
    const ideasBy = new Map();
    for (const i of x.ideas) { if (!ideasBy.has(i.entry)) ideasBy.set(i.entry, []); ideasBy.get(i.entry).push(i); }
    const ev = x.entries.map((e, k) => {
      const info = byEntry.get(e.id), ideas = ideasBy.get(e) || [];
      const type = info && info.concluded ? 'concluded' : info && info.reopened ? 'reopened' : k === 0 ? 'start' : info && info.changed ? 'change' : 'mention';
      return { type, date: e.date, entry: e.id, n: ideas.length, text: (info && info.text) || ideas.map((i) => i.texte).join(' · ') };
    });
    return [...ev, ...extra].sort((a, b) => a.date - b.date);
  }
  const S_LABEL = { start: 'First time', mention: 'Came up', change: 'Where you stand changed', concluded: 'Concluded', reopened: 'Reopened' };
  // A dot a bit bigger when more ideas of the subject were said in the video.
  const dotSize = (n) => (n >= 5 ? 13 : n >= 3 ? 11 : n >= 2 ? 9 : 7);
  function subjectTrack(s, ev, from, to, pos, cls = '') {
    const first = ev[0].date, last = ev[ev.length - 1].date, open = s.etat !== 'conclu';
    const parts = [];
    if (last > first) parts.push(`<span class="tl-sline ${open ? 'open' : 'done'}" style="left:${pos(first)}%;width:${Math.max(0, pos(last) - pos(first))}%"></span>`);
    if (open && to > last) parts.push(`<span class="tl-sidle" style="left:${pos(last)}%;width:${Math.max(0, pos(Math.min(to, Date.now())) - pos(last))}%" title="${esc(t('Open, not discussed since {date}', { date: shortDay(last) }))}"></span>`);
    if (first < from) parts.push('<span class="tl-clip">‹</span>');
    for (const e of ev.filter((y) => y.date >= from && y.date <= to)) {
      const ent = e.entry && entryById(e.entry);
      const tip = `${shortDay(e.date)}${ent ? ' · ' + title(ent) : ''} · ${t(S_LABEL[e.type])}${e.n > 1 ? ' · ' + tn(e.n, '{n} idea', '{n} ideas') : ''}${e.text ? ': ' + e.text : ''}`;
      const size = e.type === 'mention' || e.type === 'change' || e.type === 'start' ? dotSize(e.n) : 0;
      parts.push(`<span class="tl-mark s-${e.type}" style="left:${pos(e.date)}%${size ? `;width:${size}px;height:${size}px` : ''}" title="${esc(tip.slice(0, 400))}"${ent ? ` data-id="${ent.id}"` : ''}></span>`);
    }
    return `<div class="tl-track ${cls}">${parts.join('')}</div>`;
  }
  const S_LEGEND = () => `<div class="tl-legend">
      <span class="tl-leg"><span class="tl-mark s-start" style="width:9px;height:9px"></span>${t('First time')}</span>
      <span class="tl-leg"><span class="tl-mark s-mention" style="width:7px;height:7px"></span><span class="tl-mark s-mention" style="width:11px;height:11px"></span>${t('Came up (bigger: more said)')}</span>
      <span class="tl-leg"><span class="tl-mark s-change" style="width:9px;height:9px"></span>${t('Where you stand changed')}</span>
      <span class="tl-leg"><span class="tl-mark s-concluded"></span>${t('Concluded')}</span>
      <span class="tl-leg"><span class="tl-sidle legend"></span>${t('Open, not discussed since')}</span></div>`;
  function renderSujets() {
    const all = S.sujets;
    const open = all.filter((s) => s.etat !== 'conclu'), done = all.filter((s) => s.etat === 'conclu'), pinned = all.filter((s) => s.epingle);
    const state = view.state || 'all', cat = view.cat === undefined ? null : view.cat, range = view.range || 'all';
    const catName = (c) => c || t('other');
    const cats = [...all.reduce((m, s) => m.set(s.categorie || '', (m.get(s.categorie || '') || 0) + 1), new Map()).entries()].sort((a, b) => b[1] - a[1] || catName(a[0]).localeCompare(catName(b[0])));
    const list = all.filter((s) => (state === 'all' || (state === 'open' ? s.etat !== 'conclu' : state === 'done' ? s.etat === 'conclu' : s.epingle)) && (cat === null || (s.categorie || '') === cat));
    const rows = list.filter((s) => st(s).entries.length).map((s) => ({ s, x: st(s), ev: subjectEvents(s) }));
    const noVideo = list.filter((s) => !st(s).entries.length);
    const changes = (r) => r.ev.filter((e) => e.type === 'change' || e.type === 'concluded' || e.type === 'reopened').length;
    const cmp = {
      videos: (a, b) => b.x.entries.length - a.x.entries.length || b.x.last - a.x.last,
      recent: (a, b) => b.x.last - a.x.last,
      first: (a, b) => a.x.first - b.x.first,
      new: (a, b) => b.x.first - a.x.first,
      long: (a, b) => (b.x.last - b.x.first) - (a.x.last - a.x.first) || b.x.entries.length - a.x.entries.length,
      changes: (a, b) => changes(b) - changes(a) || b.x.entries.length - a.x.entries.length,
      title: (a, b) => a.s.titre.localeCompare(b.s.titre, loc()),
    }[subjectsSort] || ((a, b) => b.x.entries.length - a.x.entries.length);
    rows.sort(cmp);
    // The axis: everything, or the last 12, 6 or 3 months (an open subject is drawn up to today).
    const now = Date.now();
    let from = range === 'all' ? Math.min(...rows.map((r) => r.x.first)) : now - +range * 30.5 * DAY;
    if (!Number.isFinite(from)) from = now - 30 * DAY;
    if (range === 'all') from -= Math.max(2 * DAY, (now - from) * 0.03);
    from = Math.min(from, now - 14 * DAY);
    const pos = (d) => Math.max(0, Math.min(100, ((d - from) / (now - from)) * 100));
    const shown = rows.filter((r) => r.s.etat !== 'conclu' || r.x.last >= from);
    const ticks = axisTicks(from, now);
    const chip = (k, label) => `<button class="chip${state === k ? ' sel' : ''}" data-sstate="${k}">${esc(label)}</button>`;
    const ranges = [['all', t('Everything')], ['12', tn(12, '{n} month', '{n} months')], ['6', tn(6, '{n} month', '{n} months')], ['3', tn(3, '{n} month', '{n} months')]];
    main().innerHTML = `<div class="j-wrap subjects-page">
      <div class="j-head"><h1>${t('Subjects')}</h1><span class="muted">${esc(t('{open} open · {done} concluded', { open: open.length, done: done.length }))}</span><div class="spacer"></div>
        <button class="btn" id="btnRebuild" ${canCall() && S.entries.some((e) => e.analysis) && !S.jobs.rebuild ? '' : 'disabled'} title="${esc(t('Gemini reads all the cards again and redoes the list of subjects (1 call)'))}">${S.jobs.rebuild ? t('Reorganising…') : t('Reorganise the subjects')}</button></div>
      ${rebuildBanner()}
      ${all.length ? `<div class="pg-filters">${chip('all', tn(all.length, '{n} subject', '{n} subjects'))}${chip('open', tn(open.length, '{n} open subject', '{n} open subjects'))}${chip('done', tn(done.length, '{n} concluded subject', '{n} concluded subjects'))}${pinned.length ? chip('pinned', tn(pinned.length, '{n} pinned subject', '{n} pinned subjects')) : ''}
        <select id="subCat" title="${esc(t('Category'))}"><option value="__all">${t('All categories')}</option>${cats.map(([c, n]) => `<option value="${esc(c)}" ${cat === c ? 'selected' : ''}>${esc(catName(c))} (${n})</option>`).join('')}</select>
        <div class="spacer"></div><label class="sort-pick"><span class="muted small">${t('Sort by')}</span><select id="subSort">${SUBJECT_SORTS.map(([k, l]) => `<option value="${k}" ${k === subjectsSort ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}</select></label></div>
      <div class="tl-chart subjects-chart">
        <div class="tl-headrow">${S_LEGEND()}<span class="tl-ranges">${ranges.map(([k, l]) => `<button class="chip${k === range ? ' sel' : ''}" data-range="${k}">${esc(l)}</button>`).join('')}</span></div>
        ${shown.length ? `<div class="tl-axisrow"><div class="muted small">${esc(tn(shown.length, '{n} subject', '{n} subjects'))}</div><div class="tl-axis">${ticks.map((k) => `<span class="tl-tick" style="left:${pos(k.at)}%">${esc(k.label)}</span>`).join('')}<span class="tl-today">${t('Today')}</span></div></div>
        <div class="tl-rows"><div class="tl-grid">${ticks.map((k) => `<span style="left:${pos(k.at)}%"></span>`).join('')}</div>
          ${shown.map(({ s, x, ev }) => `<div class="tl-row srow${s.etat === 'conclu' ? ' done' : ''}" data-srow="${s.id}" title="${esc(t('Open the subject'))}">
            <div class="tl-label"><div class="tl-stitle">${s.epingle ? `<span class="pin" title="${esc(t('Pinned'))}">●</span>` : ''}${esc(s.titre)}</div>
              <div class="tl-sum muted small">${[s.categorie, nVideos(x.entries.length), s.etat === 'conclu' ? t('concluded') : t('last time {when}', { when: ago(x.last) })].filter(Boolean).map(esc).join(' · ')}</div></div>
            ${subjectTrack(s, ev, from, now, pos)}</div>`).join('')}</div>` : `<p class="muted">${t('Nothing in this period.')}</p>`}
      </div>
      ${noVideo.length ? `<p class="muted small">${esc(t('Without a video:'))} ${noVideo.map(subChip).join(' ')}</p>` : ''}` : `<p class="muted">${t('No subjects yet.')}</p>`}
    </div>`;
    bind();
    if ($('btnRebuild')) $('btnRebuild').onclick = rebuild;
    if ($('btnRebuildRetry')) $('btnRebuildRetry').onclick = rebuild;
    const again = () => { render.lastKey = null; render(); };
    main().querySelectorAll('[data-sstate]').forEach((b) => (b.onclick = () => { view.state = b.dataset.sstate; again(); }));
    main().querySelectorAll('[data-range]').forEach((b) => (b.onclick = () => { view.range = b.dataset.range; again(); }));
    if ($('subCat')) $('subCat').onchange = () => { view.cat = $('subCat').value === '__all' ? undefined : $('subCat').value; $('subCat').blur(); again(); };
    if ($('subSort')) $('subSort').onchange = () => {
      subjectsSort = $('subSort').value;
      try { localStorage.setItem('carnet.subjectsSort', subjectsSort); } catch (_) {}
      $('subSort').blur();
      again();
    };
    // A click on a dot opens its video; anywhere else on the line, the subject.
    main().querySelectorAll('.srow').forEach((r) => (r.onclick = (ev) => {
      const dot = ev.target.closest('.tl-mark[data-id]');
      if (dot) { go({ type: 'entry', id: dot.dataset.id, back: { ...view, back: undefined } }); return; }
      go({ type: 'sujet', id: r.dataset.srow, back: { ...view, back: undefined } });
    }));
  }
  async function rebuild() {
    if (!confirm(t('Reorganise all the subjects? Gemini reads the cards of all the videos again and redoes the list of subjects (1 call). Subjects you merged or renamed by hand may change.'))) return;
    try { S = await window.api.journalRebuild(); } catch (err) { showToast(cleanErr(err)); await update(); }
    render();
  }

  // ---------- A subject ----------
  function renderSujet() {
    const s = sub(view.id);
    if (!s) { go({ type: 'prep' }); return; }
    const x = st(s);
    const others = subjects((o) => o.id !== s.id);
    const steps = activeItems().filter((i) => i.subject === s.id).sort((a, b) => b.date - a.date);
    const back = view.back && view.back.type !== 'sujet' ? view.back : { type: 'prep' };
    const sev = subjectEvents(s);
    // Its line over time, like in All subjects.
    let overTime = '';
    if (sev.length) {
      const now = Date.now();
      let from = Math.min(sev[0].date, now - 14 * DAY);
      from -= (now - from) * 0.04;
      const pos = (d) => Math.max(0, Math.min(100, ((d - from) / (now - from)) * 100));
      const ticks = axisTicks(from, now);
      overTime = `<div class="card sub-overtime"><h3>${t('Over time')}</h3>${S_LEGEND()}
        <div class="tl-single"><div class="tl-axis">${ticks.map((k) => `<span class="tl-tick" style="left:${pos(k.at)}%">${esc(k.label)}</span>`).join('')}<span class="tl-today">${t('Today')}</span></div>
        <div class="tl-strip"><div class="tl-grid">${ticks.map((k) => `<span style="left:${pos(k.at)}%"></span>`).join('')}</div>${subjectTrack(s, sev, from, now, pos, 'big')}</div></div></div>`;
    }
    // The thread: video by video, what was said about this subject.
    const thread = x.entries.map((e) => `<div class="thread-entry"><div class="te-head"><span class="ref" data-id="${e.id}">${shortDay(e.date)} · ${esc(title(e))}</span></div><ul class="ideas">${x.ideas.filter((i) => i.entry === e).map((i) => `<li>${said(i.texte, [e])} ${momentRef(i, false)}</li>`).join('')}</ul></div>`).join('');
    main().innerHTML = `<div class="j-wrap">
      <button class="link-btn back-link" id="btnBack">← ${esc(backLabel(back))}</button>
      <div class="j-head" id="subHead"><h1>${esc(s.titre)}</h1><button class="link-btn" id="btnRename">${t('Rename')}</button></div>
      <p class="muted">${[s.categorie, s.etat === 'conclu' ? t('concluded') : t('open'), nVideos(x.entries.length), x.entries.length ? t('since {date}, last time {when}', { date: shortDay(x.first), when: ago(x.last) }) : null].filter(Boolean).map(esc).join(' · ')}</p>
      <div class="entry-actions">
        <button class="btn record-cta" data-talk="${s.id}"><span class="dot"></span>${t('Talk about it now')}</button>
        <button class="btn" id="btnPin">${s.epingle ? t('Unpin') : t('Pin')}</button>
        ${s.etat === 'conclu' ? `<button class="btn" id="btnReopen">${t('Reopen')}</button>` : `<button class="btn" id="btnConclude">${t('Mark as concluded')}</button>`}
        <select id="selMerge" title="${esc(t('If this subject duplicates another one'))}"><option value="">${t('Merge with…')}</option>${others.map((o) => `<option value="${o.id}">${esc(o.titre)}</option>`).join('')}</select>
        <button class="btn danger" id="btnDelSub">${t('Delete the subject')}</button>
      </div>
      <div class="card hidden" id="concludeBox"><h3>${t('Your conclusion')}</h3><textarea id="concludeText" rows="3" placeholder="${esc(t('What you decided or concluded'))}"></textarea>
        <div class="card-foot"><button class="btn primary" id="btnConcludeOk">${t('Save')}</button><button class="btn" id="btnConcludeCancel">${t('Cancel')}</button></div></div>
      ${s.etat === 'conclu' ? `<div class="card conclusion"><h3>${t('Conclusion')}</h3><p>${said(s.conclusion || t('Concluded, no details.'), x.entries)}</p></div>` : ''}
      <div class="card">
        <h3>${t('Where you’re at')}</h3>${s.ou_j_en_suis ? `<p>${said(s.ou_j_en_suis, x.entries)}</p>` : `<p class="muted">${t('Nothing written yet.')}</p>`}
        ${s.etat !== 'conclu' && s.a_trancher.length ? `<h3>${t('To decide')}</h3><ul>${s.a_trancher.map((q) => `<li>${said(q, x.entries)}</li>`).join('')}</ul>` : ''}
        ${s.etat !== 'conclu' && s.pistes.length ? `<h3>${t('Leads for next time')}</h3><ul>${s.pistes.map((q) => `<li>${said(q, x.entries)}</li>`).join('')}</ul>` : ''}
      </div>
      ${overTime}
      ${steps.length ? `<div class="card sub-steps"><h3>${t('Steps forward on this subject')}</h3>${chart(steps)}</div>` : ''}
      ${historyCard(s, x)}
      <div class="card"><h3>${t('The thread')}</h3>${thread || `<p class="muted">${t('No idea linked to it.')}</p>`}</div>
    </div>`;
    bind();
    const act = async (action, patch) => { S = await window.api.journalSujet(s.id, action, patch); render(); };
    $('btnBack').onclick = () => go(back);
    // A dot of its line opens that video.
    main().querySelectorAll('.sub-overtime .tl-mark[data-id]').forEach((m) => (m.onclick = () => go({ type: 'entry', id: m.dataset.id, back: { ...view, back: undefined } })));
    $('btnPin').onclick = () => act('pin');
    if ($('btnReopen')) $('btnReopen').onclick = () => act('reopen');
    if ($('btnConclude')) $('btnConclude').onclick = () => { show('concludeBox', true); $('concludeText').value = s.ou_j_en_suis || ''; $('concludeText').focus(); };
    $('btnConcludeCancel').onclick = () => show('concludeBox', false);
    $('btnConcludeOk').onclick = () => act('conclude', { conclusion: $('concludeText').value });
    $('selMerge').onchange = () => {
      const into = sub($('selMerge').value);
      if (!into) return;
      if (!confirm(t('Merge “{from}” into “{into}”? All its ideas move to “{into}”.', { from: s.titre, into: into.titre }))) { $('selMerge').value = ''; return; }
      window.api.journalSujet(s.id, 'merge', { into: into.id }).then((n) => { S = n; go({ type: 'sujet', id: into.id }); });
    };
    $('btnDelSub').onclick = () => {
      if (!confirm(t('Delete the subject “{title}”? Its ideas stay in the cards of the videos, without a subject.', { title: s.titre }))) return;
      window.api.journalSujet(s.id, 'delete').then((n) => { S = n; go({ type: 'prep' }); });
    };
    $('btnRename').onclick = () => {
      $('subHead').innerHTML = `<input type="text" id="renameInput" class="rename-input" value="${esc(s.titre)}" spellcheck="false"><button class="btn primary" id="btnRenameOk">OK</button>`;
      const inp = $('renameInput');
      inp.focus(); inp.select();
      const ok = () => act('rename', { titre: inp.value });
      $('btnRenameOk').onclick = ok;
      inp.onkeydown = (ev) => { if (ev.key === 'Enter') ok(); if (ev.key === 'Escape') render(); };
    };
  }

  // How your position changed: each version of "where you're at", from the most recent to the oldest.
  function historyCard(s, x) {
    const hist = (s.historique || []).filter((h) => h.ou_j_en_suis || h.etat === 'conclu');
    if (!hist.length) return '';
    const from = (h) => {
      const e = h.entry && entryById(h.entry);
      if (h.source === 'toi') return esc(t('edited by hand on {date}', { date: shortDay(h.date) }));
      if (h.source === 'reorganisation') return esc(t('reorganisation of the subjects'));
      if (h.source === 'precision') return esc(t('corrected with your clarifications'));
      return e ? t('after the video {video}', { video: `<span class="ref" data-id="${e.id}">${shortDay(e.date)} · ${esc(title(e))}</span>` }) : h.date ? esc(t('on {date}', { date: shortDay(h.date) })) : '';
    };
    const row = (h, now) => `<li class="${now ? 'now' : ''}">
      <div class="hv-when">${now ? `<b>${t('Now')}</b> · ` : ''}${from(h)}${h.titre ? ` · <span class="muted">${esc(t('subject “{title}”, merged here', { title: h.titre }))}</span>` : ''}</div>
      ${h.evolution ? `<p class="hv-change">${said(h.evolution, x.entries)}</p>` : ''}
      ${h.etat === 'conclu' ? `<p><span class="status work">${t('Concluded')}</span> ${said(h.conclusion || t('no details'), x.entries)}</p>` : `<p class="hv-pos"><span class="muted small">${now ? t('Where you’re at:') : t('Where you were:')}</span> ${said(h.ou_j_en_suis, x.entries)}</p>`}
      ${!now && h.etat !== 'conclu' && (h.a_trancher || []).length ? `<p class="muted small">${esc(t('To decide then: {list}', { list: h.a_trancher.join(' ; ') }))}</p>` : ''}
    </li>`;
    const current = { ...s, entry: s.majPar, date: s.majLe, source: s.majSource || 'video', titre: null };
    return `<div class="card"><h3>${t('How it changed, video by video')}</h3><ul class="history">${row(current, true)}${[...hist].reverse().map((h) => row(h, false)).join('')}</ul></div>`;
  }

  // ---------- Videos of a month ----------
  function renderMonth() {
    const ms = months();
    const k = view.key && ms.includes(view.key) ? view.key : ms[0];
    if (!k) { go({ type: 'prep' }); return; }
    const list = sorted().filter((e) => monthKey(e.date) === k);
    main().innerHTML = `<div class="j-wrap">
      <div class="j-head"><h1>${monthLabel(k)}</h1><span class="muted">${nVideos(list.length)} · ${fmtT(list.reduce((sum, e) => sum + (e.duration || 0), 0))}</span></div>
      ${list.map((e) => entryCard(e)).join('')}</div>`;
    bind();
  }

  // ---------- Search ----------
  // Title, summary, ideas, subjects, people, transcript. Accents are ignored.
  function haystack(e) {
    const a = e.analysis || {};
    return [title(e), a.resume, (a.idees || []).map((i) => i.texte).join(' '), subjectsOf(e).map((s) => s.titre).join(' '), (a.personnes || []).join(' '), a.citation,
      e.transcript ? e.transcript.segments.map((s) => s.text).join(' ') : ''].join(' \n ');
  }
  function highlight(text, q) {
    const h = esc(text);
    if (!q) return h;
    const n = norm(h), nq = norm(esc(q));
    const out = [];
    let i = 0, j;
    while (nq && (j = n.indexOf(nq, i)) !== -1) { out.push(h.slice(i, j), '<mark>', h.slice(j, j + nq.length), '</mark>'); i = j + nq.length; }
    out.push(h.slice(i));
    return out.join('');
  }
  function searchSnippet(e, q) {
    if (!e.transcript) return '';
    const seg = e.transcript.segments.find((s) => norm(s.text).includes(norm(q)));
    return seg ? `<span class="ts">${fmtT(seg.from)}</span> ${i18n.info().quotes[0]}${highlight(seg.text, q)}${i18n.info().quotes[1]}` : '';
  }
  function renderSearch() {
    const q = view.q;
    const list = sorted().filter((e) => norm(haystack(e)).includes(norm(q)));
    const subs = subjects((s) => norm([s.titre, s.categorie, s.ou_j_en_suis, s.conclusion, ...s.a_trancher].join(' ')).includes(norm(q)));
    main().innerHTML = `<div class="j-wrap"><div class="j-head"><h1>${esc(i18n.quote(q))}</h1><span class="muted">${tn(subs.length, '{n} subject', '{n} subjects')} · ${nVideos(list.length)}</span></div>
      ${subs.length ? `<div class="card"><h3>${t('Subjects')}</h3><div class="chips">${subs.map(subChip).join('')}</div></div>` : ''}
      ${list.length ? list.map((e) => entryCard(e, q)).join('') : `<p class="muted">${t('No video contains this word.')}</p>`}</div>`;
    bind();
  }

  // ---------- Card of a video ----------
  function renderEntry() {
    const e = entryById(view.id);
    if (!e) { go({ type: 'prep' }); return; }
    const a = e.analysis;
    const s = status(e);
    const ts = (x) => (x === null || x === undefined ? '' : `<span class="ts" data-t="${x}">${fmtT(x)}</span>`);
    const list = (arr) => `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    const secs = e.transcript ? sectionsOf(e) : [];
    const want = e.intention && sub(e.intention);
    // Back to the page it was opened from (All subjects), or to its month.
    const back = view.back && view.back.type !== 'entry' ? view.back : { type: 'month', key: monthKey(e.date) };
    const lbId = typeof e.intention === 'string' && e.intention.startsWith('lookback:') ? e.intention.slice(9) : null;
    const lb = lbId && prog().lookbacks.find((l) => l.id === lbId);
    // Steps forward said in this video, and earlier ones it met.
    const mine = prog().items.filter((i) => i.status === 'active' && i.now && i.now.entry === e.id);
    const met = prog().items.filter((i) => i.status === 'active' && (i.track || []).some((k) => k.entry === e.id));
    const progressCard = mine.length || met.length ? `<div class="card"><h3>${t('Progress in this video')}</h3>
      ${mine.map((i) => `<div class="ep-row"><span class="pg-kind ${kindCls(i)}">${esc(kindLabel(i))}</span><span class="ep-text">${i.situation ? `<span class="muted">${esc(i.situation)}:</span> ` : ''}<span class="sub-link" data-tl="${i.id}" title="${esc(t('Open its timeline'))}">${esc(i.text)}</span>${ts(i.now.t)}</span>${thenNowBtn(i)}</div>`).join('')}
      ${met.map((i) => { const k = i.track.find((y) => y.entry === e.id); return `<div class="ep-row"><span class="pg-ev ${k.effect}">${esc(effectText(i, k.effect))}</span><span class="ep-text"><span class="sub-link" data-tl="${i.id}" title="${esc(t('Open its timeline'))}">${esc(i.text)}</span> <span class="muted small">(${shortDay(i.date)})</span>${ts(k.t)}${k.note ? `<span class="ep-note">${esc(k.note)}</span>` : ''}</span>${thenNowBtn(i)}</div>`; }).join('')}
    </div>` : '';
    // Ideas grouped by subject, in the order the subjects come up in the video.
    const ideaGroups = [];
    for (const i of (a && a.idees) || []) {
      const key = i.sujet && sub(i.sujet) ? i.sujet : '';
      let g = ideaGroups.find((x) => x.key === key);
      if (!g) { g = { key, list: [] }; ideaGroups.push(g); }
      g.list.push(i);
    }
    main().innerHTML = `<div class="j-wrap">
      <button class="link-btn back-link" id="btnBackMonth">← ${esc(backLabel(back))}</button>
      <div class="j-head"><h1>${esc(title(e))}</h1></div>
      <p class="muted">${fullDay(e.date)} · ${clock(e.date)} · ${fmtT(e.duration)}${a && a.humeur ? ' · ' + esc(a.humeur) : ''}${want ? ' · ' + t('meant to talk about {subject}', { subject: `<span class="sub-link" data-sub="${want.id}">${esc(want.titre)}</span>` }) : ''}${lb ? ` · <span class="sub-link" data-go="lookback">${esc(t('look-back since {date}', { date: shortDay(lb.from) }))}</span>` : ''}${s ? ` · <span class="status ${s.cls}">${s.text}</span>` : ''}</p>
      ${e.exists ? `<video class="entry-video" id="entryVideo" src="${e.url}" controls preload="metadata"></video>` : ''}
      <div class="entry-actions">
        <button class="btn" data-act="edit">${t('Open in the editor')}</button>
        <button class="btn" data-act="show">${t('Show the file')}</button>
        ${e.transcript || e.analysisError ? `<button class="btn" data-act="reanalyse" ${canCall() ? '' : 'disabled'} title="${esc(t('Uses 1 Gemini call'))}">${t('Analyse again')}</button>` : ''}
        <button class="btn" data-act="retranscribe">${t('Transcribe again')}</button>
        <button class="btn danger" data-act="remove">${t('Remove from the journal')}</button>
      </div>
      ${e.transcriptError ? `<div class="card"><h3>${t('Transcription')}</h3><p class="status err">${esc(e.transcriptError)}</p></div>` : ''}
      ${e.analysisError ? `<div class="card"><h3>${t('Analysis')}</h3><p class="status err">${esc(e.analysisError)}</p></div>` : ''}
      ${precisionsCard(e)}
      ${checksCard((S.checks || []).filter((c) => c.entry === e.id || c.beforeEntry === e.id))}
      ${lb ? `<div class="card"><h3>${t('Look-back: the questions')}</h3><ol class="lb-q">${lb.questions.map((q) => `<li>${esc(q.text)}</li>`).join('')}</ol></div>` : ''}
      ${a ? `<div class="card"><h3>${t('Video summary')}</h3>${a.resume ? `<p>${said(a.resume, [e])}</p>` : `<p class="muted">${t('No speech in this video.')}</p>`}
        ${a.citation ? `<blockquote class="quote">${esc(i18n.quote(a.citation))}</blockquote>` : ''}${contextLine(e)}</div>
      ${progressCard}
      ${(a.evolutions || []).filter((x) => sub(x.sujet)).length ? `<div class="card"><h3>${t('Compared with before')}</h3>${a.evolutions.filter((x) => sub(x.sujet)).map((x) => `<div class="cat-group"><div class="cat-head">${subChip(sub(x.sujet))}</div><p>${said(x.texte, [e])}</p></div>`).join('')}</div>` : ''}
      ${ideaGroups.length ? `<div class="card"><h3>${t('Ideas, by subject')}</h3>${ideaGroups.map((g) => `<div class="cat-group"><div class="cat-head">${g.key ? subChip(sub(g.key)) : `<span class="muted small">${t('No subject')}</span>`}</div><ul class="ideas">${g.list.map((i) => `<li>${said(i.texte, [e])}${ts(i.t)}</li>`).join('')}</ul></div>`).join('')}</div>` : ''}
      ${(a.a_faire || []).length || (a.questions || []).length || (a.personnes || []).length ? `<div class="card">
        ${(a.a_faire || []).length ? `<h3>${t('To do')}</h3>${list(a.a_faire)}` : ''}
        ${(a.questions || []).length ? `<h3>${t('Questions')}</h3>${list(a.questions)}` : ''}
        ${(a.personnes || []).length ? `<h3>${t('People')}</h3><p>${a.personnes.map(esc).join(', ')}</p>` : ''}</div>` : ''}` : ''}
      ${e.transcript ? `<div class="card"><h3>${t('Transcript')}</h3>${secs.length ? secs.map((x) => `<div class="tr-sec">${x.title ? `<b>${esc(x.title)}</b><br>` : ''}${ts(x.t)}${esc(x.text)}</div>`).join('') : `<p class="muted">${t('No speech detected.')}</p>`}</div>` : ''}
    </div>`;
    $('btnBackMonth').onclick = () => go(back);
    main().querySelectorAll('.ts[data-t]').forEach((x) => (x.onclick = () => { const v = $('entryVideo'); if (v) { v.currentTime = +x.dataset.t; v.play(); } }));
    main().querySelectorAll('.said-word[data-id]').forEach((w) => (w.onclick = () => {
      const v = $('entryVideo');
      if (w.dataset.id === e.id && v) { v.currentTime = +w.dataset.t; v.play(); } else go({ type: 'entry', id: w.dataset.id, t: +w.dataset.t });
    }));
    main().querySelectorAll('[data-sub]').forEach((x) => (x.onclick = () => go({ type: 'sujet', id: x.dataset.sub })));
    main().querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => entryAction(e, b.dataset.act)));
    bindPrecisionForm(e);
    bindPrecisionButtons();
    bindChecks();
    main().querySelectorAll('.ctx-line .ref[data-id]').forEach((x) => (x.onclick = () => go({ type: 'entry', id: x.dataset.id })));
    bindProgress();
    // Opened from a link to a moment: the video starts there.
    if (view.t !== null && view.t !== undefined && $('entryVideo')) {
      const v = $('entryVideo'), at = view.t;
      view.t = null;
      const start = () => { v.currentTime = at; v.play().catch(() => {}); };
      if (v.readyState >= 1) start(); else v.addEventListener('loadedmetadata', start, { once: true });
      v.scrollIntoView({ block: 'start' });
    }
  }

  // What the analysis of a video had of the journal: everything, the most recent, or search memory.
  function contextLine(e) {
    const c = e.analysis && e.analysis.context;
    if (!c) return '';
    if (c.mode === 'all') return `<p class="muted small ctx-line">${t('Analysed with all your journal: every subject, what Carnet knows about you and your steps forward.')}</p>`;
    if (c.mode === 'recent') return `<p class="muted small ctx-line">${esc(t('Analysed with your {n} most recently discussed subjects out of {total}: search memory was not ready yet.', { n: c.shown, total: c.total }))}</p>`;
    const found = (c.found || []).map(sub).filter(Boolean);
    const vids = (c.videos || []).map(entryById).filter(Boolean);
    const rest = Math.max(0, (c.total || 0) - (c.full || []).length);
    const parts = [tn(c.recent || 0, '{n} recent subject', '{n} recent subjects'), tn(found.length, '{n} older subject found by search', '{n} older subjects found by search'),
      rest ? tn(rest, 'the title of {n} other subject', 'the titles of {n} other subjects') : null, vids.length ? tn(vids.length, '{n} older video', '{n} older videos') : null].filter(Boolean);
    return `<details class="ctx-line muted small"><summary>${esc(t('Analysed with search memory: {list}.', { list: parts.join(', ') }))}</summary>
      ${found.length ? `<div>${t('Older subjects found:')} ${found.map((x) => `<span class="sub-link" data-sub="${x.id}">${esc(x.titre)}</span>`).join(', ')}</div>` : ''}
      ${vids.length ? `<div>${t('Older videos found:')} ${vids.map((v) => `<span class="ref" data-id="${v.id}">${esc(shortDay(v.date) + ' · ' + title(v))}</span>`).join(', ')}</div>` : ''}</details>`;
  }

  function sectionsOf(e) {
    const segs = e.transcript.segments;
    const ch = [...(e.chapters || [])].sort((a, b) => a.t - b.t);
    if (ch.length) return ch.map((c, i) => ({ t: c.t, title: c.title, text: segs.filter((s) => s.from >= c.t - 0.5 && s.from < (ch[i + 1] ? ch[i + 1].t : Infinity) - 0.5).map((s) => s.text).join(' ') }));
    const out = [];
    let cur = null;
    for (const s of segs) {
      if (!cur || s.from - cur.last > 2 || s.from - cur.t > 60) { cur = { t: s.from, parts: [], last: s.to }; out.push(cur); }
      cur.parts.push(s.text); cur.last = s.to;
    }
    return out.map((c) => ({ t: c.t, title: null, text: c.parts.join(' ') }));
  }

  async function entryAction(e, act) {
    const file = e.path;
    if (act === 'edit') { openFile(file); return; }
    if (act === 'show') { window.api.showInFolder(file); return; }
    if (act === 'remove' && !confirm(t('Remove this video from the journal? The file stays in the folder.'))) return;
    if (act === 'retranscribe' && !confirm(S.transcriber === 'gemini' ? (S.memory && S.memory.over && S.memory.items ? t('Redo the transcript and the card with Gemini? (2 calls: with search memory, the transcript comes first)') : t('Redo the transcript and the card with Gemini? (1 call)')) : t('Redo the transcript? The analysis will be redone too (1 Gemini call).'))) return;
    S = await window.api.journalEntry(e.id, act);
    if (act === 'remove') view = { type: 'month', key: monthKey(e.date) };
    render();
  }

  function render() {
    if (!S) return;
    // Nothing is rebuilt behind the recording window: the computer keeps its strength for the video.
    if (!$('modal').classList.contains('hidden')) { render.deferred = true; return; }
    renderSide();
    // Do not rebuild the card while its video plays (it would start over), nor a page while something is
    // being typed in it (renaming a subject, a conclusion, a new item…).
    const v = $('entryVideo');
    if (view.type === 'entry' && v && !v.paused && render.lastKey === 'entry' + view.id) return;
    if (render.lastKey === view.type + (view.id || '') && (document.activeElement && document.activeElement.closest('#jMain') && document.activeElement.matches('input, textarea, select'))) return;
    render.lastKey = view.type + (view.id || '');
    if (view.type === 'prep') renderPrep();
    else if (view.type === 'you') renderYou();
    else if (view.type === 'progress') renderProgress();
    else if (view.type === 'lookback') renderLookback();
    else if (view.type === 'report') renderReport();
    else if (view.type === 'step') renderStep();
    else if (view.type === 'sujets') renderSujets();
    else if (view.type === 'semaines') renderSemaines();
    else if (view.type === 'precisions') renderPrecisions();
    else if (view.type === 'sujet') renderSujet();
    else if (view.type === 'month') renderMonth();
    else if (view.type === 'search') renderSearch();
    else renderEntry();
    // A problem reading or writing the journal: shown at the top of every page.
    const alertHtml = S.broken ? `<div class="card alert-card"><b>${t('The journal cannot be read.')}</b> ${esc(S.broken)} ${t('The backups are in the “Backups” folder of the journal.')} <button class="btn small-btn" data-open-dir>${t('Open the journal folder')}</button></div>`
      : S.saveError ? `<div class="card alert-card"><b>${t('The journal could not be saved.')}</b> ${esc(S.saveError)}</div>`
        : S.restoredFrom ? `<div class="card notice">${t('journal.json was damaged: Carnet took it back from the backup {file}. Changes made after that backup may be missing. The damaged file is kept next to it.', { file: `<b>${esc(S.restoredFrom)}</b>` })}</div>` : '';
    const wrap = main().querySelector('.j-wrap');
    if (alertHtml && wrap) {
      wrap.insertAdjacentHTML('afterbegin', alertHtml);
      const b = wrap.querySelector('[data-open-dir]');
      if (b) b.onclick = () => window.api.journalOpen('folder');
    }
  }
  new MutationObserver(() => {
    if (render.deferred && $('modal').classList.contains('hidden')) { render.deferred = false; render.lastKey = null; render(); }
  }).observe($('modal'), { attributes: true, attributeFilter: ['class'] });
  function go(v) { if (v.type !== 'progress') pgDraft = null; pgEditing = null; view = v; if (v.type !== 'search') $('jSearch').value = ''; render.lastKey = null; render(); main().scrollTop = 0; }

  async function update() { S = await window.api.journalState(); render(); }
  const cleanErr = (err) => String(err && err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // ---------- Actions ----------
  // New entry, possibly on a chosen subject: its notes show up during the recording.
  let pendingSubject = null;
  function startEntry(subjectId) {
    if (!S.dir) { showToast(t('Choose the journal folder first.')); openSettings(); return; }
    pendingSubject = typeof subjectId === 'string' && subjectId ? subjectId : null;
    newVideo();
  }
  $('btnJNew').onclick = () => startEntry(null);
  $('btnJImport').onclick = async () => {
    if (!S.dir) { openSettings(); return; }
    try { const n = await window.api.journalImport(); if (n) showToast(tn(n, '{n} video added to the journal.', '{n} videos added to the journal.')); } catch (err) { showToast(cleanErr(err)); }
    update();
  };
  $('btnJOpenMd').onclick = () => window.api.journalOpen('md');
  $('btnJOpenDir').onclick = () => window.api.journalOpen('folder');
  $('btnJOpenInstr').onclick = () => window.api.journalOpen('instructions');
  let searchTimer = null;
  $('jSearch').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = $('jSearch').value.trim();
      view = q.length >= 2 ? { type: 'search', q } : { type: 'prep' };
      render();
    }, 200);
  };

  // ---------- Notes during the recording ----------
  // The panel next to the camera: the chosen subject (where you're at, to decide, leads, already said),
  // or, with no subject chosen, the leads of the last summary and the open subjects.
  let notesChoice = '';
  // The look-back being prepared can be chosen like a subject: its questions show next to the camera.
  const lbOpen = () => (S && S.lookback && S.lookback.open) || null;
  const isLb = (id) => typeof id === 'string' && id.startsWith('lookback:') && !!lbOpen() && lbOpen().id === id.slice(9);
  const stepLine = (x) => `<li>${x.situation ? `<span class="muted">${esc(x.situation)}:</span> ` : ''}${esc(x.text)}</li>`;
  function notesBody() {
    if (isLb(notesChoice)) {
      const L = S.lookback;
      const items = L.material.items.map(itemById).filter(Boolean);
      return `<h3 class="nb-title">${t('Look back')}</h3>
        <p class="muted small">${esc(t('since {date}', { date: shortDay(L.from) }))} · ${esc(nVideos(L.videos))}</p>
        <h4>${t('Questions')}</h4><ol class="nb-q">${L.questions.map((q) => `<li>${esc(q.text)}</li>`).join('')}</ol>
        ${items.length ? `<h4>${t('Steps forward in this time')}</h4><ul>${items.slice(-8).map(stepLine).join('')}</ul>` : ''}
        ${L.material.subjects.length ? `<h4>${t('Then and now')}</h4><ul>${L.material.subjects.slice(0, 5).map((x) => `<li><b>${esc(x.titre)}</b>: ${esc(x.then || t('not started yet'))} → ${esc(x.now || t('nothing written'))}</li>`).join('')}</ul>` : ''}`;
    }
    const s = notesChoice && sub(notesChoice);
    if (s) {
      const x = st(s);
      const mine = activeItems().filter((i) => i.subject === s.id && i.kind !== 'done').slice(-4);
      return `<h3 class="nb-title">${esc(s.titre)}</h3>
        <p class="muted small">${esc(nVideos(x.entries.length))} · ${esc(t('last time {when}', { when: ago(x.last) }))}</p>
        ${mine.length ? `<h4>${t('What you understood about it')}</h4><ul>${mine.map(stepLine).join('')}</ul>` : ''}
        ${s.ou_j_en_suis ? `<h4>${t('Where you’re at')}</h4><p>${said(s.ou_j_en_suis, null, false)}</p>` : ''}
        ${s.evolution ? `<h4>${t('Last time')}</h4><p>${said(s.evolution, null, false)}</p>` : ''}
        ${s.a_trancher.length ? `<h4>${t('To decide')}</h4><ul>${s.a_trancher.map((q) => `<li>${said(q, null, false)}</li>`).join('')}</ul>` : ''}
        ${s.pistes.length ? `<h4>${t('Leads')}</h4><ul>${s.pistes.map((q) => `<li>${said(q, null, false)}</li>`).join('')}</ul>` : ''}
        ${x.ideas.length ? `<h4>${t('Already said')}</h4><ul class="said">${x.ideas.slice(-8).reverse().map((i) => `<li><span class="muted">${shortDay(i.entry.date)}</span> ${said(i.texte, null, false)}</li>`).join('')}</ul>` : ''}`;
    }
    const b = S.bilans[S.bilans.length - 1];
    const open = openSubjects().slice(0, 8);
    const due = dueItems().slice(0, 3);
    return `${due.length ? `<h4>${t('To remember')}</h4><ul>${due.map(stepLine).join('')}</ul>` : ''}
      ${b && b.a_dire.length ? `<h4>${t('For this video (last summary)')}</h4><ul>${b.a_dire.map((x) => `<li>${said(x, null, false)}</li>`).join('')}</ul>` : ''}
      ${open.length ? `<h4>${t('Your open subjects')}</h4><ul class="nb-subs">${open.map((o) => `<li data-pick="${o.id}"><b>${esc(o.titre)}</b>${o.a_trancher.length ? `<span class="muted"> · ${esc(o.a_trancher[0])}</span>` : ''}</li>`).join('')}</ul><p class="muted small">${t('Pick a subject at the top to see where you’re at.')}</p>` : ''}`;
  }
  const hasNotes = () => S && (S.sujets.length || S.bilans.length || lbOpen() || dueItems().length);
  function drawNotes() {
    $('notesBody').innerHTML = notesBody();
    $('notesBody').querySelectorAll('[data-pick]').forEach((li) => (li.onclick = () => { notesChoice = li.dataset.pick; $('notesSubject').value = notesChoice; drawNotes(); }));
  }
  function setupNotes(initial) {
    const on = !!hasNotes();
    let hidden = false;
    try { hidden = localStorage.getItem('carnet.notesHidden') === '1'; } catch (_) {}
    const valid = (id) => !!id && (!!sub(id) || isLb(id));
    notesChoice = valid(initial) ? initial : valid(pendingSubject) ? pendingSubject : '';
    pendingSubject = null;
    show('notesPanel', on && !hidden);
    show('btnNotesShow', on && hidden);
    if (!on) return;
    const lb = lbOpen();
    $('notesSubject').innerHTML = `<option value="">${t('Free subject')}</option>${lb ? `<option value="lookback:${lb.id}">${esc(t('Look-back since {date}', { date: shortDay(lb.from) }))}</option>` : ''}${openSubjects().map((s) => `<option value="${s.id}">${esc(s.titre)}</option>`).join('')}`;
    $('notesSubject').value = notesChoice;
    drawNotes();
  }
  $('notesSubject').onchange = () => { notesChoice = $('notesSubject').value; drawNotes(); };
  const setNotesHidden = (h) => {
    try { localStorage.setItem('carnet.notesHidden', h ? '1' : '0'); } catch (_) {}
    show('notesPanel', !h); show('btnNotesShow', h);
  };
  $('btnNotesHide').onclick = () => setNotesHidden(true);
  $('btnNotesShow').onclick = () => setNotesHidden(false);

  // ---------- Settings ----------
  function renderSettings() {
    $('setDir').textContent = S.dir || t('No folder chosen');
    $('setExportDir').textContent = S.exportDir || '';
    document.querySelectorAll('input[name="txMode"]').forEach((r) => (r.checked = r.value === S.transcriber));
    show('setWhisperBox', S.transcriber === 'whisper');
    show('setWhisperOk', S.whisper.installed);
    show('setWhisperInstall', !S.whisper.installed);
    if (S.whisper.installed) {
      const m = S.whisper.catalog[S.whisper.model];
      $('setWhisperInfo').textContent = t('Installed · {label} model ({size})', { label: t(m.label), size: t(m.size) });
    }
    $('setKey').placeholder = S.gemini.hasKey ? t('Key saved (paste a new key to change it)') : t('Gemini API key');
    const g = S.gemini;
    show('setTierRow', g.hasKey);
    $('setTier').textContent = g.tierChecking ? t('Checking the key…')
      : g.tier === 'free' ? t('Free key. When Gemini is overloaded, Carnet tries again on its own for up to 20 minutes, then picks up later without you.')
        : g.tier === 'paid' ? t('Paid key. When Gemini is overloaded, Carnet tries again on its own.')
          : t('Key type not known yet (free or paid).');
    $('btnSetTier').disabled = !!g.tierChecking;
    $('setModel').innerHTML = g.models.map((m) => `<option ${m === g.model ? 'selected' : ''}>${esc(m)}</option>`).join('');
    $('setModel').disabled = !g.hasKey;
    $('setBudget').value = g.usage.budget;
    $('setAutoBilan').checked = g.autoBilan;
    $('setAutoSemaine').checked = g.autoSemaine;
    const u = g.usage;
    $('setUsage').textContent = g.hasKey
      ? t('Today: {count} of {budget} calls{blocked}. One video = 1 call (transcription included; 2 when search memory is in use and Gemini transcribes), correcting a video with a clarification = 1 call, a summary (of a period or a week) = 1 call, reorganising the subjects = 1 call, updating strengths and weaknesses = 1 call, the look-back questions, “How far you’ve come” and looking through earlier videos = 1 call each. The counter resets at {time} (midnight in California).', {
        count: u.count, budget: u.budget, blocked: u.blocked ? ' · ' + t('Google reported the quota as reached') : '', time: clock(g.resetAt),
      })
      : '';
    // Search memory and permanent facts.
    const m = S.memory;
    const upd = (ts) => (ts ? t('updated on {date}', { date: shortDay(ts) }) : '');
    $('setMemory').textContent = !m ? t('Choose a journal folder first.')
      : !g.hasKey ? t('Needs a Gemini key.')
        : m.building ? t('Indexing your journal: {done} of {total}…', { done: m.building.done, total: m.building.total })
          : m.error ? (m.waitUntil ? t('Paused by Gemini ({error}). Tries again at {time}.', { error: m.error.slice(0, 160), time: clock(m.waitUntil) }) : t('Could not build it: {error}', { error: m.error.slice(0, 200) }))
            : m.items && m.over ? t('In use: your journal is at {pct}% of what one request can hold. {items}, {updated}.', { pct: m.pct, items: tn(m.items, '{n} item indexed', '{n} items indexed'), updated: upd(m.updated) })
              : m.items ? t('Ready: {items}, {updated}. Used when your journal goes over what one request can hold (now {pct}%).', { pct: m.pct, items: tn(m.items, '{n} item indexed', '{n} items indexed'), updated: upd(m.updated) })
                : m.wanted ? t('Being prepared: your journal is at {pct}% of what one request can hold.', { pct: m.pct })
                  : t('Not needed yet: your journal is at {pct}% of what one request can hold. It is built on its own from 60%.', { pct: m.pct });
    $('btnMemBuild').textContent = m && m.items ? t('Build again') : t('Build now');
    $('btnMemBuild').disabled = !m || !g.hasKey || !!m.building;
    const nf = (S.faits || []).length;
    $('setFactsLine').innerHTML = `${esc(nf ? tn(nf, '{n} permanent fact goes with every new analysis.', '{n} permanent facts go with every new analysis.') : t('No permanent fact yet.'))} <button class="link-btn" id="btnSetFacts">${t('See them')}</button>`;
    $('btnSetFacts').onclick = () => { $('settingsModal').classList.add('hidden'); go({ type: 'precisions' }); };
    // Recording: the same choices as under the picture of the recording window (kept in this window's storage).
    $('setQuality').value = typeof recLight === 'function' && recLight() ? 'light' : 'full';
    $('setRecBy').value = typeof recBy === 'function' ? recBy() : 'phone';
    $('setLang').innerHTML = i18n.LANGS.map((l) => `<option value="${l.code}" ${l.code === i18n.lang ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
    const r = S.reminder || { on: false, time: '20:00' };
    $('setReminderOn').checked = r.on;
    if (document.activeElement !== $('setReminderTime')) $('setReminderTime').value = r.time;
  }
  // Settings, opened at the top or at one section (the list of sections at the top goes there too).
  function openSettings(sec) {
    renderSettings();
    $('settingsModal').classList.remove('hidden');
    const d = document.querySelector('.settings-dialog');
    if (typeof sec === 'string' && $(sec)) goSection(sec); else d.scrollTop = 0;
  }
  function goSection(id) {
    const el = $(id);
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }
  document.querySelectorAll('#setNav [data-sec]').forEach((b) => (b.onclick = () => goSection(b.dataset.sec)));
  $('btnJSettings').onclick = openSettings;
  $('btnSettingsClose').onclick = () => $('settingsModal').classList.add('hidden');
  $('btnSetExportDir').onclick = async () => { S = await window.api.journalChooseExportDir(); renderSettings(); };
  $('btnJOpenExports').onclick = () => window.api.openExports();
  $('btnSetDir').onclick = async () => { S = await window.api.journalChooseDir(); renderSettings(); render(); };
  $('btnSetKey').onclick = async () => {
    const key = $('setKey').value.trim();
    if (!key) return;
    $('setKeyMsg').textContent = t('Checking the key…');
    try {
      S = await window.api.journalSetKey(key);
      $('setKey').value = '';
      $('setKeyMsg').textContent = window.api.platform === 'darwin' ? t('Key valid and saved (encrypted in the keychain of your Mac).') : t('Key valid and saved (encrypted with your Windows account).');
    } catch (err) {
      $('setKeyMsg').textContent = t('Key refused: {error}', { error: cleanErr(err).slice(0, 200) });
    }
    renderSettings(); render();
  };
  $('btnSetTier').onclick = async () => {
    $('btnSetTier').disabled = true;
    try { S = await window.api.journalCheckTier(); } catch (err) { showToast(cleanErr(err)); }
    renderSettings();
  };
  $('btnMemBuild').onclick = async () => {
    $('btnMemBuild').disabled = true;
    try { S = await window.api.memoryBuild({ again: !!(S.memory && S.memory.items) }); } catch (err) { showToast(cleanErr(err)); }
    renderSettings();
  };
  $('setModel').onchange = async () => { S = await window.api.journalSettings({ model: $('setModel').value }); render(); };
  $('setBudget').onchange = async () => { S = await window.api.journalSettings({ budget: +$('setBudget').value }); renderSettings(); render(); };
  document.querySelectorAll('input[name="txMode"]').forEach((r) => (r.onchange = async () => {
    S = await window.api.journalSettings({ transcriber: r.value });
    renderSettings(); render();
  }));
  $('setAutoSemaine').onchange = async () => { S = await window.api.journalSettings({ autoSemaine: $('setAutoSemaine').checked }); };
  $('setAutoBilan').onchange = async () => { S = await window.api.journalSettings({ autoBilan: $('setAutoBilan').checked }); };
  // Daily reminder: on or off, and its time.
  const saveReminder = async () => {
    S = await window.api.journalSettings({ reminder: { on: $('setReminderOn').checked, time: $('setReminderTime').value || '20:00' } });
    renderSettings();
  };
  $('setReminderOn').onchange = saveReminder;
  $('setReminderTime').onchange = saveReminder;
  $('btnReminderTest').onclick = async () => {
    const ok = await window.api.reminderTest();
    if (!ok) showToast(t('Notifications are not available on this computer.'));
  };
  $('setQuality').onchange = () => { if (typeof setRecLight === 'function') setRecLight($('setQuality').value === 'light'); };
  $('setRecBy').onchange = () => { if (typeof setRecBy === 'function') setRecBy($('setRecBy').value); };
  // A new language reloads the window, so that every text is in that language.
  $('setLang').onchange = async () => {
    const code = $('setLang').value;
    if (code === i18n.lang) return;
    if (typeof hasWork === 'function' && hasWork() && !confirm(t('Changing the language reloads the window: the video open in the editor will be closed. Continue?'))) { $('setLang').value = i18n.lang; return; }
    await window.api.setLanguage(code);
    location.reload();
  };
  $('btnWInstall').onclick = async () => {
    const model = document.querySelector('input[name="wModel"]:checked').value;
    $('btnWInstall').disabled = true;
    show('wInstallBar', true);
    $('wInstallMsg').textContent = t('Downloading…');
    try {
      S = await window.api.whisperInstall(model);
      $('wInstallMsg').textContent = '';
    } catch (err) {
      $('wInstallMsg').textContent = t('Installation failed: {error}', { error: cleanErr(err).slice(0, 300) });
    } finally {
      $('btnWInstall').disabled = false;
      show('wInstallBar', false);
      renderSettings(); render();
    }
  };
  window.api.onWhisperInstallProgress((p) => {
    $('wInstallFill').style.width = Math.round(p.pct * 100) + '%';
    $('wInstallMsg').textContent = t('{step}: {pct} %', { step: t(p.step), pct: Math.round(p.pct * 100) });
  });

  // ---------- Updates from the main process ----------
  window.api.onJournalState((s) => {
    const before = S;
    S = s;
    // Say when an entry has just been analysed, and whether it changed what Carnet knows about you.
    if (before) for (const e of s.entries) {
      const old = before.entries.find((x) => x.id === e.id);
      if (old && !old.analysis && e.analysis) {
        const n = e.analysis.profileChanges || 0, pa = e.analysis.progressAdded || 0, pl = e.analysis.progressLinks || 0;
        const ck = (s.checks || []).filter((c) => c.entry === e.id).length;
        const extra = [n && tn(n, '{n} change about you', '{n} changes about you'), pa && tn(pa, '{n} step forward', '{n} steps forward'), pl && tn(pl, 'linked to {n} earlier step', 'linked to {n} earlier steps'), ck && tn(ck, '{n} thing to check', '{n} things to check')].filter(Boolean);
        showToast([t('Video analysed: {title}', { title: title(e) }), ...extra].join(' · '));
      }
    }
    render();
    if (!$('settingsModal').classList.contains('hidden')) renderSettings();
  });
  window.api.onJournalBusy((m) => { busyMsg = m; if (S) renderSide(); });

  // carnet://entree/<id>?t=… link clicked in Journal.md.
  async function openEntry(l) {
    if (!l) return;
    if (!$('modal').classList.contains('hidden')) return; // recording in progress: not interrupted
    showScreen('journal');
    await update();
    if (S.entries.some((e) => e.id === l.id)) go({ type: 'entry', id: l.id, t: l.t });
    else showToast(t('This entry no longer exists in the journal.'));
  }
  window.api.onOpenEntry(openEntry);
  window.api.initialLink().then(openEntry);

  window.journalUI = {
    async openEntryByFile(file) {
      await update();
      const name = file.split(/[\\/]/).pop();
      const e = S.entries.find((x) => x.file.split('/').pop() === name);
      go(e ? { type: 'entry', id: e.id } : { type: 'prep' });
    },
    // Notes panel of the recording (app.js).
    setupNotes,
    notesChoice: () => (notesChoice && (sub(notesChoice) || isLb(notesChoice)) ? notesChoice : null),
    subjectTitle: (id) => (isLb(id) ? t('Look back') : sub(id) ? sub(id).titre : null),
  };
  // Opened from the daily reminder (or the notification area): straight to a page.
  window.api.onJournalGo((v) => {
    if (!$('modal').classList.contains('hidden')) return; // recording in progress: not interrupted
    showScreen('journal');
    go({ type: v });
  });
  window.api.initialNav().then((v) => { if (v) { view = { type: v }; render(); } });

  update();
})();
