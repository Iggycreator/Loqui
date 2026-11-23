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

function startPeer() {
  if (peer) return;
  peer = new Peer(PREFIX + me.id.toLowerCase(), { debug: 0 });
  peer.on("open", () => { open = true; renderAll(); contacts.forEach((c) => connect(c.id)); });
  peer.on("connection", (conn) => setupConn(conn));
  peer.on("call", onIncomingCall);
  peer.on("disconnected", () => { open = false; renderAll(); setTimeout(() => { try { peer.reconnect(); } catch {} }, 2500); });
  peer.on("error", (e) => {
    if (e.type === "peer-unavailable") {
      const m = /loqui-([a-z0-9]+)/i.exec(e.message || ""); if (m) { conns.delete(m[1].toUpperCase()); renderAll(); }
      if (call && call.state === "calling") endCall("No contesta o no está conectado");
    } else if (e.type === "unavailable-id") {
      toast("Loqui ya está abierto en otra pestaña o dispositivo con tu código");
    } else if (e.type === "network" || e.type === "server-error" || e.type === "socket-error") {
      open = false; renderAll();
    }
  });
  setInterval(() => { if (open) contacts.forEach((c) => { if (!isOnline(c.id)) connect(c.id); }); }, 20000);
}
const isOnline = (id) => { const c = conns.get(id); return !!(c && c.open); };

function connect(id) {
  if (!open || isOnline(id) || id === me.id) return;
  try { setupConn(peer.connect(PREFIX + id.toLowerCase(), { reliable: true, metadata: { name: me.name } })); } catch {}
}
function setupConn(conn) {
  const id = conn.peer.replace(PREFIX, "").toUpperCase();
  conn.on("open", () => {
    conns.set(id, conn);
    if (!contact(id)) { contacts.push({ id, name: conn.metadata?.name || id, unread: 0, last: "", ts: Date.now() }); saveContacts(); toast((conn.metadata?.name || id) + " te agregó"); }
    conn.send({ t: "hello", name: me.name });
    flush(id); renderAll();
  });
  conn.on("data", (d) => onData(id, d));
  conn.on("close", () => { if (conns.get(id) === conn) conns.delete(id); renderAll(); });
  conn.on("error", () => { if (conns.get(id) === conn) conns.delete(id); renderAll(); });
}
function send(id, obj) { const c = conns.get(id); if (c && c.open) { try { c.send(obj); return true; } catch {} } return false; }
function flush(id) {
  const list = msgsOf(id); let changed = false;
  for (const m of list) if (m.from === "me" && m.status === "pending" && send(id, { t: "msg", mid: m.mid, text: m.text, ts: m.ts })) { m.status = "sent"; changed = true; }
  if (changed) { saveMsgs(id, list); if (current === id) renderMsgs(); }
}
function onData(id, d) {
  if (!d || typeof d !== "object") return;
  const c = contact(id);
  if (d.t === "hello" && c && typeof d.name === "string") { c.name = d.name.slice(0, 40); saveContacts(); renderAll(); }
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
  else if (d.t === "ack") {
    const list = msgsOf(id); const m = list.find((x) => x.mid === d.mid);
    if (m) { m.status = "delivered"; saveMsgs(id, list); if (current === id) renderMsgs(); }
  }
  else if (d.t === "typing") { typingUntil.set(id, Date.now() + 3500); renderChatHeader(); setTimeout(renderChatHeader, 3600); }
  else if (d.t === "call-end" || d.t === "call-decline") {
    if (call && call.id === id) endCall(d.t === "call-decline" ? "Llamada rechazada" : "Llamada terminada", true);
  }
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
async function startCall(id) {
  if (call) return;
  if (!open) return toast("Sin conexión con el servidor. Revisa internet.");
  call = { id, state: "calling", muted: false };
  callUI(id, "Llamando…", false); ring(true, true);
  try { call.stream = await micStream(); }
  catch { endCall("No se pudo usar el micrófono"); return toast("Permite el micrófono para llamar"); }
  if (!call) return;
  const media = peer.call(PREFIX + id.toLowerCase(), call.stream, { metadata: { name: me.name } });
  call.media = media; wireMedia(media);
  call.timeout = setTimeout(() => { if (call && call.state === "calling") { send(id, { t: "call-end" }); endCall("No contesta"); } }, 45000);
}
function onIncomingCall(media) {
  const id = media.peer.replace(PREFIX, "").toUpperCase();
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
  call.media.answer(call.stream); wireMedia(call.media);
  $("callIncoming").hidden = true; $("callActive").hidden = false;
}
function declineCall() { if (!call) return; send(call.id, { t: "call-decline" }); addSystem(call.id, "Llamada rechazada · " + fmtTime(Date.now())); endCall("Llamada rechazada"); }
function wireMedia(media) {
  media.on("stream", (remote) => {
    const a = $("remoteAudio"); a.srcObject = remote; a.play().catch(() => {});
    if (!call || call.state === "connected") return;
    clearTimeout(call.timeout); ring(false);
    call.state = "connected"; call.start = Date.now();
    callUI(call.id, "00:00", false);
    call.timer = setInterval(() => { if (call) $("callState").textContent = dur(Date.now() - call.start); }, 1000);
  });
  media.on("close", () => { if (call && call.media === media) endCall("Llamada terminada"); });
  media.on("error", () => { if (call && call.media === media) endCall("Se cortó la llamada"); });
}
const dur = (ms) => { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
function hangUp() { if (!call) return; send(call.id, { t: "call-end" }); endCall("Llamada terminada"); }
function endCall(msg, remote) {
  if (!call) return;
  const c = call; call = null;
  ring(false); clearTimeout(c.timeout); clearInterval(c.timer);
  if (c.start) addSystem(c.id, "Llamada de voz · " + dur(Date.now() - c.start));
  else if (!c.incoming && msg !== "Llamada terminada") addSystem(c.id, msg + " · " + fmtTime(Date.now()));
  try { c.media && c.media.close(); } catch {}
  try { c.stream && c.stream.getTracks().forEach((t) => t.stop()); } catch {}
  $("remoteAudio").srcObject = null;
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
    r.onclick = () => openChat(c.id);
    box.append(r);
  });
}
function renderChatHeader() {
  if (!current) return; const c = contact(current); if (!c) return;
  $("chatAv").textContent = ""; avatar($("chatAv"), c); $("chatName").textContent = c.name;
  const st = $("chatStatus");
  if ((typingUntil.get(current) || 0) > Date.now()) { st.textContent = "escribiendo…"; st.className = "on"; }
  else if (isOnline(current)) { st.textContent = "en línea"; st.className = "on"; }
  else { st.textContent = open ? "desconectado · se enviará al conectarse" : "sin conexión"; st.className = ""; }
}
function renderMsgs() {
  const box = $("msgs"); const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.textContent = ""; let lastDay = "";
  for (const m of msgsOf(current)) {
    const day = fmtDay(m.ts); if (day !== lastDay) { const d = document.createElement("div"); d.className = "day"; d.textContent = day; box.append(d); lastDay = day; }
    if (m.from === "sys") { const s = document.createElement("div"); s.className = "sys"; s.textContent = m.text; box.append(s); continue; }
    const b = document.createElement("div"); b.className = "b" + (m.from === "me" ? " me" : ""); b.textContent = m.text;
    const meta = document.createElement("span"); meta.className = "meta";
    meta.textContent = fmtTime(m.ts) + (m.from === "me" ? (m.status === "delivered" ? " ✓✓" : m.status === "sent" ? " ✓" : " ⏱") : "");
    b.append(meta); box.append(b);
  }
  if (atBottom || true) box.scrollTop = box.scrollHeight;
}
function openChat(id) {
  current = id; const c = contact(id); if (c) { c.unread = 0; saveContacts(); }
  show("sChat"); renderChatHeader(); renderMsgs(); connect(id);
  try { location.hash = "chat-" + id; } catch {}
}
function closeChat() { current = null; show("sHome"); renderAll(); try { history.replaceState(null, "", location.pathname); } catch {} }

// ---------------------------------------------------------------- dialogs
const shareLink = () => location.origin + location.pathname + "#add=" + me.id + "&n=" + encodeURIComponent(me.name);
function openCode() { $("bigCode").textContent = me.id; $("myLink").value = shareLink(); $("dlgCode").hidden = false; }
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
document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => (b.closest(".veil").hidden = true)));
document.querySelectorAll(".veil").forEach((v) => v.addEventListener("click", (e) => { if (e.target === v) v.hidden = true; }));

// ---------------------------------------------------------------- wiring
function autosize() { const ta = $("inMsg"); ta.style.height = "auto"; ta.style.height = Math.min(140, ta.scrollHeight) + "px"; }
$("inMsg").addEventListener("input", () => { autosize(); if (current && Date.now() - (window._lastTyping || 0) > 2000) { window._lastTyping = Date.now(); send(current, { t: "typing" }); } });
$("inMsg").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); sendMessage(); } });
$("btnSend").onclick = sendMessage;
$("btnBack").onclick = closeChat;
$("btnCall").onclick = () => current && startCall(current);
$("btnAdd").onclick = () => openAdd();
$("btnAddOk").onclick = addContact;
$("btnMyCode").onclick = openCode;
$("btnCopyLink").onclick = async () => {
  const link = shareLink();
  if (navigator.share) { try { await navigator.share({ title: "Loqui", text: "Háblame por Loqui, mi código es " + me.id, url: link }); return; } catch {} }
  try { await navigator.clipboard.writeText(link); toast("Enlace copiado"); } catch { $("myLink").select(); toast("Selecciona y copia el enlace"); }
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
document.addEventListener("visibilitychange", () => { if (!document.hidden && current) { const c = contact(current); if (c) { c.unread = 0; saveContacts(); } } if (!document.hidden && peer && peer.disconnected) try { peer.reconnect(); } catch {} });

function handleHash() {
  const h = location.hash.slice(1); if (!h || !me) return;
  const p = new URLSearchParams(h);
  if (p.get("add")) { const code = cleanCode(p.get("add")); history.replaceState(null, "", location.pathname); if (code && code !== me.id) openAdd(code, (p.get("n") || "").slice(0, 40)); }
}
function boot() {
  if (!me) { show("sOnboard"); return; }
  show("sHome"); renderAll(); startPeer(); handleHash();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
})();
