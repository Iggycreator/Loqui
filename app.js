// Loqui – prototype messenger: 1:1 chat + voice calls over WebRTC (PeerJS).
// Messages travel phone-to-phone; history is stored only on each device.
(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const PREFIX = "loqui-";
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// ---------------------------------------------------------------- storage
const store = {
  get(k, d) { try { const v = localStorage.getItem("loqui." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("loqui." + k, JSON.stringify(v)); } catch {} },
};
let me = store.get("me", null);
let contacts = store.get("contacts", []);           // [{id,name,unread,last,ts}]
if (me) contacts = contacts.filter((c) => c.id !== me.id);   // never list yourself
const msgsOf = (id) => store.get("msgs." + id, []);
const saveMsgs = (id, list) => store.set("msgs." + id, list.slice(-500));
const saveContacts = () => store.set("contacts", contacts);
const contact = (id) => contacts.find((c) => c.id === id);
const newCode = () => Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const cleanCode = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

// ---------------------------------------------------------------- ui helpers
const COLORS = ["#FF6B35", "#7C5CFF", "#1FA971", "#E5484D", "#0EA5E9", "#D946EF", "#F59E0B", "#14B8A6"];
const colorOf = (id) => COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const initials = (n) => (n || "?").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
function avatar(el, c, online) {
  el.textContent = initials(c.name); el.style.background = colorOf(c.id);
  if (online !== undefined) { const d = document.createElement("span"); d.className = "dot" + (online ? " on" : ""); el.appendChild(d); }
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDay = (ts) => {
  const d = new Date(ts), t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return "Hoy";
  if (d.toDateString() === y.toDateString()) return "Ayer";
  return d.toLocaleDateString([], { day: "numeric", month: "long" });
};
let toastT;
// ---- call diagnostics: a short log kept on the phone, copied from «Tu código»
const DIAG_KEY = "loqui-diag";
let diag = []; try { diag = JSON.parse(localStorage.getItem(DIAG_KEY) || "[]"); } catch { diag = []; }
function dlog(t) {
  const d = new Date(); const ts = d.toTimeString().slice(0, 8);
  diag.push(ts + " " + t); if (diag.length > 400) diag.splice(0, diag.length - 400);
  try { localStorage.setItem(DIAG_KEY, JSON.stringify(diag)); } catch {}
}
function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 2600); }
function show(screen) { for (const s of ["sOnboard", "sHome", "sChat"]) $(s).hidden = s !== screen; }

// ---------------------------------------------------------------- sound
let actx;
function audioCtx() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === "suspended") actx.resume(); } catch {} return actx; }
function beep(freq, dur, when = 0, vol = 0.12) {
  const c = audioCtx(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain(); o.frequency.value = freq; o.type = "sine";
  const t = c.currentTime + when; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.02); g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
}
const ping = () => { beep(880, 0.12); beep(1320, 0.14, 0.12); };
let ringT = null;
function ring(on, outgoing) {
  clearInterval(ringT); ringT = null;
  if (!on) return;
  const pat = () => outgoing ? (beep(440, 0.9, 0, 0.06), beep(480, 0.9, 0, 0.06)) : (beep(784, 0.25), beep(988, 0.25, 0.3), beep(784, 0.25, 0.6), beep(988, 0.25, 0.9));
  pat(); ringT = setInterval(pat, outgoing ? 3000 : 2400);
  if (!outgoing && navigator.vibrate) navigator.vibrate([400, 200, 400]);
}
document.addEventListener("pointerdown", audioCtx, { once: true });

// ---------------------------------------------------------------- notifications
function notify(title, body) {
  try { if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    navigator.serviceWorker?.getRegistration().then((r) => r ? r.showNotification(title, { body, icon: "icon-192.png", tag: "loqui" }) : new Notification(title, { body }));
  } } catch {}
}

// ---------------------------------------------------------------- peer network
let peer = null, open = false;
const conns = new Map();          // contactId -> DataConnection
const typingUntil = new Map();
let current = null;               // contact id open in chat

// Keeps the link alive: phones (iPhone above all) freeze the app in the background and
// connections die silently, so we ping every few seconds, drop links that went quiet,
// rebuild the peer when the server link is lost, and redial everyone on return.
const lastSeen = new Map();       // contactId -> ms of last data received
const dialing = new Map();        // contactId -> ms of last dial attempt
const PING_MS = 4000, DEAD_MS = 12000;
let reviveT = null, idTakenTries = 0;
// Relay (TURN) servers from Metered: when two phones can't reach each other directly
// (mobile carriers, strict Wi-Fi), audio and data travel through these.
const TURN_USER = "bdaa4d3f001c60b5b8c4c341", TURN_PASS = "AWrOigQGUr+EPwFV";
const ICE_SERVERS = [
  { urls: "stun:stun.relay.metered.ca:80" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:global.relay.metered.ca:80", username: TURN_USER, credential: TURN_PASS },
  { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: TURN_USER, credential: TURN_PASS },
  { urls: "turn:global.relay.metered.ca:443", username: TURN_USER, credential: TURN_PASS },
  { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: TURN_USER, credential: TURN_PASS },
];

function startPeer() {
  if (peer && !peer.destroyed) return;
  open = false;
  const p = new Peer(PREFIX + me.id.toLowerCase(), { debug: 0, config: { iceServers: ICE_SERVERS } });
  peer = p;
  p.on("open", () => { if (peer !== p) return; dlog("servidor: conectado"); open = true; idTakenTries = 0; renderAll(); redialAll(true); });
  p.on("connection", (conn) => setupConn(conn));
  p.on("call", onIncomingCall);
  p.on("disconnected", () => { if (peer !== p) return; dlog("servidor: desconectado"); open = false; renderAll(); scheduleRevive(1500); });
  p.on("close", () => { if (peer !== p) return; open = false; renderAll(); scheduleRevive(2000); });
  p.on("error", (e) => {
    if (peer !== p) return;
    dlog("error: " + e.type);
    if (e.type === "peer-unavailable") {
      const m = /loqui-([a-z0-9]+)/i.exec(e.message || ""); if (m) { const id = m[1].toUpperCase(); if (!isOnline(id)) conns.delete(id); renderAll(); }
      if (call && call.state === "calling") endCall("No está conectado (código " + call.id + ")");
    } else if (e.type === "unavailable-id") {
      // The server still remembers our previous (frozen) session; it frees the code shortly.
      idTakenTries++;
      if (idTakenTries === 6) toast("Otro teléfono está usando tu código. Toca «Tu código» → «Generar un código nuevo»");
      try { p.destroy(); } catch {}
      scheduleRevive(Math.min(15000, 2500 * idTakenTries));
    } else if (["network", "server-error", "socket-error", "socket-closed", "disconnected"].includes(e.type)) {
      open = false; renderAll(); scheduleRevive(2500);
    }
  });
}
function scheduleRevive(ms) { clearTimeout(reviveT); reviveT = setTimeout(revive, ms); }
function revive() {
  if (!me) return;
  if (!peer || peer.destroyed) { peer = null; startPeer(); return; }
  if (peer.disconnected) { try { peer.reconnect(); } catch { try { peer.destroy(); } catch {} peer = null; startPeer(); } }
}
const isOnline = (id) => { const c = conns.get(id); return !!(c && c.open); };
function dropConn(id) { const c = conns.get(id); conns.delete(id); lastSeen.delete(id); try { c && c.close(); } catch {} }
function redialAll(force) { contacts.forEach((c) => connect(c.id, force)); }

function connect(id, force) {
  if (!open || !peer || id === me.id || isOnline(id)) return;
  const t = dialing.get(id) || 0; if (!force && Date.now() - t < 7000) return;   // don't pile up dials
  dialing.set(id, Date.now());
  try { const c = peer.connect(PREFIX + id.toLowerCase(), { reliable: true, metadata: { name: me.name, prev: me.prev || [] } }); c._mine = true; setupConn(c); } catch {}
}
// heartbeat + health check
setInterval(() => {
  if (!me) return;
  if (!peer || peer.destroyed || peer.disconnected) revive();
  const now = Date.now();
  for (const [id] of conns) {
    if (now - (lastSeen.get(id) || now) > DEAD_MS) { dropConn(id); renderAll(); continue; }
    send(id, { t: "ping" });
  }
  if (open) contacts.forEach((c) => { if (!isOnline(c.id)) connect(c.id); });
}, PING_MS);
function onResume() {
  if (!me) return;
  revive();
  const now = Date.now();
  for (const [id] of conns) if (now - (lastSeen.get(id) || 0) > PING_MS * 2) dropConn(id);
  renderAll(); redialAll(true);
}
window.addEventListener("online", onResume);
window.addEventListener("pageshow", onResume);

function setupConn(conn) {
  const id = conn.peer.replace(PREFIX, "").toUpperCase();
  if (me && id === me.id) { try { conn.close(); } catch {} return; }
  conn.on("open", () => {
    const old = conns.get(id);
    if (old && old !== conn && old.open) {
      // Both phones dialed at once: both sides keep the link started by the smaller code.
      const keeper = me.id < id ? me.id : id;
      const initiator = (c) => (c._mine ? me.id : id);
      if (initiator(old) === keeper) { setTimeout(() => { try { conn.close(); } catch {} }, 1500); return; }
      setTimeout(() => { try { old.close(); } catch {} }, 1500);
    }
    conns.set(id, conn); lastSeen.set(id, Date.now());
    // a contact who changed code tells us its old ones: their chat moves to the new code
    const prev = Array.isArray(conn.metadata?.prev) ? conn.metadata.prev : [];
    prev.forEach((p) => { if (typeof p === "string" && CODE_RE.test(p) && p !== id && contact(p)) mergeContact(p, id); });
    if (!contact(id)) {
      const nm = (conn.metadata?.name || id).trim();
      contacts.push({ id, name: nm, unread: 0, last: "", ts: Date.now() }); saveContacts();
      const twin = contacts.find((c) => c.id !== id && c.name.trim().toLowerCase() === nm.toLowerCase() && nm.toLowerCase() !== id.toLowerCase());
      if (twin) askMerge(twin.id, id, nm); else toast(nm + " te agregó");
    }
    conn.send({ t: "hello", name: me.name, prev: me.prev || [] });
    flush(id); renderAll();
  });
  conn.on("data", (d) => onData(id, d));
  conn.on("close", () => { if (conns.get(id) === conn) conns.delete(id); renderAll(); });
  conn.on("error", () => { if (conns.get(id) === conn) conns.delete(id); renderAll(); });
}
const CODE_RE = /^[A-Z0-9]{4,12}$/;
// Move a contact's chat from an old code to a new one (same person, new phone/app/code)
function mergeContact(oldId, newId) {
  const o = contact(oldId); if (!o || oldId === newId) return;
  let n = contact(newId);
  const msgs = msgsOf(oldId).concat(msgsOf(newId)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const seen = new Set(); const merged = msgs.filter((m) => (m.mid && seen.has(m.mid) ? false : (seen.add(m.mid), true)));
  saveMsgs(newId, merged); store.del ? store.del("msgs." + oldId) : store.set("msgs." + oldId, []);
  if (!n) { o.id = newId; n = o; }
  else { n.name = o.name || n.name; n.unread = (n.unread || 0) + (o.unread || 0); n.ts = Math.max(n.ts || 0, o.ts || 0); n.last = n.last || o.last; contacts = contacts.filter((c) => c !== o); }
  dropConn(oldId);
  if (current === oldId) current = newId;
  dlog("contacto " + oldId + " → " + newId);
  saveContacts(); renderAll(); if (current === newId) renderMsgs();
}
function askMerge(oldId, newId, name) {
  setTimeout(() => {
    if (!contact(oldId) || !contact(newId)) return;
    if (confirm("«" + name + "» apareció con un código nuevo (" + newId + ").\n¿Es la misma persona que ya tenías (" + oldId + ")?\n\nAceptar = unir los dos en uno solo, con todo el chat.")) mergeContact(oldId, newId);
  }, 400);
}
function send(id, obj) { const c = conns.get(id); if (c && c.open) { try { c.send(obj); return true; } catch {} } return false; }
function flush(id) {
  const list = msgsOf(id); let changed = false;
  for (const m of list) {
    if (m.from !== "me" || m.status !== "pending") continue;
    if (m.kind) { pushMedia(id, m).then((ok) => ok && setStatus(id, m.mid, "sent")); continue; }
    if (send(id, { t: "msg", mid: m.mid, text: m.text, ts: m.ts })) { m.status = "sent"; changed = true; }
  }
  if (changed) { saveMsgs(id, list); if (current === id) renderMsgs(); }
}
function onData(id, d) {
  if (!d || typeof d !== "object") return;
  lastSeen.set(id, Date.now());
  if (d.t === "ping") return;
  const c = contact(id);
  if (d.t === "hello" && c && typeof d.name === "string") {
    c.name = d.name.slice(0, 40); saveContacts();
    if (Array.isArray(d.prev)) d.prev.forEach((p) => { if (typeof p === "string" && CODE_RE.test(p) && p !== id && contact(p)) mergeContact(p, id); });
    renderAll();
  }
  else if (d.t === "moved" && typeof d.to === "string" && CODE_RE.test(d.to) && d.to !== me.id) { mergeContact(id, d.to); connect(d.to, true); toast((contact(d.to)?.name || d.to) + " cambió su código; ya está actualizado"); }
  else if (d.t === "msg" && typeof d.text === "string") {
    const list = msgsOf(id);
    if (!list.some((m) => m.mid === d.mid)) {
      list.push({ mid: d.mid, from: "them", text: d.text.slice(0, 4000), ts: Date.now() }); saveMsgs(id, list);
      if (c) { c.last = d.text.slice(0, 80); c.ts = Date.now(); if (current !== id || document.hidden) c.unread = (c.unread || 0) + 1; saveContacts(); }
      typingUntil.delete(id);
      if (current === id) renderMsgs(); renderAll();
      if (current !== id || document.hidden) { ping(); notify(c ? c.name : "Loqui", d.text.slice(0, 100)); }
    }
    send(id, { t: "ack", mid: d.mid });
  }
  else if (d.t === "media") { onMedia(id, d); }
  else if (d.t === "ack") {
    const list = msgsOf(id); const m = list.find((x) => x.mid === d.mid);
    if (m) { m.status = "delivered"; saveMsgs(id, list); if (current === id) renderMsgs(); }
  }
  else if (d.t === "typing") { typingUntil.set(id, Date.now() + 3500); renderChatHeader(); setTimeout(renderChatHeader, 3600); }
  else if (d.t === "call-end" || d.t === "call-decline") {
    if (call && call.id === id) endCall(d.t === "call-decline" ? "Llamada rechazada" : "Llamada terminada", true);
  }
}

// ---------------------------------------------------------------- media (photos + voice notes)
// Files live in IndexedDB (much larger than localStorage); messages keep only metadata.
const MAX_MEDIA = 6 * 1024 * 1024;
const MID_RE = /^[a-z0-9]{6,32}$/i;
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("loqui", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("media");
    r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error); };
  }));
  const run = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction("media", mode); const req = fn(t.objectStore("media"));
    t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }); };
  return { put: (k, v) => run("readwrite", (st) => st.put(v, k)), get: (k) => run("readonly", (st) => st.get(k)), del: (k) => run("readwrite", (st) => st.delete(k)) };
})();
const urls = new Map();     // mid -> object URL
const players = new Map();  // mid -> HTMLAudioElement (survives re-renders)
async function mediaUrl(mid) {
  if (urls.has(mid)) return urls.get(mid);
  const rec = await idb.get(mid).catch(() => null); if (!rec || !rec.blob) return null;
  const u = URL.createObjectURL(rec.blob); urls.set(mid, u); return u;
}
function forgetMedia(mid) {
  const u = urls.get(mid); if (u) URL.revokeObjectURL(u); urls.delete(mid);
  const a = players.get(mid); if (a) { a.pause(); players.delete(mid); }
  idb.del(mid).catch(() => {});
}
const fmtDur = (sec) => { sec = Math.max(0, Math.round(sec || 0)); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); };
const preview = (m) => m.kind === "img" ? "📷 Foto" : m.kind === "audio" ? (m.ptt ? "📻 Walkie " : "🎤 Nota de voz ") + fmtDur(m.dur) : (m.text || "");

async function sendMedia(kind, blob, extra) {
  const id = current; if (!id || !blob) return;
  if (blob.size > MAX_MEDIA) return toast("El archivo es demasiado grande");
  const m = Object.assign({ mid: uid(), from: "me", kind, mime: blob.type || "", ts: Date.now(), status: "pending" }, extra);
  try { await idb.put(m.mid, { blob, cid: id }); } catch { return toast("No hay espacio para guardar el archivo"); }
  const list = msgsOf(id); list.push(m); saveMsgs(id, list);
  const c = contact(id); if (c) { c.last = "Tú: " + preview(m); c.ts = m.ts; saveContacts(); }
  if (current === id) renderMsgs(); renderAll();
  if (await pushMedia(id, m)) setStatus(id, m.mid, "sent"); else connect(id);
}
async function pushMedia(id, m) {
  if (!isOnline(id)) return false;
  const rec = await idb.get(m.mid).catch(() => null); if (!rec) return false;
  const data = await rec.blob.arrayBuffer();
  return send(id, { t: "media", mid: m.mid, kind: m.kind, mime: m.mime, dur: m.dur || 0, w: m.w || 0, h: m.h || 0, ptt: !!m.ptt, ts: m.ts, data });
}
function setStatus(id, mid, st) {
  const list = msgsOf(id); const m = list.find((x) => x.mid === mid);
  if (m && m.status !== "delivered") { m.status = st; saveMsgs(id, list); if (current === id) renderMsgs(); }
}
async function onMedia(id, d) {
  if (!MID_RE.test(String(d.mid)) || (d.kind !== "img" && d.kind !== "audio") || !d.data) return;
  const already = msgsOf(id).some((m) => m.mid === d.mid);
  if (!already) {
    const blob = new Blob([d.data], { type: String(d.mime || "").slice(0, 60) });
    if (blob.size > MAX_MEDIA) return;
    try { await idb.put(d.mid, { blob, cid: id }); } catch { return; }
    const list = msgsOf(id);
    if (!list.some((m) => m.mid === d.mid)) {
      const m = { mid: d.mid, from: "them", kind: d.kind, mime: String(d.mime || "").slice(0, 60), dur: Math.min(600, +d.dur || 0), w: +d.w || 0, h: +d.h || 0, ptt: d.ptt === true && d.kind === "audio", ts: Date.now() };
      list.push(m); saveMsgs(id, list);
      const c = contact(id);
      if (c) { c.last = preview(m); c.ts = m.ts; if (current !== id || document.hidden) c.unread = (c.unread || 0) + 1; saveContacts(); }
      if (current === id) renderMsgs(); renderAll();
      if (m.ptt && current === id && !document.hidden) pttEnqueue(m.mid);
      else if (current !== id || document.hidden) { ping(); notify(c ? c.name : "Loqui", (m.ptt ? "📻 " : "") + preview(m)); }
    }
  }
  send(id, { t: "ack", mid: d.mid });
}

// photos
async function compressImage(file) {
  let src, revoke = null;
  try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; revoke = i.src = URL.createObjectURL(file); }); }
  const W = src.width || src.naturalWidth, H = src.height || src.naturalHeight;
  const k = Math.min(1, 1600 / Math.max(W, H)); const w = Math.round(W * k), h = Math.round(H * k);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h; cv.getContext("2d").drawImage(src, 0, 0, w, h);
  if (revoke) URL.revokeObjectURL(revoke);
  const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.8));
  return { blob, w, h };
}
$("btnPhoto").onclick = () => { if (current) $("inPhoto").click(); };
$("inPhoto").onchange = async (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
  try { const { blob, w, h } = await compressImage(f); await sendMedia("img", blob, { w, h }); }
  catch { toast("No se pudo abrir esa imagen"); }
};
function openViewer(u) { $("viewerImg").src = u; $("viewer").hidden = false; }
$("viewer").onclick = () => { $("viewer").hidden = true; $("viewerImg").removeAttribute("src"); };

// voice notes
const AUDIO_TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/aac", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
let rec = null, recTimer = null;
async function startRec(opts = {}) {
  if (rec || call || !current) return;
  if (!window.MediaRecorder) return toast("Este teléfono no permite grabar audio aquí");
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch { if (opts.ptt) pttUI("idle"); return toast("Permite el micrófono para grabar notas de voz"); }
  if (opts.ptt && !pttHeld) { stream.getTracks().forEach((t) => t.stop()); pttUI("idle"); return; }   // released before the mic opened
  const type = AUDIO_TYPES.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  let mr; try { mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 48000 } : undefined); }
  catch { mr = new MediaRecorder(stream); }
  const r = { mr, stream, chunks: [], start: Date.now(), cancel: false, cid: current, ptt: !!opts.ptt };
  rec = r;
  mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
  mr.onstop = async () => {
    r.stream.getTracks().forEach((t) => t.stop());
    clearInterval(recTimer); rec = null;
    if (r.ptt) { pttUI("idle"); beep(660, 0.07, 0, 0.08); } else { $("recBar").hidden = true; showComposer(); }
    const dur = (Date.now() - r.start) / 1000;
    if (r.cancel) return;
    if (dur < (r.ptt ? 0.5 : 0.8)) { pttQueueNext(); return toast(r.ptt ? "Mantén presionado mientras hablas" : "Nota muy corta"); }
    const blob = new Blob(r.chunks, { type: (mr.mimeType || type || "audio/webm").split(";")[0] });
    if (current === r.cid) await sendMedia("audio", blob, r.ptt ? { dur, ptt: true } : { dur });
    pttQueueNext();
  };
  mr.start(250);
  if (r.ptt) { pttUI("talk"); beep(990, 0.06, 0, 0.08); }
  else { $("composer").hidden = true; $("recBar").hidden = false; $("recTime").textContent = "0:00"; }
  recTimer = setInterval(() => {
    const sec = (Date.now() - r.start) / 1000;
    if (r.ptt) $("pttLbl").textContent = "Hablando… " + fmtDur(Math.floor(sec)) + " · suelta para enviar";
    else $("recTime").textContent = fmtDur(Math.floor(sec));
    if (sec >= (r.ptt ? 60 : 180)) stopRec(false);
  }, 250);
  if (navigator.vibrate) navigator.vibrate(30);
}
function stopRec(cancel) { if (!rec) return; rec.cancel = cancel; try { rec.mr.stop(); } catch {} }
$("btnRecCancel").onclick = () => stopRec(true);
$("btnRecSend").onclick = () => stopRec(false);

const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
function voiceBubble(m) {
  const wrap = document.createElement("div"); wrap.className = "vn";
  const btn = document.createElement("button"); btn.setAttribute("aria-label", "Reproducir nota de voz");
  const bar = document.createElement("div"); bar.className = "vbar"; const fill = document.createElement("i"); bar.append(fill);
  const t = document.createElement("span"); t.className = "vt"; t.textContent = fmtDur(m.dur);
  wrap.append(btn, bar, t);
  const paint = () => {
    const a = players.get(m.mid); const playing = a && !a.paused;
    btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    const total = (a && isFinite(a.duration) && a.duration) || m.dur || 0;
    fill.style.width = a && total ? Math.min(100, (a.currentTime / total) * 100) + "%" : "0%";
    t.textContent = a && a.currentTime > 0 ? fmtDur(a.currentTime) : fmtDur(m.dur);
  };
  wrap._paint = paint; wrap.dataset.vn = m.mid; paint();
  btn.onclick = () => { const a = players.get(m.mid); if (a && !a.paused) a.pause(); else playVoice(m.mid); };
  return wrap;
}
async function playVoice(mid, onDone) {
  let a = players.get(mid);
  if (!a) {
    const u = await mediaUrl(mid); if (!u) { toast("Audio no disponible"); return false; }
    a = new Audio(u); a.preload = "auto"; a.playsInline = true; players.set(mid, a);
    const repaint = () => document.querySelectorAll(".vn").forEach((el) => { if (el.dataset.vn === mid && el._paint) el._paint(); });
    a.ontimeupdate = repaint; a.onplay = repaint; a.onpause = repaint;
    a.addEventListener("ended", () => { a.currentTime = 0; repaint(); });
    a.onerror = () => toast("Este teléfono no puede reproducir ese formato de audio");
  }
  players.forEach((o) => { if (o !== a) o.pause(); });
  if (onDone) { const fin = () => { a.removeEventListener("ended", fin); a.removeEventListener("pause", fin); onDone(); }; a.addEventListener("ended", fin); a.addEventListener("pause", fin); }
  try { await a.play(); return true; } catch { if (onDone) onDone(); return false; }
}

// ---------------------------------------------------------------- walkie-talkie
// Hold the big button to talk, release to send. Incoming walkie messages play by themselves
// (with a radio beep) when that chat is open, one after another.
let pttHeld = false, pttBusy = false;
const pttQueue = [];
function pttUI(state) {
  const b = $("btnPtt"); b.classList.toggle("on", state === "talk"); b.classList.toggle("wait", state === "wait");
  $("pttLbl").textContent = state === "talk" ? "Hablando… · suelta para enviar" : state === "wait" ? "Abriendo micrófono…" : state === "listen" ? "Escuchando…" : "Mantén presionado para hablar";
}
function pttEnqueue(mid) { if (!pttQueue.includes(mid)) pttQueue.push(mid); pttQueueNext(); }
function pttQueueNext() {
  if (pttBusy || rec || call || !pttQueue.length) return;
  const mid = pttQueue.shift(); pttBusy = true; pttUI("listen");
  beep(1320, 0.05, 0, 0.07); beep(1760, 0.05, 0.07, 0.07);
  setTimeout(() => playVoice(mid, () => { pttBusy = false; if (!pttHeld) pttUI("idle"); setTimeout(pttQueueNext, 250); }).then((ok) => {
    if (!ok) { pttBusy = false; pttUI("idle"); }
  }), 180);
}
function pttDown(e) {
  e.preventDefault(); if (pttHeld || !current) return;
  try { $("btnPtt").setPointerCapture(e.pointerId); } catch {}
  pttHeld = true; audioCtx();
  players.forEach((a) => a.pause()); pttBusy = false;
  pttUI("wait"); if (navigator.vibrate) navigator.vibrate(25);
  startRec({ ptt: true });
}
function pttUp() { if (!pttHeld) return; pttHeld = false; if (rec && rec.ptt) stopRec(false); else pttUI("idle"); }
$("btnPtt").addEventListener("pointerdown", pttDown);
["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => $("btnPtt").addEventListener(ev, pttUp));
$("btnPtt").addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("visibilitychange", () => { if (document.hidden) pttUp(); });

function showComposer() {
  const c = contact(current); const w = !!(c && c.walkie);
  $("composer").hidden = w; $("pttBar").hidden = !w;
  $("btnWalkie").classList.toggle("on", w); $("btnWalkie").setAttribute("aria-pressed", String(w));
}
$("btnWalkie").onclick = () => {
  const c = contact(current); if (!c) return;
  c.walkie = !c.walkie; saveContacts(); showComposer();
  toast(c.walkie ? "📻 Modo walkie activado: mantén presionado para hablar" : "Modo walkie desactivado");
};
function photoBubble(m, box) {
  const img = document.createElement("img"); img.className = "ph"; img.alt = "Foto";
  if (m.w && m.h) img.style.aspectRatio = m.w + " / " + m.h;
  mediaUrl(m.mid).then((u) => {
    if (!u) { img.alt = "Foto no disponible"; return; }
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
    img.onload = () => { if (near) box.scrollTop = box.scrollHeight; };
    img.src = u; img.onclick = () => openViewer(u);
  });
  return img;
}

// ---------------------------------------------------------------- messages
function addSystem(id, text) { const list = msgsOf(id); list.push({ mid: uid(), from: "sys", text, ts: Date.now() }); saveMsgs(id, list); if (current === id) renderMsgs(); }
function sendMessage() {
  const ta = $("inMsg"); const text = ta.value.trim(); if (!text || !current) return;
  const m = { mid: uid(), from: "me", text, ts: Date.now(), status: "pending" };
  if (send(current, { t: "msg", mid: m.mid, text, ts: m.ts })) m.status = "sent";
  else connect(current);
  const list = msgsOf(current); list.push(m); saveMsgs(current, list);
  const c = contact(current); if (c) { c.last = "Tú: " + text.slice(0, 70); c.ts = m.ts; saveContacts(); }
  ta.value = ""; autosize(); renderMsgs();
}

// ---------------------------------------------------------------- calls
let call = null;   // {id, media, stream, state, start, timer, muted}
async function micStream() {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
}
function callUI(id, state, incoming) {
  const c = contact(id) || { id, name: id };
  $("callAv").textContent = ""; avatar($("callAv"), c); $("callName").textContent = c.name;
  $("callState").textContent = state; $("callView").hidden = false;
  $("callIncoming").hidden = !incoming; $("callActive").hidden = incoming;
  $("callAv").classList.toggle("ring", state !== "connected");
}
// Keep the screen on during a call: when the phone locks itself (after 30 s - 2 min),
// the browser freezes the app and the call drops. Re-taken when the app comes back.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && call && "wakeLock" in navigator && document.visibilityState === "visible") {
      if (!wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); dlog("pantalla encendida: ok"); wakeLock.addEventListener("release", () => { wakeLock = null; }); }
    } else if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch (e) { wakeLock = null; if (on) dlog("pantalla encendida: NO (" + (e && e.name) + ")"); }
}
if (!("wakeLock" in navigator)) dlog("este navegador no permite mantener la pantalla encendida");
document.addEventListener("visibilitychange", () => { if (call) dlog(document.hidden ? "app oculta / pantalla apagada" : "app visible"); });
window.addEventListener("offline", () => dlog("sin internet"));
window.addEventListener("online", () => dlog("internet de vuelta"));
// every 5 s during a call: which path the audio takes (direct / relay), delay, and whether audio still arrives
function watchStats(c) {
  let lastBytes = -1, lastPath = "", n = 0;
  const tick = async () => {
    if (call !== c) return;
    const pc = c.media && c.media.peerConnection;
    if (pc && !c.reconnecting) try {
      const st = await pc.getStats(); let pair = null, bytes = 0, lost = 0; const cand = {};
      st.forEach((r) => { if (r.type === "candidate-pair" && (r.nominated || r.selected) && r.state === "succeeded") pair = r;
        if (r.type === "local-candidate" || r.type === "remote-candidate") cand[r.id] = r;
        if (r.type === "inbound-rtp" && r.kind === "audio") { bytes = r.bytesReceived || 0; lost = r.packetsLost || 0; } });
      const lc = pair && cand[pair.localCandidateId], rc = pair && cand[pair.remoteCandidateId];
      const path = lc ? (lc.candidateType + "/" + (lc.protocol || "") + " → " + (rc ? rc.candidateType : "?")) : "sin ruta";
      const rtt = pair && pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) + " ms" : "?";
      if (path !== lastPath) { dlog("ruta: " + path + " · retardo " + rtt); lastPath = path; }
      else if (++n % 6 === 0) dlog("ok · retardo " + rtt + " · perdidos " + lost);
      if (lastBytes >= 0 && bytes === lastBytes) dlog("¡audio detenido! (no llega sonido)");
      lastBytes = bytes;
    } catch {}
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 3000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && call) { keepAwake(true); if (call.state === "connected") checkCallPath(); } });
async function startCall(id) {
  if (call) return;
  if (!open) return toast("Sin conexión con el servidor. Revisa internet.");
  call = { id, state: "calling", muted: false };
  callUI(id, "Llamando…", false); ring(true, true); keepAwake(true);
  try { call.stream = await micStream(); }
  catch { endCall("No se pudo usar el micrófono"); return toast("Permite el micrófono para llamar"); }
  if (!call) return;
  dlog("llamando a " + id);
  const media = peer.call(PREFIX + id.toLowerCase(), call.stream, { metadata: { name: me.name } });
  call.media = media; wireMedia(media);
  call.timeout = setTimeout(() => { if (call && call.state === "calling") { send(id, { t: "call-end" }); endCall("No contesta"); } }, 45000);
}
function onIncomingCall(media) {
  const id = media.peer.replace(PREFIX, "").toUpperCase();
  dlog("llamada entrante de " + id + (media.metadata && media.metadata.reconnect ? " (reconexión)" : ""));
  if (call && call.reconnecting && call.id === id) {          // same call coming back after a drop
    if (call.media && me.id < id) { media.close(); return; }  // both redialed at once: mine wins
    try { call.media && call.media.close(); } catch {}
    call.media = media; media.answer(call.stream); wireMedia(media); return;
  }
  if (media.metadata && media.metadata.reconnect) { media.close(); return; }   // that call already ended here
  if (call) { media.close(); return; }      // busy
  if (!contact(id)) { contacts.push({ id, name: media.metadata?.name || id, unread: 0, last: "", ts: Date.now() }); saveContacts(); renderAll(); }
  call = { id, media, state: "ringing", muted: false, incoming: true };
  callUI(id, "Llamada de voz entrante", true); ring(true, false);
  notify(contact(id)?.name || "Loqui", "Llamada de voz entrante");
  call.timeout = setTimeout(() => { if (call && call.state === "ringing") { addSystem(id, "Llamada perdida · " + fmtTime(Date.now())); endCall("Llamada perdida"); } }, 45000);
}
async function acceptCall() {
  if (!call || call.state !== "ringing") return;
  ring(false); $("callState").textContent = "Conectando…";
  try { call.stream = await micStream(); }
  catch { send(call.id, { t: "call-decline" }); endCall("No se pudo usar el micrófono"); return toast("Permite el micrófono para contestar"); }
  call.media.answer(call.stream); wireMedia(call.media); keepAwake(true);
  $("callIncoming").hidden = true; $("callActive").hidden = false;
}
function declineCall() { if (!call) return; send(call.id, { t: "call-decline" }); addSystem(call.id, "Llamada rechazada · " + fmtTime(Date.now())); endCall("Llamada rechazada"); }
function wireMedia(media) {
  media.on("stream", (remote) => {
    playRemote(remote);
    if (!call) return;
    if (call.reconnecting) { dlog("RECONECTADA tras " + Math.round((Date.now() - (call.dropT || Date.now())) / 1000) + " s"); stopReconnect(); toast("Llamada reconectada"); return; }
    if (call.state === "connected") return;
    clearTimeout(call.timeout); ring(false);
    call.state = "connected"; call.start = Date.now(); dlog("llamada conectada"); watchStats(call);
    callUI(call.id, "00:00", false);
    call.timer = setInterval(() => { if (call) $("callState").textContent = call.reconnecting || call.weak ? "Reconectando…" : dur(Date.now() - call.start); }, 1000);
  });
  media.on("close", () => { if (call && call.media === media) dropped("Llamada terminada"); });
  media.on("error", () => { if (call && call.media === media) dropped("Se cortó la llamada"); });
  // watch the network path: brief "disconnected" usually heals by itself; "failed" means rebuild
  const watch = () => {
    const pc = media.peerConnection; if (!pc) return setTimeout(watch, 300);
    pc.addEventListener("iceconnectionstatechange", () => {
      if (!call || call.media !== media) return;
      const st = pc.iceConnectionState;
      dlog("ruta de audio: " + st);
      clearTimeout(media._weakT);
      if (st === "disconnected") { call.weak = true; media._weakT = setTimeout(() => { if (call && call.media === media && pc.iceConnectionState !== "connected" && pc.iceConnectionState !== "completed") dropped("Se cortó la llamada"); }, 4000); }
      else if (st === "connected" || st === "completed") call.weak = false;
      else if (st === "failed" || st === "closed") dropped("Se cortó la llamada");
    });
  };
  watch();
}
// A connected call that drops (network change, weak signal) is rebuilt automatically for
// up to 25 s. Both phones keep the call screen; the one with the smaller code redials.
function dropped(msg) {
  if (!call) return;
  if (call.state !== "connected") return endCall(msg);
  if (call.reconnecting) return;
  const c = call; c.reconnecting = true; c.weak = false; c.dropT = Date.now();
  dlog("CORTE (" + msg + ") a los " + dur(Date.now() - c.start) + " · pantalla " + (document.hidden ? "oculta" : "visible") + " · " + (navigator.onLine ? "online" : "OFFLINE") + " · servidor " + (open ? "ok" : "caído"));
  try { c.media && c.media.close(); } catch {}
  c.media = null; $("callState").textContent = "Reconectando…";
  c.giveUp = setTimeout(() => { if (call === c && c.reconnecting) endCall("Se cortó la llamada"); }, 45000);
  const t0 = Date.now();
  const tryCall = () => {
    if (call !== c || !c.reconnecting) return;
    if (!open) revive();
    const iRedial = me.id < c.id || Date.now() - t0 > 10000;
    if (iRedial && open && !c.media) {
      dlog("rellamando…");
      try { const m = peer.call(PREFIX + c.id.toLowerCase(), c.stream, { metadata: { name: me.name, reconnect: true } }); c.media = m; wireMedia(m);
        setTimeout(() => { if (call === c && c.reconnecting && c.media === m) { try { m.close(); } catch {} c.media = null; } }, 6000); } catch {}
    }
    c.retry = setTimeout(tryCall, 4000);
  };
  c.retry = setTimeout(tryCall, 1200);   // give an explicit "colgó" message time to arrive first
  connect(c.id, true);
}
function checkCallPath() {
  if (!call || call.state !== "connected" || call.reconnecting) return;
  const pc = call.media && call.media.peerConnection, st = pc && pc.iceConnectionState;
  if (!pc || st === "failed" || st === "closed" || st === "disconnected") dropped("Se cortó la llamada");
}
window.addEventListener("online", () => setTimeout(checkCallPath, 800));
function stopReconnect() { if (!call) return; call.reconnecting = false; call.weak = false; clearTimeout(call.giveUp); clearTimeout(call.retry); }
// Remote voice goes through a gain + limiter so it is clearly louder than the phone's
// default call level, without distorting. The <audio> element stays attached (muted)
// because some browsers only deliver WebRTC audio to Web Audio while it is playing.
let vol = Number(store.get("vol", 2.5)) || 2.5, boostNode = null, boostSrc = null;
function playRemote(remote) {
  const a = $("remoteAudio"); a.srcObject = remote;
  const c = audioCtx();
  if (c && c.createMediaStreamSource) {
    try {
      stopBoost();
      boostSrc = c.createMediaStreamSource(remote);
      boostNode = c.createGain(); boostNode.gain.value = vol;
      const lim = c.createDynamicsCompressor();
      lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.15;
      boostSrc.connect(boostNode).connect(lim).connect(c.destination);
      a.muted = true;
    } catch { a.muted = false; a.volume = 1; }
  }
  a.play().catch(() => {});
  updateVol(); $("volBox").hidden = false;
}
function stopBoost() { try { boostSrc && boostSrc.disconnect(); } catch {} try { boostNode && boostNode.disconnect(); } catch {} boostSrc = boostNode = null; }
function updateVol() {
  $("volRange").value = vol; $("volLbl").textContent = "x" + vol.toFixed(1).replace(".", ",");
  if (boostNode) boostNode.gain.setTargetAtTime(vol, boostNode.context.currentTime, 0.05);
  else { const a = $("remoteAudio"); a.volume = Math.min(1, vol / 2.5); }
}
$("volRange").addEventListener("input", (e) => { vol = Number(e.target.value); store.set("vol", vol); updateVol(); });
const dur = (ms) => { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
function hangUp() { if (!call) return; send(call.id, { t: "call-end" }); endCall("Llamada terminada"); }
function endCall(msg, remote) {
  if (!call) return;
  const c = call; call = null; keepAwake(false);
  dlog("fin: " + (msg || "") + (c.start ? " · duró " + dur(Date.now() - c.start) : ""));
  ring(false); clearTimeout(c.timeout); clearInterval(c.timer); clearTimeout(c.giveUp); clearTimeout(c.retry);
  if (c.start) addSystem(c.id, "Llamada de voz · " + dur(Date.now() - c.start));
  else if (!c.incoming && msg !== "Llamada terminada") addSystem(c.id, msg + " · " + fmtTime(Date.now()));
  try { c.media && c.media.close(); } catch {}
  try { c.stream && c.stream.getTracks().forEach((t) => t.stop()); } catch {}
  stopBoost(); $("volBox").hidden = true; $("remoteAudio").srcObject = null; $("remoteAudio").muted = false;
  $("callState").textContent = msg || "Llamada terminada"; $("callIncoming").hidden = true; $("callActive").hidden = true;
  setTimeout(() => { if (!call) $("callView").hidden = true; }, remote ? 1400 : 900);
}
function toggleMute() {
  if (!call || !call.stream) return;
  call.muted = !call.muted; call.stream.getAudioTracks().forEach((t) => (t.enabled = !call.muted));
  $("btnMute").classList.toggle("on", call.muted); $("muteLbl").textContent = call.muted ? "Silenciado" : "Silenciar";
}

// ---------------------------------------------------------------- render
function renderAll() { renderContacts(); renderChatHeader(); $("myCode").textContent = me ? me.id : "—"; }
function renderContacts() {
  const box = $("contactList"); box.textContent = "";
  if (!contacts.length) {
    const e = document.createElement("div"); e.className = "empty";
    const h = document.createElement("h2"); h.textContent = "Todavía no tienes contactos";
    const p = document.createElement("p"); p.textContent = "Comparte tu código " + me.id + " o tu enlace, o toca + para agregar a alguien con su código.";
    const b = document.createElement("button"); b.className = "primary"; b.textContent = "Compartir mi código"; b.onclick = openCode;
    e.append(h, p, b); box.append(e); return;
  }
  [...contacts].sort((a, b) => (b.ts || 0) - (a.ts || 0)).forEach((c) => {
    const r = document.createElement("button"); r.className = "row";
    const av = document.createElement("div"); av.className = "av"; avatar(av, c, isOnline(c.id));
    const main = document.createElement("div"); main.className = "rowmain";
    const top = document.createElement("div"); top.className = "rowtop";
    const n = document.createElement("span"); n.className = "rowname"; n.textContent = c.name;
    const t = document.createElement("span"); t.className = "rowtime"; t.textContent = c.ts && c.last ? fmtTime(c.ts) : "";
    top.append(n, t);
    const last = document.createElement("div"); last.className = "rowlast"; last.textContent = c.last || (isOnline(c.id) ? "En línea" : "Código " + c.id);
    main.append(top, last); r.append(av, main);
    if (c.unread) { const b = document.createElement("span"); b.className = "badge"; b.textContent = c.unread; r.append(b); }
    // tap opens the chat; press and hold (or right-click) opens rename/delete
    let holdT = null, held = false;
    r.addEventListener("pointerdown", () => { held = false; holdT = setTimeout(() => { held = true; if (navigator.vibrate) navigator.vibrate(25); openInfo(c.id); }, 550); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => r.addEventListener(ev, () => clearTimeout(holdT)));
    r.addEventListener("contextmenu", (e) => { e.preventDefault(); clearTimeout(holdT); if (!held) { held = true; openInfo(c.id); } });
    r.onclick = () => { if (held) { held = false; return; } openChat(c.id); };
    box.append(r);
  });
}
function renderChatHeader() {
  if (!current) return; const c = contact(current); if (!c) return;
  $("chatAv").textContent = ""; avatar($("chatAv"), c); $("chatName").textContent = c.name;
  const st = $("chatStatus");
  if ((typingUntil.get(current) || 0) > Date.now()) { st.textContent = "escribiendo…"; st.className = "on"; }
  else if (isOnline(current)) { st.textContent = "en línea"; st.className = "on"; }
  else { st.textContent = open ? "no conectado · código " + current : "sin servidor · revisa internet"; st.className = ""; }
}
function renderMsgs() {
  const box = $("msgs"); const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.textContent = ""; let lastDay = "";
  for (const m of msgsOf(current)) {
    const day = fmtDay(m.ts); if (day !== lastDay) { const d = document.createElement("div"); d.className = "day"; d.textContent = day; box.append(d); lastDay = day; }
    if (m.from === "sys") { const s = document.createElement("div"); s.className = "sys"; s.textContent = m.text; box.append(s); continue; }
    const b = document.createElement("div"); b.className = "b" + (m.from === "me" ? " me" : "") + (m.kind ? " media" : "") + (m.ptt ? " pttmsg" : "");
    if (m.kind === "img") b.append(photoBubble(m, box));
    else if (m.kind === "audio") b.append(voiceBubble(m));
    else b.textContent = m.text;
    const meta = document.createElement("span"); meta.className = "meta";
    meta.textContent = fmtTime(m.ts) + (m.from === "me" ? (m.status === "delivered" ? " ✓✓" : m.status === "sent" ? " ✓" : " ⏱") : "");
    b.append(meta); box.append(b);
  }
  if (atBottom || true) box.scrollTop = box.scrollHeight;
}
function openChat(id) {
  current = id; const c = contact(id); if (c) { c.unread = 0; saveContacts(); }
  pttQueue.length = 0; pttBusy = false;
  show("sChat"); showComposer(); renderChatHeader(); renderMsgs(); connect(id);
  try { location.hash = "chat-" + id; } catch {}
}
function closeChat() { pttHeld = false; pttQueue.length = 0; stopRec(true); players.forEach((a) => a.pause()); current = null; show("sHome"); renderAll(); try { history.replaceState(null, "", location.pathname); } catch {} }

// ---------------------------------------------------------------- dialogs
const shareLink = () => location.origin + location.pathname + "#add=" + me.id + "&n=" + encodeURIComponent(me.name);
function openCode() { newCodeArmed = false; $("btnNewCode").textContent = "Generar un código nuevo"; $("bigCode").textContent = me.id; $("myLink").value = shareLink(); $("dlgCode").hidden = false; }
function openAdd(code = "", name = "") { $("inCode").value = code; $("inCName").value = name; $("dlgAdd").hidden = false; setTimeout(() => $("inCode").focus(), 50); }
function addContact() {
  const id = cleanCode($("inCode").value); const name = $("inCName").value.trim().slice(0, 40);
  if (id.length < 4) return toast("Escribe un código válido");
  if (id === me.id) return toast("Ese es tu propio código");
  let c = contact(id);
  if (!c) { c = { id, name: name || id, unread: 0, last: "", ts: Date.now() }; contacts.push(c); saveContacts(); }
  else if (name) { c.name = name; saveContacts(); }
  $("dlgAdd").hidden = true; connect(id); renderAll(); openChat(id);
}
// contact info: rename / delete (tap the name in the chat header)
let delArmed = false, infoId = null;
function openInfo(id) {
  infoId = typeof id === "string" ? id : current;
  const c = contact(infoId); if (!c) return;
  $("infoCode").textContent = c.id; $("infoName").value = c.name;
  delArmed = false; $("btnDel").textContent = "Eliminar contacto y chat";
  $("dlgInfo").hidden = false;
}
$("chatWho").onclick = openInfo;
$("chatWho").onkeydown = (e) => { if (e.key === "Enter") openInfo(); };
$("btnInfoSave").onclick = () => {
  const c = contact(infoId); const n = $("infoName").value.trim().slice(0, 40);
  if (c && n) { c.name = n; saveContacts(); renderAll(); }
  $("dlgInfo").hidden = true;
};
$("btnDel").onclick = () => {
  if (!delArmed) { delArmed = true; $("btnDel").textContent = "Toca otra vez para confirmar"; return; }
  const id = infoId; $("dlgInfo").hidden = true;
  dropConn(id); contacts = contacts.filter((c) => c.id !== id); saveContacts();
  msgsOf(id).forEach((m) => { if (m.kind) forgetMedia(m.mid); });
  try { localStorage.removeItem("loqui.msgs." + id); } catch {}
  if (current === id) closeChat(); else renderAll();
  toast("Contacto eliminado");
};
document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => (b.closest(".veil").hidden = true)));
document.querySelectorAll(".veil").forEach((v) => v.addEventListener("click", (e) => { if (e.target === v) v.hidden = true; }));

// ---------------------------------------------------------------- wiring
function autosize() { const ta = $("inMsg"); ta.style.height = "auto"; ta.style.height = Math.min(140, ta.scrollHeight) + "px"; }
$("inMsg").addEventListener("input", () => { autosize(); if (current && Date.now() - (window._lastTyping || 0) > 2000) { window._lastTyping = Date.now(); send(current, { t: "typing" }); } });
$("inMsg").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); sendMessage(); syncSendBtn(); } });
function syncSendBtn() {
  const has = $("inMsg").value.trim().length > 0;
  $("icoSend").hidden = !has; $("icoMic").hidden = has;
  $("btnSend").setAttribute("aria-label", has ? "Enviar" : "Grabar nota de voz");
}
$("btnSend").onclick = () => { if ($("inMsg").value.trim()) { sendMessage(); syncSendBtn(); } else startRec(); };
$("inMsg").addEventListener("input", syncSendBtn);
$("btnBack").onclick = closeChat;
$("btnCall").onclick = () => current && startCall(current);
$("btnAdd").onclick = () => openAdd();
$("btnAddOk").onclick = addContact;
$("btnMyCode").onclick = openCode;
$("btnCopyLink").onclick = async () => {
  const link = shareLink();
  if (navigator.share) { try { await navigator.share({ title: "Loqui", text: "Vuélvete Loqui 🐾 Háblame por Loqui, sin número de teléfono. Mi código es " + me.id, url: link }); return; } catch {} }
  try { await navigator.clipboard.writeText(link); toast("Enlace copiado"); } catch { $("myLink").select(); toast("Selecciona y copia el enlace"); }
};
// New identity: for when two phones ended up with the same code. Contacts and chats stay.
let newCodeArmed = false;
$("btnDiag").onclick = async () => {
  const text = "Loqui v15 diagnóstico · " + navigator.userAgent + "\n" + diag.slice(-150).join("\n");
  try { if (navigator.share) { await navigator.share({ title: "Loqui diagnóstico", text }); return; } } catch {}
  try { await navigator.clipboard.writeText(text); toast("Diagnóstico copiado: pégalo en un chat"); } catch { toast("No se pudo copiar"); }
};
$("btnNewCode").onclick = () => {
  if (!newCodeArmed) { newCodeArmed = true; $("btnNewCode").textContent = "Toca otra vez: tus contactos tendrán que agregarte de nuevo"; return; }
  newCodeArmed = false; $("btnNewCode").textContent = "Generar un código nuevo";
  const oldId = me.id, nid = newCode();
  conns.forEach((c, id) => send(id, { t: "moved", to: nid }));        // contacts online now update by themselves
  const prevs = (me.prev || []).concat(oldId).slice(-5);              // the rest learn it when we reconnect
  me = { id: nid, name: me.name, prev: prevs }; store.set("me", me);
  const oldPeer = peer; peer = null; open = false;
  setTimeout(() => { conns.forEach((c, id) => { if (!c.provider || c.provider === oldPeer) dropConn(id); }); try { oldPeer && oldPeer.destroy(); } catch {} startPeer(); renderAll(); }, 700);
  renderAll();
  $("bigCode").textContent = me.id; $("myLink").value = shareLink();
  toast("Tu código nuevo es " + me.id + ". Tus contactos se actualizan solos al conectarse");
};
$("btnNotif").onclick = async () => {
  if (!("Notification" in window)) return toast("Este navegador no permite avisos. En iPhone, instala Loqui en la pantalla de inicio.");
  const p = await Notification.requestPermission(); toast(p === "granted" ? "Avisos activados" : "Avisos no permitidos");
};
$("btnAccept").onclick = acceptCall; $("btnDecline").onclick = declineCall;
$("btnHang").onclick = hangUp; $("btnMute").onclick = toggleMute;
$("btnStart").onclick = () => {
  const name = $("inName").value.trim().slice(0, 40); if (!name) return toast("Escribe tu nombre");
  me = { id: newCode(), name }; store.set("me", me); boot();
};
$("inName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnStart").click(); });
window.addEventListener("hashchange", handleHash);
document.addEventListener("visibilitychange", () => { if (!document.hidden && current) { const c = contact(current); if (c) { c.unread = 0; saveContacts(); } } if (!document.hidden) onResume(); });

function handleHash() {
  const h = location.hash.slice(1); if (!h || !me) return;
  const p = new URLSearchParams(h);
  if (p.get("add")) { const code = cleanCode(p.get("add")); history.replaceState(null, "", location.pathname); if (code && code !== me.id) openAdd(code, (p.get("n") || "").slice(0, 40)); }
}
function boot() {
  if (!me) { show("sOnboard"); return; }
  show("sHome"); renderAll(); startPeer(); handleHash();
}
// Updates: check for a new version whenever the app comes back, and switch to it right away.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    const go = () => { if (call) return setTimeout(go, 5000); reloaded = true; location.reload(); };
    go();
  });
  const checkUpdate = () => navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });
  setInterval(checkUpdate, 10 * 60 * 1000);
}
setInterval(() => { const n = $("netLbl"); if (n) n.textContent = open ? "servidor conectado ✓" : "sin servidor ✗"; }, 1000);
boot();
})();
