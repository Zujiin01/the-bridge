"use strict";
// The Bridge web page (browser side). No library. Texts come from web/i18n.json, chosen by the server
// (BRIDGE_LANG, else the browser's language) and embedded in the page; dictation and read-aloud use the same language.
(function () {
  const $ = (id) => document.getElementById(id);
  const T = JSON.parse($("i18n").textContent);
  const tr = (k, v) => String(T[k] || k).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] !== undefined ? v[n] : m));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (c, o) => (c ? new Date(c).toLocaleString(T._locale, Object.assign({ hour: "2-digit", minute: "2-digit" }, o || {})) : "");
  const LBL = { done: tr("done"), wip: tr("wip"), blocked: tr("blocked") };
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " " + T.mb : Math.max(1, Math.round(n / 1024)) + " " + T.kb);
  const toLogin = () => { location.href = "/login"; };

  function state(g) {
    const r = g.filter((x) => x.kind === "reply").pop();
    if (r) { const s = (r.status || "").toUpperCase(); if (s === "DONE") return "done"; if (s === "BLOCKED" || s === "NEEDS-INPUT") return "blocked"; return "wip"; }
    const m = g.find((x) => x.kind === "message"); if (m && (m.type || "").toLowerCase() === "status") return "done";
    return "wip";
  }
  function att(a) {
    if (!a) return "";
    const u = esc(a.url), n = esc(a.name);
    if (a.kind === "image") return '<a class="att" href="' + u + '" target="_blank" rel="noopener noreferrer"><img class="thumb" src="' + u + '" alt="' + n + '" loading="lazy"></a>';
    if (a.kind === "audio") return '<div class="att"><audio controls preload="none" src="' + u + '"></audio><a href="' + u + '" download>' + n + "</a></div>";
    return '<a class="att file" href="' + u + '" download>&#128196; ' + n + (a.size ? " (" + kb(a.size) + ")" : "") + "</a>";
  }

  let last = "", seen = null, liveT, data = [], speaking = null;
  function pulse() {
    const l = $("live"); l.classList.remove("on"); void l.offsetWidth; l.classList.add("on"); $("livet").textContent = tr("newMsg");
    clearTimeout(liveT); liveT = setTimeout(() => { l.classList.remove("on"); $("livet").textContent = tr("live"); }, 5000);
  }
  async function load() {
    try {
      const r = await fetch("/api/messages", { cache: "no-store", credentials: "same-origin" });
      if (r.status === 401) return toLogin();
      const d = await r.json(); const sig = JSON.stringify(d); if (sig === last) return; last = sig; data = d;
      const keys = d.map((m) => m.id + m.kind + m.side + m.from); const fresh = seen ? keys.filter((k) => !seen.has(k)) : [];
      const groups = [], by = {}; for (const m of d) { if (!by[m.id]) { by[m.id] = []; groups.push(by[m.id]); } by[m.id].push(m); }
      $("sN").textContent = d.length; $("sD").textContent = groups.filter((g) => state(g) === "done").length;
      const lc = d.length ? d[d.length - 1].created : ""; $("sL").textContent = lc ? fmt(lc) : "-";
      const l = $("l");
      if (!d.length) { l.innerHTML = '<p class="empty">' + esc(tr("empty")) + "</p>"; seen = new Set(keys); return; }
      if (speaking !== null) { speechSynthesis.cancel(); speaking = null; }
      l.innerHTML = groups.map((g, i) => {
        const st = state(g);
        return '<div class="ex ' + st + '"><div class="exh">' + esc(tr("exchange")) + " " + (i + 1) + ' <span class="badge ' + st + '">' + esc(LBL[st]) + "</span></div>" + g.map((m) => {
          const k = d.indexOf(m), nw = fresh.includes(m.id + m.kind + m.side + m.from) ? " new" : "";
          const who = m.side === "human" ? '<span class="badge human">' + esc(m.from) + "</span>" : '<span class="who">' + esc(m.from) + "</span>";
          return '<div class="m ' + esc(m.side) + nw + '"><div class="meta">' + who + " &middot; " + esc(fmt(m.created, { second: "2-digit", day: "numeric", month: "short" })) +
            '<button type="button" class="say" data-k="' + k + '" aria-label="' + esc(tr("listenAria")) + '">&#128264; ' + esc(tr("listen")) + "</button></div>" +
            (m.task ? '<div class="task">' + esc(m.task) + "</div>" : "") + esc(m.body) + att(m.att) + "</div>";
        }).join("") + "</div>";
      }).join("");
      if (fresh.length) { pulse(); scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); } else if (!seen) { scrollTo(0, document.body.scrollHeight); }
      seen = new Set(keys);
    } catch (e) { /* network: try again on the next round */ }
  }
  load(); setInterval(load, 4000);

  // ---------- read aloud (speechSynthesis), in the page language ----------
  const TTS = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  if (TTS) document.body.classList.add("tts");
  const base = String(T._speech).split("-")[0].toLowerCase();
  function voice() {
    const v = speechSynthesis.getVoices();
    return v.find((x) => x.lang === T._speech) || v.find((x) => x.lang.replace("_", "-").toLowerCase() === T._speech.toLowerCase()) || v.find((x) => x.lang.toLowerCase().startsWith(base)) || null;
  }
  if (TTS) speechSynthesis.getVoices();
  $("l").addEventListener("click", (e) => {
    const b = e.target.closest(".say"); if (!b || !TTS) return;
    const k = Number(b.dataset.k), m = data[k]; if (!m) return;
    if (speaking === k) { speechSynthesis.cancel(); speaking = null; b.classList.remove("on"); return; }
    speechSynthesis.cancel(); document.querySelectorAll(".say.on").forEach((x) => x.classList.remove("on"));
    const txt = (m.from + ". " + (m.task ? m.task + ". " : "") + m.body).replace(/\[[^\]]*\]/g, tr("masked"));
    const u = new SpeechSynthesisUtterance(txt.slice(0, 6000)); u.lang = T._speech; const v = voice(); if (v) u.voice = v;
    u.onend = u.onerror = () => { if (speaking === k) speaking = null; b.classList.remove("on"); };
    speaking = k; b.classList.add("on"); speechSynthesis.speak(u);
  });

  // ---------- composer ----------
  const t = $("t"), cnt = $("cnt"), cstat = $("cstat"), go = $("go"), fileIn = $("file");
  let file = null;
  const status = (msg, cls) => { cstat.textContent = msg || ""; cstat.className = "cstat" + (cls ? " " + cls : ""); };
  const grow = () => { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, innerHeight * 0.4) + "px"; cnt.textContent = t.value.length + "/4000"; };
  t.addEventListener("input", grow);
  $("att").addEventListener("click", () => fileIn.click());
  fileIn.addEventListener("change", () => {
    const f = fileIn.files[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024) { status(tr("fileTooBig"), "err"); fileIn.value = ""; return; }
    file = f; $("chipName").textContent = f.name + " (" + kb(f.size) + ")"; $("chip").hidden = false; status("");
  });
  $("chipX").addEventListener("click", () => { file = null; fileIn.value = ""; $("chip").hidden = true; });

  function uploadFile(f) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(); x.open("POST", "/api/upload");
      x.setRequestHeader("X-File-Name", encodeURIComponent(f.name));
      x.setRequestHeader("Content-Type", "application/octet-stream");
      x.upload.onprogress = (e) => { if (e.lengthComputable) status(tr("uploading", { p: Math.round((e.loaded / e.total) * 100) })); };
      x.onload = () => { if (x.status === 401) return toLogin(); let j = {}; try { j = JSON.parse(x.responseText); } catch (e) { /* empty */ }
        if (x.status === 200 && j.ok) resolve(j); else reject(new Error(j.error || (x.status === 413 ? tr("fileTooBig") : tr("uploadRefused")))); };
      x.onerror = () => reject(new Error(tr("network")));
      x.send(f);
    });
  }
  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = t.value.trim(); if (!text && !file) { status(tr("writeSomething"), "err"); return; }
    go.disabled = true;
    try {
      let tok = null; if (file) tok = (await uploadFile(file)).token;
      status(tr("sending"));
      const r = await fetch("/api/send", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, file: tok }) });
      if (r.status === 401) return toLogin();
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || tr("refused"));
      t.value = ""; grow(); file = null; fileIn.value = ""; $("chip").hidden = true;
      status(tr("sent") + (j.notListening && j.notListening.length ? tr("notListening", { names: j.notListening.join(", ") }) : ""), "ok");
      last = ""; load();
    } catch (err) { status(err.message, "err"); } finally { go.disabled = false; }
  });

  // ---------- dictation (Web Speech API), in the page language ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const mic = $("mic"); mic.hidden = false; let rec = null;
    mic.addEventListener("click", () => {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = T._speech; rec.interimResults = true; rec.continuous = true;
      const before = t.value ? t.value.replace(/\s*$/, " ") : ""; let fin = "";
      rec.onresult = (ev) => { let interim = ""; for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript; } t.value = (before + fin + interim).slice(0, 4000); grow(); };
      rec.onerror = (ev) => status(ev.error === "not-allowed" ? tr("micDenied") : tr("dictStopped", { e: ev.error }), "err");
      rec.onend = () => { rec = null; mic.classList.remove("on"); mic.textContent = "\u{1F3A4} " + tr("dictate"); };
      try { rec.start(); mic.classList.add("on"); mic.textContent = tr("stop"); status(tr("speak")); } catch (err) { rec = null; status(tr("dictUnavailable"), "err"); }
    });
  }

  // ---------- access keys ----------
  let me = null;
  async function keys() {
    const [a, b] = await Promise.all([fetch("/api/me", { credentials: "same-origin" }), fetch("/api/keys", { credentials: "same-origin" })]);
    if (a.status === 401 || b.status === 401) return toLogin();
    me = await a.json(); const list = await b.json();
    $("keyList").innerHTML = list.map((k) => '<div class="k' + (k.revoked ? " off" : "") + '"><code>' + esc(k.prefix) + '-****</code><span class="badge human">' + esc(k.label) + "</span>" +
      '<span class="fine">' + esc(k.revoked ? tr("revokedOn", { d: fmt(k.revoked, { day: "numeric", month: "short" }) }) : tr("createdOn", { d: fmt(k.created, { day: "numeric", month: "short" }) })) + (k.id === me.id ? " &middot; " + esc(tr("thisSession")) : "") + "</span>" +
      (k.revoked ? "" : '<button type="button" class="ghost small rev" data-id="' + esc(k.id) + '">' + esc(tr("revoke")) + "</button>") + "</div>").join("") || '<p class="fine">' + esc(tr("noKey")) + "</p>";
  }
  $("keysBtn").addEventListener("click", () => { const s = $("keys"); s.hidden = !s.hidden; if (!s.hidden) keys(); });
  $("keyList").addEventListener("click", async (e) => {
    const b = e.target.closest(".rev"); if (!b) return;
    const self = b.dataset.id === (me && me.id);
    if (!confirm(self ? tr("confirmSelf") : tr("confirmOther"))) return;
    const r = await fetch("/api/keys/revoke", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: b.dataset.id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $("keyMsg").textContent = j.error || tr("refused"); return; }
    if (j.self) return toLogin();
    $("keyMsg").textContent = tr("keyRevoked"); keys();
  });
  $("newKey").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await fetch("/api/keys/new", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefix: $("nkP").value.trim(), label: $("nkL").value.trim() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { $("keyMsg").textContent = j.error || tr("refused"); return; }
    $("nkKey").textContent = j.key; $("nkOut").hidden = false; $("nkCopy").textContent = tr("copy"); $("keyMsg").textContent = ""; $("nkP").value = ""; $("nkL").value = ""; keys();
  });
  $("nkCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("nkKey").textContent); $("nkCopy").textContent = tr("copied"); }
    catch (err) { const r = document.createRange(); r.selectNodeContents($("nkKey")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $("nkCopy").textContent = tr("selected"); }
  });
  $("nkDone").addEventListener("click", () => { $("nkKey").textContent = ""; $("nkOut").hidden = true; });
})();
