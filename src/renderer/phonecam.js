'use strict';
// Côté fenêtre : reçoit l'image du téléphone (voir src/phonecam.js et src/phone/index.html).
// Trois sources, la meilleure qui arrive est affichée :
//  - « direct » : vidéo WebRTC, quand le réseau la laisse passer (comptée seulement si des images sont décodées) ;
//  - « flux » : vidéo compressée par le téléphone (H.264 ou VP8) reçue par le WebSocket et décodée ici
//    (WebCodecs) : passe partout où la page du téléphone s'ouvre, fluide ;
//  - « images » : JPEG une par une, en dernier recours.
// Pour l'aperçu et l'enregistrement, l'image passe par un canevas : sa piste vidéo ne change jamais, quelle que
// soit la source, même si le téléphone se déconnecte et se reconnecte en cours de route.
window.phoneCam = (() => {
  let pc = null, control = null;
  let state = 'idle';          // idle | connecting | live | lost
  let facing = 'user';
  const listeners = new Set();
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.autoplay = true;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let drawTimer = null, users = 0, sizeLocked = false;
  // Diagnostic de la dernière tentative : ce que Carnet a vu, pour savoir où la vidéo bloque.
  let diag = null;
  async function collectDiag(peer, offerSdp, reason) {
    const cands = (sdp) => [...String(sdp || '').matchAll(/^a=candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/gm)].map((m) => `${m[2]}:${m[3]} ${m[1]} ${m[4]}`);
    const d = { at: Date.now(), reason, connection: peer.connectionState, ice: peer.iceConnectionState, phone: cands(offerSdp), pc: cands(peer.localDescription && peer.localDescription.sdp), pairs: [], replies: [], video: !!video.videoWidth };
    try {
      const st = await peer.getStats();
      st.forEach((r) => {
        if (r.type === 'candidate-pair') {
          const l = st.get(r.localCandidateId), rm = st.get(r.remoteCandidateId);
          d.pairs.push(`${l ? `${l.address || l.ip}:${l.port} ${l.protocol}` : '?'} -> ${rm ? `${rm.address || rm.ip}:${rm.port} ${rm.candidateType}` : '?'} : ${r.state}${r.requestsSent ? ', ' + tn(r.requestsSent, '{n} attempt sent', '{n} attempts sent') : ''}${r.responsesReceived ? ', ' + tn(r.responsesReceived, '{n} reply', '{n} replies') : ', ' + t('no reply')}`); d.replies.push(!!r.responsesReceived);
        }
      });
    } catch (_) {}
    diag = d;
    emit();
  }
  // Explication en clair à partir du diagnostic.
  function explain(d) {
    if (!d) return '';
    if (!relayCount && !chunkCount) return t('No picture arrives from the phone, not even by the fallback path. On the phone, close the Carnet tab, scan the QR code again and tap “Start camera”.');
    if (!d.phone.length) return t('The phone announced no address: its browser blocks the direct connection.');
    if (d.phone.every((c) => /\.local:/.test(c))) return t('The phone hides its address (a “.local” name) and the computer cannot find it. Allowing the camera for the page on the phone, then trying again, often solves this.');
    if (d.replies.length && d.replies.every((x) => !x)) {
      if (window.api && window.api.platform === 'darwin') return t('The phone and the computer can see each other, but the video (UDP) does not get through. Usual causes: Carnet is not allowed on the local network (System Settings > Privacy & Security > Local Network), a VPN or security software running on the Mac, or a Wi-Fi that isolates devices (guest network, public or company Wi-Fi).');
      return t('The phone and the computer can see each other, but the video (UDP) does not get through. Usual causes: the Windows firewall (button below), a VPN or security software running on the computer, or a Wi-Fi that isolates devices (guest network, public or company Wi-Fi).');
    }
    return t('The video connection failed.');
  }
  // Rotation de l'image du téléphone (0, 90, 180, 270°, sens horaire), gardée d'une fois sur l'autre.
  // Utile quand le verrouillage de rotation du téléphone est activé : tenu à l'horizontale, il envoie
  // quand même une image en portrait, couchée.
  let rotation = 0;
  try { rotation = (Number(localStorage.getItem('carnet.phoneRotation')) || 0) % 360; } catch (_) {}
  // When the phone records itself: its microphone (null until it says), and its sound level.
  let mic = null, level = 0, levelAt = 0;
  const levelListeners = new Set();

  const emit = () => listeners.forEach((f) => { try { f(state, facing); } catch (_) {} });
  const setState = (s) => { if (state !== s) { state = s; emit(); } };

  // Réponse rapide sur un réseau local : on préfère H.264 et on réduit l'attente dans le tampon de réception.
  function preferReceiveCodecs(peer) {
    const caps = RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video');
    if (!caps) return;
    const rank = (c) => {
      const m = c.mimeType.toLowerCase();
      if (m === 'video/h264') return /profile-level-id=64/i.test(c.sdpFmtpLine || '') ? 0 : 1;
      if (m === 'video/vp8') return 2;
      if (m === 'video/vp9') return 3;
      return 9;
    };
    for (const tr of peer.getTransceivers()) {
      if (tr.receiver.track.kind !== 'video' || !tr.setCodecPreferences) continue;
      try { tr.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b))); } catch (_) {}
    }
  }
  // Débit de départ élevé (sinon le téléphone démarre flou puis monte lentement), plafond confortable en Wi-Fi.
  function tuneAnswer(sdp) {
    const out = [];
    let inVideo = false;
    const pts = new Set();
    for (const line of sdp.split(/\r?\n/)) {
      if (line.startsWith('m=')) { inVideo = line.startsWith('m=video'); if (inVideo) line.split(' ').slice(3).forEach((p) => pts.add(p)); out.push(line); continue; }
      if (inVideo && line.startsWith('b=')) continue;
      out.push(line);
      if (inVideo && line.startsWith('c=')) out.push('b=AS:25000');
    }
    return out.map((l) => {
      const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
      if (!m || !pts.has(m[1]) || /apt=|x-google-start-bitrate/.test(m[2])) return l;
      return `a=fmtp:${m[1]} ${m[2]};x-google-start-bitrate=8000;x-google-min-bitrate=2500`;
    }).join('\r\n');
  }
  function waitIce(peer, ms = 2500) {
    if (peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); peer.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => peer.iceGatheringState === 'complete' && done();
      const t = setTimeout(done, ms);
      peer.addEventListener('icegatheringstatechange', check);
    });
  }

  // Une offre du téléphone (un seul téléphone à la fois : le nouveau remplace l'ancien).
  async function handleOffer(sdp) {
    if (pc) { pc.onconnectionstatechange = null; pc.close(); }
    const peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    pc = peer;
    framesDecoded = 0; lastDirect = 0;
    compute();
    peer.ontrack = (ev) => {
      if (ev.track.kind !== 'video') return;
      try { ev.receiver.jitterBufferTarget = 0; } catch (_) {}
      startDirect(ev.track);
    };
    peer.ondatachannel = (ev) => {
      if (ev.channel.label !== 'carnet') return;
      control = ev.channel;
      control.onmessage = (m) => {
        try { const msg = JSON.parse(m.data); if (msg.type === 'facing' && (msg.facing === 'user' || msg.facing === 'environment')) onFacing(msg); } catch (_) {}
      };
    };
    peer.onconnectionstatechange = () => {
      if (pc !== peer) return;
      const s = peer.connectionState;
      if (s === 'failed') collectDiag(peer, sdp, t('failed'));
      if (s === 'connected') diag = null;
      compute();
    };
    // Toujours pas connecté au bout de 12 secondes : on note ce qui a été vu.
    setTimeout(() => { if (pc === peer && peer.connectionState !== 'connected') collectDiag(peer, sdp, t('no connection after 12 s')); }, 12000);
    await peer.setRemoteDescription({ type: 'offer', sdp });
    preferReceiveCodecs(peer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription({ type: 'answer', sdp: tuneAnswer(answer.sdp) });
    await waitIce(peer);
    return peer.localDescription.sdp;
  }
  // ---------- Les sources, et l'état qui en découle ----------
  const GRACE = 2500;   // coupure plus courte (passage d'un chemin à l'autre, Wi-Fi qui hoquette) : rien ne change à l'écran
  let lastDirect = 0, framesDecoded = 0;                                                       // direct
  let dec = null, decKey = '', decCodec = '', needKey = true, lastKeyAsk = 0, decErrors = 0;     // flux
  let lastChunk = 0, chunkCount = 0, decodedCount = 0, lastOutput = 0, sinceOutput = 0, vframe = null, vframeAt = 0;
  const decodable = new Map();
  let bitmap = null, bitmapAt = 0, lastRelay = 0, relayCount = 0, decoding = false;             // images
  let hadLive = false, liveAt = 0, mode = null;                                                 // mode : 'direct' | 'secours' | null
  const directOk = () => Date.now() - lastDirect < 1200; // des images de la vidéo directe arrivent
  // Vidéo directe : chaque image est lue dès qu'elle est décodée et dessinée aussitôt, à la cadence du téléphone
  // (30 ou 60 images par seconde), sans horloge qui en double ou en saute. MediaStreamTrackProcessor, sinon
  // l'élément vidéo avec requestVideoFrameCallback.
  let dframe = null, pumpId = 0, viaProcessor = false, viaRvfc = false;
  function startDirect(track) {
    const id = ++pumpId;
    if (dframe) { dframe.close(); dframe = null; }
    viaProcessor = viaRvfc = false;
    if (typeof MediaStreamTrackProcessor === 'function') {
      let reader = null;
      try { reader = new MediaStreamTrackProcessor({ track }).readable.getReader(); } catch (_) {}
      if (reader) {
        viaProcessor = true;
        (async () => {
          for (;;) {
            let r;
            try { r = await reader.read(); } catch (_) { break; }
            if (r.done) break;
            if (id !== pumpId) { r.value.close(); break; }
            onDirectFrame(r.value);
          }
          try { reader.cancel(); } catch (_) {}
        })();
        return;
      }
    }
    video.srcObject = new MediaStream([track]);
    video.play().catch(() => {});
    if (video.requestVideoFrameCallback) {
      viaRvfc = true;
      const step = () => {
        if (id !== pumpId) return;
        lastDirect = Date.now();
        if (pick() === 'direct') paint();
        video.requestVideoFrameCallback(step);
      };
      video.requestVideoFrameCallback(step);
    }
  }
  function onDirectFrame(f) {
    lastDirect = Date.now();
    if (!users) { f.close(); return; } // rien n'est affiché : l'image n'est pas gardée
    if (dframe) dframe.close();
    dframe = f;
    if (pick() === 'direct') paint();
  }
  const directSrc = () => (viaProcessor ? dframe : video.videoWidth > 0 && video.readyState >= 2 ? video : null);
  // Taille de l'image de la caméra du téléphone (il l'envoie). WebRTC baisse parfois la définition un moment
  // (démarrage, Wi-Fi qui faiblit) : le canevas ne rétrécit pas pour autant, sinon un enregistrement lancé à ce
  // moment-là resterait en petite taille jusqu'au bout.
  let camW = 0, camH = 0;
  function onFacing(m) {
    if (m.width > 0 && m.height > 0) { camW = m.width; camH = m.height; }
    if (m.facing && m.facing !== facing) { facing = m.facing; emit(); }
  }
  const secoursOk = () => { const now = Date.now(); return now - lastChunk < 2000 || now - lastRelay < 2000; };
  const toPhone = (m) => { if (window.api.phoneStreamSend) window.api.phoneStreamSend(m); };
  // Demande au téléphone une image clé (et son format) : le décodage ne peut repartir que de là.
  function askKey() { const now = Date.now(); if (now - lastKeyAsk > 400) { lastKeyAsk = now; toPhone({ type: 'key' }); } }
  function closeDecoder() { if (dec && dec.state !== 'closed') { try { dec.close(); } catch (_) {} } dec = null; decKey = ''; needKey = true; }
  // Format que cet ordinateur ne sait pas lire : le téléphone passe au suivant (H.264, puis VP8, puis images JPEG).
  function refuse(codec) { closeDecoder(); toPhone({ type: 'codec-error', codec }); }
  const fromB64 = (t) => { const b = atob(t); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  async function onConfig(m) {
    const key = `${m.codec}|${m.width}x${m.height}|${m.description || ''}`;
    if (dec && dec.state === 'configured' && key === decKey) return;
    if (typeof VideoDecoder === 'undefined') { refuse(m.codec); return; }
    const cfg = { codec: m.codec, codedWidth: m.width, codedHeight: m.height, optimizeForLatency: true, ...(m.description ? { description: fromB64(m.description) } : {}) };
    let ok = decodable.get(key);
    if (ok === undefined) {
      try { ok = !!(await VideoDecoder.isConfigSupported(cfg)).supported; } catch (_) { ok = false; }
      decodable.set(key, ok);
      if (dec && dec.state === 'configured' && key === decKey) return;
    }
    if (!ok) { refuse(m.codec); return; }
    closeDecoder();
    try {
      dec = new VideoDecoder({ output: onDecoded, error: onDecodeError });
      dec.configure(cfg);
      decKey = key; decCodec = m.codec; sinceOutput = 0;
      askKey();
    } catch (_) { refuse(m.codec); }
  }
  function onChunk(m) {
    lastChunk = Date.now();
    chunkCount++;
    if (!users) { needKey = true; return; }  // rien n'est affiché : pas de décodage (il reprendra sur une image clé)
    if (!dec || dec.state !== 'configured') { askKey(); return; }
    if (needKey && !m.key) { askKey(); return; }
    if (dec.decodeQueueSize > 6) { needKey = true; askKey(); return; } // décodeur en retard : on repart d'une image clé
    try {
      dec.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: m.ts, data: m.data }));
      needKey = false;
    } catch (_) { needKey = true; askKey(); return; }
    // Des images arrivent mais rien ne sort du décodeur : ce format ne passe pas ici.
    if (++sinceOutput > 45 && Date.now() - lastOutput > 3000) refuse(decCodec);
  }
  function onDecoded(frame) {
    lastOutput = Date.now(); sinceOutput = 0; decErrors = 0; decodedCount++;
    if (!users) { frame.close(); return; }
    if (vframe) vframe.close();
    vframe = frame; vframeAt = lastOutput;
    if (pick() === 'stream') paint();
  }
  function onDecodeError() {
    const codec = decCodec;
    dec = null; decKey = ''; needKey = true;
    if (++decErrors >= 3) { decErrors = 0; refuse(codec); } else askKey();
  }
  async function onJpeg(data, f) {
    lastRelay = Date.now();
    relayCount++;
    if (f && f !== facing) { facing = f; emit(); }
    // Décodée seulement quand l'image sert ; si le décodage prend du retard, on saute des images.
    if (!users || decoding) return;
    decoding = true;
    try {
      const bmp = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
      if (users) { if (bitmap) bitmap.close(); bitmap = bmp; bitmapAt = Date.now(); if (pick() === 'relay') paint(); } else bmp.close();
    } catch (_) {}
    decoding = false;
  }
  if (window.api.onPhoneFrame) window.api.onPhoneFrame(({ data, facing: f }) => { onJpeg(data, f); compute(); });
  if (window.api.onPhoneStream) window.api.onPhoneStream((m) => {
    if (m.kind === 'chunk') onChunk(m);
    else if (m.kind === 'config') onConfig(m);
    else if (m.kind === 'jpeg') onJpeg(m.data);
    else if (m.kind === 'facing') onFacing(m);
    else if (m.kind === 'open') { needKey = true; askKey(); }
    else if (m.kind === 'close') needKey = true;
    // The phone records itself: sound level and state of its microphone.
    else if (m.kind === 'level') { level = m.v; levelAt = Date.now(); levelListeners.forEach((f) => { try { f(m.v); } catch (_) {} }); }
    else if (m.kind === 'mic') { mic = { ok: m.ok, error: m.error, at: Date.now() }; emit(); }
    compute();
  });
  // Vidéo directe : on ne la compte comme reçue que si des images sont vraiment décodées.
  setInterval(async () => {
    const peer = pc;
    if (!peer) return;
    try {
      const st = await peer.getStats();
      if (pc !== peer) return;
      st.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video' && (r.framesDecoded || 0) > framesDecoded) { framesDecoded = r.framesDecoded; if (!viaProcessor) lastDirect = Date.now(); }
      });
    } catch (_) {}
  }, 400);
  let sentDirect = null, sentAt = 0;
  function compute() {
    const now = Date.now(), d = directOk(), r = secoursOk();
    if (d || r) { hadLive = true; liveAt = now; }
    const graced = !d && !r && hadLive && now - liveAt < GRACE;
    const s = d || r || graced ? 'live' : hadLive ? 'lost' : pc ? 'connecting' : 'idle';
    const m = d ? 'direct' : r ? 'secours' : graced ? mode : null;
    const modeChanged = m !== mode;
    mode = m;
    if (s === 'live' && diag) { diag = null; emit(); }
    if (s !== state) setState(s); else if (modeChanged) emit();
    // Dit au serveur si la vidéo directe arrive : le téléphone s'en sert pour passer au direct ou en revenir.
    if (window.api.phoneDirectStatus && (d !== sentDirect || now - sentAt > 1000)) { sentDirect = d; sentAt = now; window.api.phoneDirectStatus(d); }
  }
  setInterval(compute, 250);

  window.api.onPhoneOffer(async ({ id, sdp }) => {
    try { window.api.phoneAnswer({ id, sdp: await handleOffer(sdp) }); }
    catch (err) { window.api.phoneAnswer({ id, error: String(err && err.message || err) }); }
  });

  // Source à dessiner : le direct s'il arrive, sinon l'image de secours la plus récente (flux ou JPEG).
  function pick() {
    if (directOk() && directSrc()) return 'direct';
    const now = Date.now();
    const sv = vframe && now - vframeAt < 2000 ? vframeAt : 0, rv = bitmap && now - bitmapAt < 2000 ? bitmapAt : 0;
    return sv || rv ? (sv >= rv ? 'stream' : 'relay') : null;
  }
  // Dessin dans le canevas, dès qu'une image arrive (direct, flux ou JPEG) : mouvement régulier, à la cadence du
  // téléphone. L'horloge à 30 images par seconde ne dessine plus que l'écran d'attente.
  let lastKind = null, shownAt = 0, lastW = 0, lastH = 0, light = false;
  const painted = []; // instants des dernières images dessinées (cadence affichée)
  function paint(force) {
    let kind = pick();
    if (kind) shownAt = Date.now();
    else if (lastKind && Date.now() - shownAt < GRACE + 500) {
      // Courte coupure : la dernière image reste à l'écran (redessinée seulement si on tourne l'image).
      if (!force) return;
      kind = lastKind;
    }
    const src = kind === 'direct' ? directSrc() : kind === 'stream' ? vframe : kind === 'relay' ? bitmap : null;
    // Taille : élément vidéo, image décodée (VideoFrame) ou image JPEG (ImageBitmap).
    const w = !src ? 0 : src === video ? video.videoWidth : src.displayWidth !== undefined ? src.displayWidth : src.width;
    const h = !src ? 0 : src === video ? video.videoHeight : src.displayHeight !== undefined ? src.displayHeight : src.height;
    if (src && w && h) {
      lastKind = kind; lastW = w; lastH = h;
      if (!force) { const now = performance.now(); painted.push(now); while (painted.length && now - painted[0] > 1000) painted.shift(); }
    }
    const turned = rotation % 180 !== 0;
    const iw = turned ? h : w, ih = turned ? w : h; // taille de l'image une fois tournée
    // Taille du canevas : celle de l'image ; pour la vidéo directe, celle de la caméra si l'image arrive plus petite.
    let cw0 = w, ch0 = h;
    if (kind === 'direct' && camW && camH && w && h && Math.max(camW, camH) > Math.max(w, h)) {
      const big = Math.max(camW, camH), small = Math.min(camW, camH);
      cw0 = w >= h ? big : small; ch0 = w >= h ? small : big;
    }
    let rw = turned ? ch0 : cw0, rh = turned ? cw0 : ch0;
    // Light recording: the picture recorded is at most 1280 pixels on its long side.
    if (light && Math.max(rw, rh) > 1280) { const k = 1280 / Math.max(rw, rh); rw = Math.round((rw * k) / 2) * 2; rh = Math.round((rh * k) / 2) * 2; }
    if (!sizeLocked && rw && rh && (canvas.width !== rw || canvas.height !== rh)) { canvas.width = rw; canvas.height = rh; }
    if (!canvas.width) { canvas.width = 1280; canvas.height = 720; }
    ctx.fillStyle = '#000';
    if (src && w && h) {
      const scale = Math.min(canvas.width / iw, canvas.height / ih);
      const dw = w * scale, dh = h * scale;
      if (iw * scale < canvas.width - 1 || ih * scale < canvas.height - 1) ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    } else {
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#9a9ca3';
      ctx.font = `${Math.round(canvas.height / 22)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(t('Phone disconnected: reconnecting…'), canvas.width / 2, canvas.height / 2);
    }
  }
  function tick() {
    const k = pick();
    if ((k === 'direct' && !viaProcessor && !viaRvfc) || (!k && !(lastKind && Date.now() - shownAt < GRACE + 500))) paint();
  }

  return {
    get state() { return state; },
    get facing() { return facing; },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    pairing: () => window.api.phoneStart(),
    newCode: () => window.api.phoneNewCode(),
    // Piste vidéo pour l'aperçu et l'enregistrement (à rendre avec release()).
    acquire() {
      users++;
      if (!drawTimer) { paint(true); drawTimer = setInterval(tick, 1000 / 30); }
      if (users === 1) { needKey = true; askKey(); }
      // Sans cadence imposée : une image capturée à chaque image dessinée, au rythme où elles arrivent.
      // Light recording: 30 frames per second at most.
      return (light ? canvas.captureStream(30) : canvas.captureStream()).getVideoTracks()[0];
    },
    release() {
      users = Math.max(0, users - 1);
      if (users) return;
      if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
      if (bitmap) { bitmap.close(); bitmap = null; }
      if (vframe) { vframe.close(); vframe = null; }
      if (dframe) { dframe.close(); dframe = null; }
      lastKind = null;
    },
    // Taille de l'image figée pendant un enregistrement (si le téléphone pivote, l'image est recadrée sans déformer).
    lockSize(on) { sizeLocked = on; },
    // Light recording (720p, 30 frames per second) for a computer that cannot compress more.
    setLight(on) { light = !!on; },
    get diagnostic() { return diag; },
    get relay() { return mode === 'secours'; },
    get mode() { return mode; },
    get stats() { return { chunks: chunkCount, decoded: decodedCount, jpeg: relayCount, codec: decCodec }; },
    // Ce qui est affiché en ce moment : chemin, taille et cadence réelle (images dessinées dans la dernière seconde).
    get info() {
      const now = performance.now();
      while (painted.length && now - painted[0] > 1000) painted.shift();
      return { mode, width: lastW, height: lastH, fps: painted.length };
    },
    explain: () => explain(diag),
    diagnosticText() {
      if (!diag) return '';
      return [t('Carnet · phone camera diagnostic · {date}', { date: new Date(diag.at).toLocaleString(i18n.locale) }), t('Result: {reason} (connection {connection}, ICE {ice})', { reason: diag.reason, connection: diag.connection, ice: diag.ice }),
        t('Addresses announced by the phone: {list}', { list: diag.phone.join(' | ') || t('none') }), t('Addresses announced by the computer: {list}', { list: diag.pc.join(' | ') || t('none') }),
        t('Connection attempts:'), ...(diag.pairs.length ? diag.pairs.map((p) => '  ' + p) : ['  ' + t('none')]),
        t('Fallback path: video {chunks} pieces received, {decoded} frames decoded (format {codec}); JPEG pictures {jpeg}', { chunks: chunkCount, decoded: decodedCount, codec: decCodec || t('none'), jpeg: relayCount }),
        t('Explanation: {text}', { text: explain(diag) })].join('\n');
    },
    get rotation() { return rotation; },
    get mic() { return mic; },
    resetMic() { mic = null; },
    onLevel(f) { levelListeners.add(f); return () => levelListeners.delete(f); },
    // Tourne l'image d'un quart de tour (+90 sens horaire, -90 sens inverse).
    rotate(delta) {
      rotation = (((rotation + delta) % 360) + 360) % 360;
      try { localStorage.setItem('carnet.phoneRotation', String(rotation)); } catch (_) {}
      paint(true);
      emit();
      return rotation;
    },
  };
})();
