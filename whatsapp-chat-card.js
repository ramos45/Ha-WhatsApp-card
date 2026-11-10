/* whatsapp-chat-card · v2.2.0
 * Card de Lovelace con aspecto de WhatsApp para el addon whatsapp (moryoav/ha-addons).
 *  - mode: inbox  → lista de chats (como la app) + navegación atrás + chat nuevo con número temporal + agenda
 *  - mode: chat   → un único contacto fijo (contact_phone)
 * Recibe con el evento new_whatsapp_message / whatsapp_message_sent y envía con whatsapp.send_message.
 */

const WA_VERSION = '2.2.0';
const WA_MAX_MSGS = 200;

/* ---------- utilidades ---------- */
const waDigits = (s) => String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const waSame = (a, b) => {
  a = waDigits(a); b = waDigits(b);
  return a.length >= 9 && b.length >= 9 && a.slice(-9) === b.slice(-9);
};
const waEl = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
};

const WA_ICONS = {
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>',
  dots: '<svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
};

/* ======================================================================
 *  Almacén compartido (historial + agenda). Un almacén por cuenta/eventos,
 *  compartido por todas las cards de la página.
 * ====================================================================== */
const WA_STORES = {};

class WaStore {
  static get(cfg) {
    const k = `${cfg.client_id}|${cfg.event_type}|${cfg.sent_event_type}|${cfg.status_event_type}`;
    if (!WA_STORES[k]) WA_STORES[k] = new WaStore(cfg);
    return WA_STORES[k];
  }

  constructor(cfg) {
    this.cfg = cfg;
    this.lsKey = `wa-chat-card:v2:${cfg.client_id}`;
    this.uKey = ('whatsapp_chat_card_' + cfg.client_id).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    this.state = { updated: 0, chats: {} };
    this.cbs = new Set();
    this.hass = null;
    this.unsub = null;
    this.subscribing = false;
    this.pulling = false;
    this.synced = false;
    this.saveT = null;
    this.debugText = '';
    this.debugNote = '';
    this.pending = {};
    this._loadLocal();
  }

  /* --- persistencia --- */
  _loadLocal() {
    try {
      const r = localStorage.getItem(this.lsKey);
      if (r) { const s = JSON.parse(r); if (s && s.chats) this.state = s; }
    } catch (e) { /* noop */ }
  }
  _saveLocal() {
    try { localStorage.setItem(this.lsKey, JSON.stringify(this.state)); } catch (e) { /* noop */ }
  }
  save() {
    this.state.updated = Date.now();
    this._saveLocal();
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this._push(), 1000);
  }
  async _push() {
    if (this.cfg.sync === false || !this.hass || !this.hass.callWS) return;
    try {
      await this.hass.callWS({ type: 'frontend/set_user_data', key: this.uKey, value: this.state });
    } catch (e) { /* sin sincronización: se queda en local */ }
  }
  async _pull() {
    if (this.cfg.sync === false || this.synced || this.pulling || !this.hass || !this.hass.callWS) return;
    this.pulling = true;
    try {
      const r = await this.hass.callWS({ type: 'frontend/get_user_data', key: this.uKey });
      const v = r && r.value;
      if (v && v.chats && (v.updated || 0) > (this.state.updated || 0)) {
        this.state = v; this._saveLocal(); this.emit();
      } else if ((this.state.updated || 0) > ((v && v.updated) || 0)) {
        this.save();
      }
    } catch (e) { /* noop */ }
    this.synced = true;
    this.pulling = false;
  }

  /* --- ciclo de vida --- */
  attach(hass, cb, cfg) {
    this.cfg = { ...this.cfg, sync: cfg.sync, prefer_lid: cfg.prefer_lid };
    this.hass = hass;
    this.cbs.add(cb);
    this._ensureSub();
    this._pull();
  }
  setHass(h) { this.hass = h; this._ensureSub(); this._pull(); }
  detach(cb) {
    this.cbs.delete(cb);
    if (!this.cbs.size && this.unsub) { this.unsub(); this.unsub = null; }
  }
  emit() { this.cbs.forEach((cb) => { try { cb(); } catch (e) { console.error(e); } }); }

  async _ensureSub() {
    if (this.unsub || this.subscribing || !this.hass || !this.hass.connection || !this.cbs.size) return;
    this.subscribing = true;
    try {
      const types = [this.cfg.event_type, this.cfg.sent_event_type, this.cfg.status_event_type].filter(Boolean);
      const us = await Promise.all(types.map((t) =>
        this.hass.connection.subscribeEvents((e) => this.onEvent(e), t)));
      const un = () => us.forEach((u) => { try { u(); } catch (e) { /* noop */ } });
      if (!this.cbs.size) un(); else this.unsub = un;
    } catch (e) {
      console.error('[whatsapp-chat-card] no se pudo suscribir a los eventos', e);
    }
    this.subscribing = false;
  }

  /* --- chats --- */
  find({ phone, lid }) {
    const p = waDigits(phone), l = waDigits(lid);
    for (const c of Object.values(this.state.chats)) {
      if (l && c.lid && c.lid === l) return c;
      if (p && c.phone && waSame(c.phone, p)) return c;
    }
    return null;
  }

  ensure({ phone, lid, name, pushName, avatar }) {
    const p = waDigits(phone), l = waDigits(lid);
    let a = null, b = null;
    for (const c of Object.values(this.state.chats)) {
      if (l && c.lid === l) a = c;
      if (p && c.phone && waSame(c.phone, p)) b = c;
    }
    let c = a || b;
    if (a && b && a !== b) { // el mismo contacto con dos fichas: se fusionan
      a.msgs = [...a.msgs, ...b.msgs].sort((x, y) => x.ts - y.ts).slice(-WA_MAX_MSGS);
      a.unread = (a.unread || 0) + (b.unread || 0);
      a.saved = a.saved || b.saved;
      a.name = a.name || b.name; a.pushName = a.pushName || b.pushName; a.avatar = a.avatar || b.avatar;
      a.phone = a.phone || b.phone;
      a.last = Math.max(a.last || 0, b.last || 0);
      delete this.state.chats[b.id];
      c = a;
    }
    if (!c) {
      c = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        phone: '', lid: '', name: '', pushName: '', avatar: '', saved: false, unread: 0, last: 0, msgs: [] };
      this.state.chats[c.id] = c;
    }
    if (p && !c.phone) c.phone = p;
    if (l && !c.lid) c.lid = l;
    if (pushName) c.pushName = pushName;
    if (name && !c.name) c.name = name;
    if (avatar && !c.avatar) c.avatar = avatar;
    return c;
  }

  addMsg(c, m, dedupeOut) {
    if (m.id && c.msgs.some((x) => x.id === m.id)) return false;
    if (dedupeOut && m.out) {
      const dup = c.msgs.find((x) => x.out && x.text === m.text && Math.abs(x.ts - m.ts) < 15000);
      if (dup) {
        // Mismo mensaje que enviamos desde la card: nos quedamos con su id real para poder seguir sus acuses
        if (m.id && String(dup.id).startsWith('local-')) { dup.id = m.id; this.takePending(dup); }
        return false;
      }
    }
    c.msgs.push(m);
    if (c.msgs.length > WA_MAX_MSGS) c.msgs.splice(0, c.msgs.length - WA_MAX_MSGS);
    c.last = Math.max(c.last || 0, m.ts);
    if (!m.out && !c.hidden) c.unread = (c.unread || 0) + 1;
    if (m.out) this.takePending(m);
    return true;
  }

  /* --- acuses (entregado / leído) --- */
  static rank(st) { return { sending: 0, sent: 1, delivered: 2, read: 3 }[st] ?? 1; }
  static normStatus(raw) {
    const t = String(raw || '').toLowerCase();
    if (/read|play|seen/.test(t)) return 'read';
    if (/deliver/.test(t)) return 'delivered';
    if (/err|fail/.test(t)) return 'error';
    return 'sent';
  }
  applyStatus(id, st) {
    for (const c of Object.values(this.state.chats)) {
      for (let i = c.msgs.length - 1; i >= 0; i--) {
        const m = c.msgs[i];
        if (!m.out || m.id !== id) continue;
        if (st === 'error') { if (m.status !== 'read' && m.status !== 'delivered') m.status = 'error'; }
        else if (WaStore.rank(st) > WaStore.rank(m.status)) m.status = st;
        return true;
      }
    }
    return false;
  }
  takePending(m) {
    const p = this.pending[m.id];
    if (!p) return;
    delete this.pending[m.id];
    if (WaStore.rank(p.st) > WaStore.rank(m.status)) m.status = p.st;
  }
  onStatus(ev) {
    const d = ev.data || {};
    this.debugText = JSON.stringify(d, null, 1);
    if (d.clientId && this.cfg.client_id && d.clientId !== this.cfg.client_id) {
      this.debugNote = `IGNORADO (acuse): cuenta "${d.clientId}".`;
      return this.emit();
    }
    const id = String(d.messageId || d.message_id || (d.key && d.key.id) || d.id || '');
    const st = WaStore.normStatus(d.status);
    if (!id) { this.debugNote = 'ACUSE sin messageId: no se puede asociar a ningún mensaje.'; return this.emit(); }
    if (/@g\.us$/.test(String(d.chatId || ''))) { this.debugNote = 'ACUSE de grupo: ignorado.'; return this.emit(); }
    const found = this.applyStatus(id, st);
    if (!found) {
      const now = Date.now();
      this.pending[id] = { st, t: now };
      Object.keys(this.pending).forEach((k) => { if (now - this.pending[k].t > 300000) delete this.pending[k]; });
    }
    this.debugNote = `ACUSE ${st} · id ${id.slice(0, 10)}… → ${found ? 'aplicado al mensaje' : 'mensaje no encontrado (se guarda por si llega después)'}`;
    if (found) this.save();
    this.emit();
  }
  _findId(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 4) return '';
    for (const k of ['message_id', 'messageId', 'msg_id']) if (typeof o[k] === 'string' && o[k]) return o[k];
    if (o.key && typeof o.key.id === 'string') return o.key.id;
    for (const v of Object.values(o)) { const r = this._findId(v, depth + 1); if (r) return r; }
    return '';
  }

  markRead(c) { if (c.unread) { c.unread = 0; this.save(); } }
  rename(id, name) {
    const c = this.state.chats[id]; if (!c) return;
    c.name = name; if (name) c.saved = true;
    this.save(); this.emit();
  }
  setSaved(id, v) {
    const c = this.state.chats[id]; if (!c) return;
    c.saved = !!v; this.save(); this.emit();
  }
  setHidden(id, v) {
    const c = this.state.chats[id]; if (!c) return;
    c.hidden = !!v; if (c.hidden) c.unread = 0;
    this.save(); this.emit();
  }
  clearChat(id) {
    const c = this.state.chats[id]; if (!c) return;
    c.msgs = []; c.unread = 0; this.save(); this.emit();
  }
  remove(id) { delete this.state.chats[id]; this.save(); this.emit(); }
  clearMessages() {
    Object.values(this.state.chats).forEach((c) => { c.msgs = []; c.unread = 0; });
    this.save(); this.emit();
  }
  clearAll() { this.state.chats = {}; this.save(); this.emit(); }

  /* --- envío --- */
  async send(c, text) {
    const m = { id: 'local-' + Date.now() + Math.random().toString(36).slice(2, 5), out: true, text, ts: Date.now(), status: 'sending' };
    this.addMsg(c, m, false);
    this.save(); this.emit();
    let to;
    if (c.lid && (this.cfg.prefer_lid !== false || !c.phone)) to = `${c.lid}@lid`;
    else to = `${c.phone}@s.whatsapp.net`;
    const data = { clientId: this.cfg.client_id || 'default', to, body: { text } };
    try {
      if (!this.hass) throw new Error('Home Assistant no está conectado');
      let res = null;
      if (this.hass.callWS) {
        try {
          // Se pide la respuesta del servicio para conocer el id real del mensaje y poder seguir sus acuses
          res = await this.hass.callWS({ type: 'call_service', domain: 'whatsapp', service: 'send_message', service_data: data, return_response: true });
        } catch (e) {
          if (/respon/i.test((e && e.message) || '')) await this.hass.callService('whatsapp', 'send_message', data);
          else throw e;
        }
      } else {
        await this.hass.callService('whatsapp', 'send_message', data);
      }
      const rid = this._findId(res);
      if (rid && String(m.id).startsWith('local-')) { m.id = rid; this.takePending(m); }
      if (m.status === 'sending') m.status = 'sent';
    } catch (e) {
      m.status = 'error';
      m.error = (e && e.message) || String(e);
    }
    this.save(); this.emit();
  }

  /* --- eventos entrantes --- */
  onEvent(ev) {
    if (ev.event_type === this.cfg.status_event_type) return this.onStatus(ev);
    const d = ev.data || {};
    const key = d.key || {};
    this.debugText = JSON.stringify(d, null, 1);
    this.debugNote = '';
    const done = () => { this.emit(); };

    if (d.clientId && this.cfg.client_id && d.clientId !== this.cfg.client_id) {
      this.debugNote = `IGNORADO: evento de la cuenta "${d.clientId}" (esta card usa "${this.cfg.client_id}").`;
      return done();
    }
    const rj = String(key.remoteJid || d.remoteJid || d.chatId || '');
    if (!rj || /@(g\.us|broadcast|newsletter)$/.test(rj)) {
      this.debugNote = 'IGNORADO: grupo, difusión, estado o canal (no se muestran).';
      return done();
    }

    const out = ev.event_type === this.cfg.sent_event_type || !!(d.fromMe ?? key.fromMe ?? false);
    const extra = Array.isArray(d.recipient_identifiers) ? d.recipient_identifiers : [];
    const ids = [key.remoteJid, key.remoteJidAlt, key.senderPn, key.participantPn, d.senderPn,
      d.remoteJid, d.chatId, d.jid, ...extra].filter(Boolean).map(String);
    let phone = '', lid = '';
    for (const i of ids) {
      if (i.endsWith('@lid')) { lid = lid || waDigits(i); }
      else if (i.endsWith('@s.whatsapp.net') || !i.includes('@')) {
        const dg = waDigits(i);
        if (dg.length >= 9) phone = phone || dg;
      }
    }
    if (!phone && !lid) {
      this.debugNote = 'IGNORADO: el evento no trae ningún teléfono ni LID reconocible.';
      return done();
    }

    let pn = '';
    if (out) {
      if (typeof d.recipient_name === 'string') pn = d.recipient_name;
      else if (Array.isArray(d.recipient_names) && typeof d.recipient_names[0] === 'string') pn = d.recipient_names[0];
    } else if (typeof d.pushName === 'string') pn = d.pushName;

    const body = d.body;
    const m = d.message || {};
    const inner = m.ephemeralMessage ? (m.ephemeralMessage.message || {}) : m;
    const media = inner.imageMessage || inner.videoMessage || inner.documentMessage || null;
    let text = inner.conversation
      || (inner.extendedTextMessage && inner.extendedTextMessage.text)
      || (media && media.caption)
      || (typeof body === 'string' ? body : body && body.text)
      || d.text || d.caption || '';
    if (!text) {
      let kind = d.media && d.media.mime_type ? d.media.mime_type : '';
      if (!kind) kind = inner.imageMessage ? 'imagen' : inner.videoMessage ? 'vídeo'
        : inner.audioMessage ? 'audio' : inner.stickerMessage ? 'sticker'
        : inner.documentMessage ? 'documento' : 'mensaje sin texto';
      text = '📎 ' + kind;
    }

    let raw = d.messageTimestamp ?? d.timestamp ?? 0;
    if (raw && typeof raw === 'object') raw = raw.low ?? raw.seconds ?? 0;
    let ts = Number(raw) || 0;
    if (!ts) ts = Date.now(); else if (ts < 1e12) ts *= 1000;

    const sid = key.id || (d.id && (d.id._serialized || d.id.id)) || (typeof d.id === 'string' ? d.id : '');
    const chat = this.ensure({ phone, lid, pushName: pn });
    const added = this.addMsg(chat, {
      id: sid || 'ev-' + ts + '-' + Math.random().toString(36).slice(2, 6),
      out, text, ts, status: 'sent',
    }, true);
    if (added) this.debugNote = `OK: mensaje ${out ? 'enviado a' : 'recibido de'} ${phone ? '+' + phone : 'ID ' + lid}`;
    this.save();
    done();
  }
}

/* ======================================================================
 *  Estilos
 * ====================================================================== */
const WA_CSS = `
:host { display:block; }
ha-card { overflow:hidden; border-radius:12px; position:relative; }
.wa { --hdr:#008069; --hdr-t:#fff; --bg:#efeae2; --in:#fff; --out:#d9fdd3; --txt:#111b21; --sub:#667781;
  --inbar:#f0f2f5; --inp:#fff; --sep:#e1f3fb; --sep-t:#54656f; --rowbg:#fff; --line:#e9edef; --pop:#fff;
  position:relative; display:flex; flex-direction:column; height:100%; color:var(--txt);
  font-family:"Segoe UI",Helvetica,Arial,sans-serif; }
.wa.dark { --hdr:#202c33; --hdr-t:#e9edef; --bg:#0b141a; --in:#202c33; --out:#005c4b; --txt:#e9edef; --sub:#8696a0;
  --inbar:#202c33; --inp:#2a3942; --sep:#182229; --sep-t:#8696a0; --rowbg:#111b21; --line:#222d34; --pop:#233138; }
.screen { display:flex; flex-direction:column; height:100%; min-height:0; }
.hdr { display:flex; align-items:center; gap:8px; padding:8px 6px 8px 12px; background:var(--hdr); color:var(--hdr-t);
  min-height:56px; box-sizing:border-box; flex:none; }
.hdr.hasback { padding-left:2px; }
.ib { width:40px; height:40px; border-radius:50%; border:none; background:transparent; color:inherit; cursor:pointer;
  display:flex; align-items:center; justify-content:center; flex:none; padding:0; }
.ib svg { width:24px; height:24px; fill:currentColor; }
.ib:active { background:rgba(255,255,255,.18); }
.av { width:40px; height:40px; border-radius:50%; background:#6b7c85; color:#fff; display:flex; align-items:center;
  justify-content:center; font-weight:600; font-size:18px; overflow:hidden; flex:none; }
.av img { width:100%; height:100%; object-fit:cover; }
.av.me { width:30px; height:30px; font-size:13px; }
.who { flex:1; min-width:0; }
.name { font-size:16px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sub { font-size:12px; opacity:.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.title { font-size:20px; font-weight:600; }
.sbar { padding:8px 12px; background:var(--inbar); flex:none; }
.sbar input { width:100%; box-sizing:border-box; border:none; outline:none; border-radius:20px; padding:9px 14px;
  background:var(--inp); color:var(--txt); font:inherit; font-size:15px; }
.list { flex:1; min-height:0; overflow-y:auto; background:var(--rowbg); }
.row { display:flex; gap:12px; align-items:center; padding:10px 14px; cursor:pointer; border-bottom:1px solid var(--line); }
.row:active { background:var(--inbar); }
.row .av { width:48px; height:48px; }
.mid { flex:1; min-width:0; }
.top, .bot { display:flex; justify-content:space-between; align-items:center; gap:8px; }
.rn { font-weight:600; font-size:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rt { font-size:12px; color:var(--sub); flex:none; }
.rt.u { color:#00a884; }
.rp { font-size:14px; color:var(--sub); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.badge { background:#00a884; color:#fff; border-radius:999px; min-width:20px; height:20px; font-size:12px; font-weight:600;
  display:flex; align-items:center; justify-content:center; padding:0 6px; box-sizing:border-box; flex:none; }
.ract { background:transparent; border:1px solid var(--line); color:var(--txt); border-radius:16px; padding:6px 12px;
  font-size:13px; cursor:pointer; flex:none; }
.empty { margin:auto; text-align:center; color:var(--sub); font-size:13px; max-width:260px; padding:24px 12px; }
.msgs { flex:1; min-height:0; overflow-y:auto; padding:12px 8% 8px; background:var(--bg); display:flex; flex-direction:column; gap:3px; }
.wa:not(.dark) .msgs { background-image:radial-gradient(rgba(0,0,0,.035) 1px, transparent 1px); background-size:14px 14px; }
.day { align-self:center; background:var(--sep); color:var(--sep-t); font-size:12px; padding:4px 10px; border-radius:8px; margin:8px 0 6px; }
.b { max-width:82%; padding:6px 9px 4px; border-radius:8px; font-size:14.5px; line-height:1.35; position:relative;
  box-shadow:0 1px .5px rgba(11,20,26,.13); white-space:pre-wrap; word-wrap:break-word; overflow-wrap:anywhere; user-select:text; -webkit-user-select:text; }
.b.in { align-self:flex-start; background:var(--in); border-top-left-radius:0; }
.b.out { align-self:flex-end; background:var(--out); border-top-right-radius:0; }
.meta { float:right; margin:6px 0 -2px 10px; font-size:11px; color:var(--sub); display:flex; align-items:center; gap:3px; user-select:none; }
.meta .err { color:#e53935; font-weight:700; }
.tk { display:inline-flex; color:var(--sub); }
.tk svg { width:16px; height:11px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.tk.read { color:#53bdeb; }
.bar { display:flex; align-items:flex-end; gap:8px; padding:8px 10px; background:var(--inbar); flex:none; }
.bar textarea { flex:1; resize:none; border:none; outline:none; background:var(--inp); color:var(--txt); border-radius:20px;
  padding:10px 14px; font:inherit; font-size:15px; max-height:110px; min-height:20px; line-height:1.3; }
.bar textarea::placeholder { color:var(--sub); }
.send { width:42px; height:42px; border-radius:50%; border:none; background:#00a884; color:#fff; cursor:pointer;
  display:flex; align-items:center; justify-content:center; flex:none; padding:0; }
.send svg { width:22px; height:22px; fill:#fff; }
.newbody { flex:1; min-height:0; overflow-y:auto; background:var(--rowbg); padding:12px 14px; }
.field { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; font-size:13px; color:var(--sub); }
.field input { padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:var(--inp); color:var(--txt);
  font:inherit; font-size:15px; outline:none; box-sizing:border-box; width:100%; }
.chk { display:flex; gap:8px; align-items:center; font-size:14px; margin-bottom:12px; color:var(--txt); }
.btn { background:#00a884; color:#fff; border:none; border-radius:8px; padding:10px 16px; font-size:15px; font-weight:600; cursor:pointer; }
.btn.sec { background:transparent; color:var(--txt); border:1px solid var(--line); }
.btn.danger { background:#e53935; }
.sect { font-size:12px; font-weight:600; color:#00a884; margin:16px 0 2px; text-transform:uppercase; letter-spacing:.04em; }
.dbg { background:#1e1e1e; padding:6px 8px; flex:none; }
.dbg-bar { display:flex; justify-content:space-between; align-items:center; font:12px monospace; color:#ccc; margin-bottom:4px; }
.dbg-bar span.bt { display:flex; gap:6px; }
.mini { background:#333; color:#eee; border:none; border-radius:6px; padding:4px 10px; font-size:12px; cursor:pointer; }
.dbg textarea { width:100%; box-sizing:border-box; height:110px; background:#111; color:#9cdcfe; border:none; border-radius:6px;
  font:11px/1.4 monospace; resize:vertical; padding:6px; user-select:text; -webkit-user-select:text; }
.ov { display:none; position:absolute; inset:0; z-index:20; }
.ov.on { display:block; }
.ovbg { position:absolute; inset:0; }
.dlgwrap .ovbg { background:rgba(0,0,0,.5); }
.menu { position:absolute; top:50px; right:8px; min-width:200px; background:var(--pop); color:var(--txt); border-radius:8px;
  box-shadow:0 4px 18px rgba(0,0,0,.3); padding:6px 0; }
.mi { display:block; width:100%; text-align:left; background:transparent; border:none; color:inherit; font:inherit; font-size:15px;
  padding:11px 16px; cursor:pointer; }
.mi:active { background:var(--inbar); }
.mi.danger { color:#e53935; }
.dlg { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:min(92%,340px); background:var(--pop);
  color:var(--txt); border-radius:12px; padding:18px; box-shadow:0 8px 30px rgba(0,0,0,.4); box-sizing:border-box; }
.dlg h3 { margin:0 0 8px; font-size:17px; }
.dlg p { margin:0 0 12px; font-size:14px; color:var(--sub); line-height:1.4; }
.dlg .acts { display:flex; justify-content:flex-end; gap:8px; margin-top:6px; }
.warn { padding:16px; font-size:14px; }
@media (max-width:480px) { .msgs { padding-left:10px; padding-right:10px; } }
`;

/* ======================================================================
 *  Card
 * ====================================================================== */
class WhatsappChatCard extends HTMLElement {
  static getStubConfig() {
    return { type: 'custom:whatsapp-chat-card', mode: 'inbox', user_name: 'Yo', country_code: '34' };
  }
  static getConfigElement() { return document.createElement('whatsapp-chat-card-editor'); }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._view = 'list';
    this._cur = null;
    this._search = '';
    this._searchOn = false;
    this._dbgOn = false;
    this._attached = false;
    this._seeds = [];
    this._hiddenCfg = [];
  }

  setConfig(config) {
    const c = {
      mode: '', title: '', contact_name: '', contact_phone: '', contact_lid: '', contact_avatar: '',
      user_name: '', user_avatar: '', client_id: 'default', country_code: '',
      event_type: 'new_whatsapp_message', sent_event_type: 'whatsapp_message_sent',
      status_event_type: 'whatsapp_message_status',
      height: 520, debug: false, sync: true, prefer_lid: true, contacts: [], hidden_contacts: [], ...config,
    };
    c.client_id = c.client_id || 'default';
    c.event_type = c.event_type || 'new_whatsapp_message';
    c.sent_event_type = c.sent_event_type || 'whatsapp_message_sent';
    c.status_event_type = c.status_event_type || 'whatsapp_message_status';
    c.mode = c.mode || (c.contact_phone ? 'chat' : 'inbox');
    if (!Array.isArray(c.contacts)) c.contacts = [];
    if (!Array.isArray(c.hidden_contacts)) c.hidden_contacts = [];
    this._detach();
    this._config = c;
    this._dbgOn = !!c.debug;
    this._seeds = c.contacts.filter((x) => x && (x.phone || x.lid)).map((x) => ({
      name: x.name || '', phone: this._full(x.phone), lid: waDigits(x.lid), avatar: x.avatar || '',
    }));
    this._hiddenCfg = c.hidden_contacts.map((h) => {
      if (h && typeof h === 'object') return { phone: this._full(h.phone), lid: waDigits(h.lid) };
      const t = String(h || '');
      return /@lid$/.test(t) ? { phone: '', lid: waDigits(t) } : { phone: this._full(t), lid: '' };
    }).filter((h) => h.phone || h.lid);
    this._buildShell();
    if (c.mode === 'chat') {
      if (!c.contact_phone && !c.contact_lid) {
        this._screen.appendChild(waEl('div', 'warn', 'Indica contact_phone (o usa mode: inbox para ver todos los chats).'));
        return;
      }
      const cur = { phone: this._full(c.contact_phone), lid: waDigits(c.contact_lid), name: c.contact_name, avatar: c.contact_avatar };
      this._seeds.push({ ...cur });
      this._store = WaStore.get(c);
      this._open(cur);
    } else {
      this._store = WaStore.get(c);
      this._showList();
    }
    this._attach();
  }

  set hass(h) {
    this._hass = h;
    if (this._root) this._root.classList.toggle('dark', !!(h.themes && h.themes.darkMode));
    if (this._store) { if (this._attached) this._store.setHass(h); else this._attach(); }
  }
  connectedCallback() { this._attach(); }
  disconnectedCallback() { this._detach(); }
  getCardSize() { return Math.ceil((Number(this._config && this._config.height) || 520) / 50); }

  _attach() {
    if (this._attached || !this._hass || !this._store || !this.isConnected) return;
    this._attached = true;
    this._cb = () => this._refresh();
    this._store.attach(this._hass, this._cb, this._config);
  }
  _detach() {
    if (this._attached && this._store) this._store.detach(this._cb);
    this._attached = false;
  }

  /* ---------- helpers de datos ---------- */
  _full(p) {
    let d = waDigits(p);
    const cc = waDigits(this._config && this._config.country_code);
    if (cc && d.length > 0 && d.length <= 10 && !d.startsWith(cc)) d = cc + d;
    return d;
  }
  _seedOf(x) {
    const p = waDigits(x.phone), l = waDigits(x.lid);
    return this._seeds.find((s) => (l && s.lid === l) || (p && s.phone && waSame(s.phone, p)));
  }
  _name(x) {
    const s = this._seedOf(x);
    return (s && s.name) || x.name || x.pushName || (x.phone ? '+' + x.phone : (x.lid ? 'ID ' + String(x.lid).slice(-6) : 'Contacto'));
  }
  _isHidden(c) {
    if (c.hidden) return true;
    return this._hiddenCfg.some((h) => (h.lid && c.lid === h.lid) || (h.phone && c.phone && waSame(c.phone, h.phone)));
  }
  _avatarUrl(x) { const s = this._seedOf(x); return (s && s.avatar) || x.avatar || ''; }
  _chatOf(cur) {
    if (!cur) return null;
    const st = this._store.state.chats;
    return (cur.id && st[cur.id]) || this._store.find(cur);
  }
  _merged(cur) {
    const x = { ...cur };
    const chat = this._chatOf(cur);
    if (chat) for (const k of ['phone', 'lid', 'name', 'pushName', 'avatar']) if (chat[k]) x[k] = chat[k];
    return { x, chat };
  }
  _ensureCur() {
    let chat = this._chatOf(this._cur);
    if (!chat) {
      chat = this._store.ensure({ phone: this._cur.phone, lid: this._cur.lid, name: this._cur.name });
      this._cur.id = chat.id;
      this._store.save();
    }
    return chat;
  }
  _when(ts) {
    const d = new Date(ts), now = new Date(), y = new Date();
    y.setDate(now.getDate() - 1);
    const lang = (this._hass && this._hass.locale && this._hass.locale.language) || undefined;
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === y.toDateString()) return 'Ayer';
    return d.toLocaleDateString(lang, { day: '2-digit', month: '2-digit', year: '2-digit' });
  }
  _dayLabel(ts) {
    const d = new Date(ts), now = new Date(), y = new Date();
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'Hoy';
    if (d.toDateString() === y.toDateString()) return 'Ayer';
    const lang = (this._hass && this._hass.locale && this._hass.locale.language) || undefined;
    return d.toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /* ---------- piezas de UI ---------- */
  _buildShell() {
    const sh = this.shadowRoot;
    sh.innerHTML = '';
    const style = waEl('style'); style.textContent = WA_CSS;
    const card = document.createElement('ha-card');
    card.style.height = (Number(this._config.height) || 520) + 'px';
    const root = waEl('div', 'wa' + (this._hass && this._hass.themes && this._hass.themes.darkMode ? ' dark' : ''));
    this._root = root;
    this._screen = waEl('div', 'screen');
    this._ov = waEl('div', 'ov');
    root.append(this._screen, this._ov);
    card.appendChild(root);
    sh.append(style, card);
  }

  _mount(...nodes) { this._closeOv(); this._screen.replaceChildren(...nodes.filter(Boolean)); }

  _avatar(url, name, extra = '') {
    const el = waEl('div', 'av ' + extra);
    if (url) {
      const img = document.createElement('img');
      img.src = url; img.alt = name || '';
      el.appendChild(img);
    } else {
      el.textContent = (name || '?').replace(/^[+\s]+/, '').charAt(0).toUpperCase() || '?';
    }
    return el;
  }

  _ib(icon, label, fn) {
    const b = waEl('button', 'ib');
    b.type = 'button'; b.innerHTML = WA_ICONS[icon]; b.setAttribute('aria-label', label); b.title = label;
    b.addEventListener('click', fn);
    return b;
  }

  _hdr(o) {
    const c = this._config;
    const h = waEl('div', 'hdr' + (o.back ? ' hasback' : ''));
    if (o.back) h.appendChild(this._ib('back', 'Atrás', o.back));
    if (o.avatar) h.appendChild(this._avatar(o.avatar.url, o.avatar.name));
    const w = waEl('div', 'who');
    const n = waEl('div', o.avatar ? 'name' : 'title', o.title);
    const s = waEl('div', 'sub', o.sub || '');
    if (!o.sub) s.style.display = 'none';
    w.append(n, s);
    h.appendChild(w);
    if (o.me && (c.user_name || c.user_avatar)) h.appendChild(this._avatar(c.user_avatar, c.user_name, 'me'));
    (o.actions || []).forEach((a) => h.appendChild(this._ib(a.icon, a.label, a.fn)));
    this._nameEl = n; this._subEl = s;
    return h;
  }

  _debugPanel() {
    this._dbgTa = null;
    if (!this._dbgOn) return null;
    const box = waEl('div', 'dbg');
    const bar = waEl('div', 'dbg-bar');
    bar.appendChild(waEl('span', '', 'Depuración (último evento)'));
    const bt = waEl('span', 'bt');
    const copy = waEl('button', 'mini', 'Copiar');
    const clr = waEl('button', 'mini', 'Limpiar');
    copy.type = clr.type = 'button';
    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.setAttribute('aria-label', 'Último evento recibido');
    copy.addEventListener('click', async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(ta.value); ok = true; } catch (e) { /* alternativa */ }
      if (!ok) { ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); try { ok = document.execCommand('copy'); } catch (e) { /* noop */ } }
      copy.textContent = ok ? '¡Copiado!' : 'Selecciona y copia';
      setTimeout(() => { copy.textContent = 'Copiar'; }, 1500);
    });
    clr.addEventListener('click', () => { this._store.debugText = ''; this._store.debugNote = ''; ta.value = ''; });
    bt.append(copy, clr);
    bar.appendChild(bt);
    box.append(bar, ta);
    this._dbgTa = ta;
    this._fillDebug();
    return box;
  }
  _fillDebug() {
    if (!this._dbgTa || !this._store) return;
    const s = this._store;
    this._dbgTa.value = (s.debugNote ? s.debugNote + '\n\n' : '') + (s.debugText || 'Esperando eventos…');
  }

  _row(o) {
    const r = waEl('div', 'row');
    r.setAttribute('role', 'button'); r.tabIndex = 0;
    r.appendChild(this._avatar(o.avatar, o.name));
    const mid = waEl('div', 'mid');
    const top = waEl('div', 'top');
    top.append(waEl('div', 'rn', o.name), waEl('div', 'rt' + (o.unread ? ' u' : ''), o.time || ''));
    const bot = waEl('div', 'bot');
    bot.appendChild(waEl('div', 'rp', o.sub || ''));
    if (o.unread) bot.appendChild(waEl('div', 'badge', String(o.unread)));
    mid.append(top, bot);
    r.appendChild(mid);
    if (o.action) {
      const ab = waEl('button', 'ract', o.action.label); ab.type = 'button';
      ab.addEventListener('click', (e) => { e.stopPropagation(); o.action.fn(); });
      r.appendChild(ab);
    }
    r.addEventListener('click', o.fn);
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') o.fn(); });
    return r;
  }

  /* ---------- menús y diálogos ---------- */
  _closeOv() { if (this._ov) { this._ov.className = 'ov'; this._ov.innerHTML = ''; } }

  _menu(items) {
    const ov = this._ov;
    ov.innerHTML = ''; ov.className = 'ov on';
    const bg = waEl('div', 'ovbg');
    bg.addEventListener('click', () => this._closeOv());
    const m = waEl('div', 'menu');
    items.forEach((it) => {
      const b = waEl('button', 'mi' + (it.danger ? ' danger' : ''), it.label);
      b.type = 'button';
      b.addEventListener('click', () => { this._closeOv(); it.fn(); });
      m.appendChild(b);
    });
    ov.append(bg, m);
  }

  _dialog(o) {
    const ov = this._ov;
    ov.innerHTML = ''; ov.className = 'ov on dlgwrap';
    const bg = waEl('div', 'ovbg');
    bg.addEventListener('click', () => this._closeOv());
    const box = waEl('div', 'dlg');
    box.appendChild(waEl('h3', '', o.title));
    if (o.text) box.appendChild(waEl('p', '', o.text));
    const inputs = {};
    (o.fields || []).forEach((f) => {
      const lab = waEl('label', 'field', f.label);
      const inp = document.createElement('input');
      inp.type = f.type || 'text'; inp.value = f.value || '';
      if (f.type === 'tel') inp.inputMode = 'tel';
      lab.appendChild(inp); box.appendChild(lab);
      inputs[f.k] = inp;
    });
    const acts = waEl('div', 'acts');
    const no = waEl('button', 'btn sec', 'Cancelar'); no.type = 'button';
    const ok = waEl('button', 'btn' + (o.danger ? ' danger' : ''), o.ok || 'Aceptar'); ok.type = 'button';
    no.addEventListener('click', () => this._closeOv());
    ok.addEventListener('click', () => {
      const vals = {};
      Object.keys(inputs).forEach((k) => { vals[k] = inputs[k].value; });
      this._closeOv();
      o.fn(vals);
    });
    acts.append(no, ok); box.appendChild(acts);
    ov.append(bg, box);
    const first = Object.values(inputs)[0];
    if (first) setTimeout(() => first.focus(), 50);
  }

  /* ---------- vista: lista de chats ---------- */
  _showList() {
    this._view = 'list'; this._cur = null;
    const c = this._config;
    const hdr = this._hdr({
      title: c.title || 'WhatsApp',
      sub: c.user_name ? 'Tú: ' + c.user_name : '',
      actions: [
        { icon: 'search', label: 'Buscar', fn: () => { this._searchOn = !this._searchOn; if (!this._searchOn) this._search = ''; this._showList(); } },
        { icon: 'plus', label: 'Nuevo chat', fn: () => this._showNew() },
        { icon: 'dots', label: 'Más', fn: () => this._menu([
          { label: `Chats ocultos (${this._hiddenCount()})`, fn: () => this._showHidden() },
          { label: this._dbgOn ? 'Ocultar depuración' : 'Mostrar depuración', fn: () => { this._dbgOn = !this._dbgOn; this._showList(); } },
          { label: 'Vaciar todos los mensajes', danger: true, fn: () => this._dialog({
            title: '¿Vaciar todos los mensajes?', text: 'Se borra el historial de todos los chats guardado por la card. Los contactos se mantienen. No afecta a WhatsApp.',
            ok: 'Vaciar', danger: true, fn: () => this._store.clearMessages() }) },
          { label: 'Borrar todo (mensajes y agenda)', danger: true, fn: () => this._dialog({
            title: '¿Borrar todo?', text: 'Se borran todos los chats, mensajes y contactos guardados por la card. No afecta a WhatsApp.',
            ok: 'Borrar todo', danger: true, fn: () => this._store.clearAll() }) },
        ]) },
      ],
    });
    let sbar = null;
    if (this._searchOn) {
      sbar = waEl('div', 'sbar');
      const inp = document.createElement('input');
      inp.type = 'text'; inp.placeholder = 'Buscar chat o mensaje'; inp.value = this._search;
      inp.setAttribute('aria-label', 'Buscar');
      inp.addEventListener('input', () => { this._search = inp.value; this._fillList(); });
      sbar.appendChild(inp);
    }
    this._listEl = waEl('div', 'list');
    this._mount(hdr, this._debugPanel(), sbar, this._listEl);
    this._fillList();
  }

  _fillList() {
    const box = this._listEl;
    if (!box || this._view !== 'list') return;
    const q = (this._search || '').toLowerCase(), qd = waDigits(this._search);
    const chats = Object.values(this._store.state.chats)
      .filter((c) => (c.msgs.length || c.saved) && !this._isHidden(c))
      .sort((a, b) => (b.last || 0) - (a.last || 0))
      .filter((c) => {
        if (!q) return true;
        const last = (c.msgs[c.msgs.length - 1] || {}).text || '';
        return this._name(c).toLowerCase().includes(q) || last.toLowerCase().includes(q) || (qd && (c.phone || '').includes(qd));
      });
    box.replaceChildren();
    if (!chats.length) {
      box.appendChild(waEl('div', 'empty', q ? 'Sin resultados.' : 'Aún no hay chats. Pulsa + para iniciar uno; los mensajes que recibas aparecerán aquí automáticamente.'));
      return;
    }
    chats.forEach((c) => {
      const last = c.msgs[c.msgs.length - 1];
      box.appendChild(this._row({
        avatar: this._avatarUrl(c), name: this._name(c),
        sub: last ? (last.out ? 'Tú: ' : '') + last.text : (c.phone ? '+' + c.phone : ''),
        time: last ? this._when(last.ts) : '', unread: c.unread,
        fn: () => this._open({ id: c.id, phone: c.phone, lid: c.lid }),
      }));
    });
  }

  _hiddenCount() {
    return Object.values(this._store.state.chats).filter((c) => this._isHidden(c)).length;
  }

  /* ---------- vista: chats ocultos ---------- */
  _showHidden() {
    this._view = 'hidden'; this._cur = null;
    const hdr = this._hdr({
      title: 'Chats ocultos', back: () => this._showList(),
      actions: [{ icon: 'plus', label: 'Ocultar un número', fn: () => this._dialog({
        title: 'Ocultar un número',
        text: 'No aparecerá en la lista aunque te escriba (sus mensajes se siguen guardando). Podrás mostrarlo más tarde desde aquí.',
        fields: [{ k: 'phone', label: 'Teléfono (con o sin prefijo)', type: 'tel' }, { k: 'name', label: 'Nombre (opcional)' }],
        ok: 'Ocultar',
        fn: (v) => {
          const phone = this._full(v.phone);
          if (phone.length < 7) return;
          const c = this._store.ensure({ phone, name: v.name.trim() });
          this._store.setHidden(c.id, true);
        } }) }],
    });
    this._hiddenEl = waEl('div', 'list');
    this._mount(hdr, this._debugPanel(), this._hiddenEl);
    this._fillHidden();
  }

  _fillHidden() {
    const box = this._hiddenEl;
    if (!box || this._view !== 'hidden') return;
    const chats = Object.values(this._store.state.chats).filter((c) => this._isHidden(c))
      .sort((a, b) => (b.last || 0) - (a.last || 0));
    box.replaceChildren();
    if (!chats.length) { box.appendChild(waEl('div', 'empty', 'No hay chats ocultos. Puedes ocultar un chat desde su menú ⋮, o añadir un número con el botón +.')); return; }
    chats.forEach((c) => {
      const last = c.msgs[c.msgs.length - 1];
      box.appendChild(this._row({
        avatar: this._avatarUrl(c), name: this._name(c),
        sub: (c.hidden ? '' : '(oculto por configuración) ') + (last ? (last.out ? 'Tú: ' : '') + last.text : (c.phone ? '+' + c.phone : '')),
        time: last ? this._when(last.ts) : '',
        action: c.hidden ? { label: 'Mostrar', fn: () => this._store.setHidden(c.id, false) } : null,
        fn: () => this._open({ id: c.id, phone: c.phone, lid: c.lid }),
      }));
    });
  }

  /* ---------- vista: chat nuevo + agenda ---------- */
  _showNew() {
    this._view = 'new'; this._cur = null;
    const hdr = this._hdr({ title: 'Nuevo chat', back: () => this._showList() });
    const body = waEl('div', 'newbody');

    const f1 = waEl('label', 'field', 'Teléfono (con o sin prefijo)');
    const ph = document.createElement('input');
    ph.type = 'tel'; ph.inputMode = 'tel'; ph.placeholder = this._config.country_code ? '600123456' : '+34600123456';
    f1.appendChild(ph);
    const f2 = waEl('label', 'field', 'Nombre (opcional)');
    const nm = document.createElement('input');
    nm.type = 'text'; nm.placeholder = 'Nombre';
    f2.appendChild(nm);
    const chk = waEl('label', 'chk');
    const cb = document.createElement('input'); cb.type = 'checkbox';
    chk.append(cb, document.createTextNode('Guardar en la agenda (si no, es un chat temporal)'));
    const go = waEl('button', 'btn', 'Abrir chat'); go.type = 'button';
    const err = waEl('div', 'sub', ''); err.style.color = '#e53935'; err.style.opacity = '1'; err.style.margin = '8px 0 0';
    go.addEventListener('click', () => {
      const phone = this._full(ph.value);
      if (phone.length < 7) { err.textContent = 'Escribe un teléfono válido.'; err.style.display = 'block'; return; }
      const name = nm.value.trim();
      if (cb.checked) {
        const c = this._store.ensure({ phone, name });
        if (name) c.name = name;
        c.saved = true; this._store.save();
        this._open({ id: c.id, phone: c.phone, lid: c.lid });
      } else {
        const ex = this._store.find({ phone });
        this._open(ex ? { id: ex.id, phone: ex.phone, lid: ex.lid } : { phone, name });
      }
    });
    ph.addEventListener('input', () => { err.textContent = ''; this._agendaQ = ph.value; this._fillAgenda(); });
    this._agendaQ = '';
    body.append(f1, f2, chk, go, err, waEl('div', 'sect', 'Agenda'));
    this._agendaEl = waEl('div', '');
    body.appendChild(this._agendaEl);
    this._mount(hdr, this._debugPanel(), body);
    this._fillAgenda();
  }

  _fillAgenda() {
    const box = this._agendaEl;
    if (!box || this._view !== 'new') return;
    const q = (this._agendaQ || '').toLowerCase(), qd = waDigits(this._agendaQ);
    const items = [];
    Object.values(this._store.state.chats).filter((c) => c.saved && !this._isHidden(c)).forEach((c) =>
      items.push({ name: this._name(c), phone: c.phone, lid: c.lid, avatar: this._avatarUrl(c), cur: { id: c.id, phone: c.phone, lid: c.lid } }));
    this._seeds.forEach((s) => {
      const hc = this._store.find({ phone: s.phone, lid: s.lid });
      if (hc && this._isHidden(hc)) return;
      if (!items.some((i) => (s.lid && i.lid === s.lid) || (s.phone && i.phone && waSame(i.phone, s.phone))))
        items.push({ name: s.name || '+' + s.phone, phone: s.phone, lid: s.lid, avatar: s.avatar, cur: { phone: s.phone, lid: s.lid, name: s.name, avatar: s.avatar } });
    });
    const shown = items.filter((i) => !q || i.name.toLowerCase().includes(q) || (qd && (i.phone || '').includes(qd)))
      .sort((a, b) => a.name.localeCompare(b.name));
    box.replaceChildren();
    if (!shown.length) {
      box.appendChild(waEl('div', 'empty', items.length ? 'Sin coincidencias.' : 'La agenda está vacía. Marca "Guardar en la agenda" al crear un chat, o define "contacts" en la configuración de la card.'));
      return;
    }
    shown.forEach((i) => box.appendChild(this._row({
      avatar: i.avatar, name: i.name, sub: i.phone ? '+' + i.phone : 'ID ' + String(i.lid).slice(-6), fn: () => this._open(i.cur),
    })));
  }

  /* ---------- vista: chat ---------- */
  _open(cur) {
    this._view = 'chat'; this._cur = cur; this._rendered = false;
    const c = this._config;
    const inbox = c.mode !== 'chat';
    const { x } = this._merged(cur);
    const hdr = this._hdr({
      back: inbox ? () => this._showList() : null,
      avatar: { url: this._avatarUrl(x), name: this._name(x) },
      title: this._name(x), sub: this._subText(x), me: true,
      actions: [{ icon: 'dots', label: 'Más', fn: () => this._chatMenu(inbox) }],
    });
    this._msgsEl = waEl('div', 'msgs');
    const bar = waEl('div', 'bar');
    const input = document.createElement('textarea');
    input.rows = 1; input.placeholder = 'Escribe un mensaje';
    input.setAttribute('aria-label', 'Escribe un mensaje');
    const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 110) + 'px'; };
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendMsg(input, autosize); } });
    const btn = waEl('button', 'send'); btn.type = 'button'; btn.innerHTML = WA_ICONS.send; btn.setAttribute('aria-label', 'Enviar');
    btn.addEventListener('click', () => this._sendMsg(input, autosize));
    bar.append(input, btn);
    this._mount(hdr, this._debugPanel(), this._msgsEl, bar);
    this._fillMsgs();
  }

  _subText(x) {
    const parts = [];
    if (this._config.user_name) parts.push('Tú: ' + this._config.user_name);
    parts.push(x.phone ? '+' + x.phone : (x.lid ? 'ID ' + x.lid : ''));
    return parts.filter(Boolean).join(' · ');
  }

  _chatMenu(inbox) {
    const { x, chat } = this._merged(this._cur);
    const items = [];
    if (inbox) {
      items.push({ label: 'Editar nombre', fn: () => this._dialog({
        title: 'Editar nombre', fields: [{ k: 'name', label: 'Nombre', value: this._name(x) === ('+' + x.phone) ? '' : this._name(x) }], ok: 'Guardar',
        fn: (v) => { const c = this._ensureCur(); this._store.rename(c.id, v.name.trim()); } }) });
      items.push({ label: chat && chat.saved ? 'Quitar de la agenda' : 'Guardar en la agenda',
        fn: () => { const c = this._ensureCur(); this._store.setSaved(c.id, !c.saved); } });
    }
    if (inbox) {
      if (chat && this._isHidden(chat)) {
        if (chat.hidden) items.push({ label: 'Mostrar en la lista', fn: () => this._store.setHidden(chat.id, false) });
      } else {
        items.push({ label: 'Ocultar de la lista', fn: () => { const c = this._ensureCur(); this._store.setHidden(c.id, true); this._showList(); } });
      }
    }
    items.push({ label: 'Vaciar chat', danger: true, fn: () => this._dialog({
      title: '¿Vaciar este chat?', text: 'Se borran los mensajes guardados por la card para este chat. No afecta a WhatsApp.',
      ok: 'Vaciar', danger: true, fn: () => { const c = this._chatOf(this._cur); if (c) this._store.clearChat(c.id); } }) });
    if (inbox) items.push({ label: 'Eliminar chat y contacto', danger: true, fn: () => this._dialog({
      title: '¿Eliminar chat?', text: 'Se borran los mensajes y el contacto de la agenda. No afecta a WhatsApp.',
      ok: 'Eliminar', danger: true, fn: () => { const c = this._chatOf(this._cur); if (c) this._store.remove(c.id); this._showList(); } }) });
    this._menu(items);
  }

  async _sendMsg(input, autosize) {
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; autosize();
    const chat = this._ensureCur();
    await this._store.send(chat, text);
  }

  _fillMsgs() {
    const list = this._msgsEl;
    if (!list || this._view !== 'chat') return;
    const chat = this._chatOf(this._cur);
    if (chat && chat.unread) this._store.markRead(chat);
    const near = !this._rendered || list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    this._rendered = true;
    list.replaceChildren();
    const msgs = chat ? chat.msgs : [];
    if (!msgs.length) {
      list.appendChild(waEl('div', 'empty', 'Aún no hay mensajes. Escribe abajo, o espera a recibir alguno.'));
      return;
    }
    const lang = (this._hass && this._hass.locale && this._hass.locale.language) || undefined;
    let lastDay = '';
    for (const m of msgs) {
      const day = new Date(m.ts).toDateString();
      if (day !== lastDay) { lastDay = day; list.appendChild(waEl('div', 'day', this._dayLabel(m.ts))); }
      const b = waEl('div', 'b ' + (m.out ? 'out' : 'in'));
      b.appendChild(document.createTextNode(m.text));
      const meta = waEl('span', 'meta');
      meta.appendChild(waEl('span', '', new Date(m.ts).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })));
      if (m.out) {
        let t;
        if (m.status === 'error') {
          t = waEl('span', 'err', '!');
          t.title = 'No se pudo enviar: ' + (m.error || 'error desconocido');
        } else if (m.status === 'sending') {
          t = waEl('span', '', '🕓');
        } else {
          const two = m.status === 'delivered' || m.status === 'read';
          t = waEl('span', 'tk' + (m.status === 'read' ? ' read' : ''));
          t.innerHTML = two
            ? '<svg viewBox="0 0 16 11"><path d="M1 5.5l3 3.5 6.5-8"/><path d="M6 7.5l1.2 1.5 6.8-8.3"/></svg>'
            : '<svg viewBox="0 0 16 11"><path d="M3 5.5l3 3.5 6.5-8"/></svg>';
          t.title = m.status === 'read' ? 'Leído' : m.status === 'delivered' ? 'Entregado' : 'Enviado';
        }
        meta.appendChild(t);
      }
      b.appendChild(meta);
      list.appendChild(b);
    }
    if (near) list.scrollTop = list.scrollHeight;
  }

  _refresh() {
    if (!this._screen) return;
    this._fillDebug();
    if (this._view === 'list') this._fillList();
    else if (this._view === 'new') this._fillAgenda();
    else if (this._view === 'hidden') this._fillHidden();
    else if (this._view === 'chat') {
      const { x } = this._merged(this._cur);
      if (this._nameEl) this._nameEl.textContent = this._name(x);
      if (this._subEl) { const s = this._subText(x); this._subEl.textContent = s; this._subEl.style.display = s ? '' : 'none'; }
      this._fillMsgs();
    }
  }
}

/* ======================================================================
 *  Editor visual
 * ====================================================================== */
const WA_SCHEMA = [
  { name: 'mode', selector: { select: { mode: 'dropdown', options: [
    { value: 'inbox', label: 'Todos los chats (lista, atrás, chat nuevo y agenda)' },
    { value: 'chat', label: 'Un solo contacto' }] } } },
  { name: 'title', selector: { text: {} } },
  { name: 'contact_name', selector: { text: {} } },
  { name: 'contact_phone', selector: { text: {} } },
  { name: 'contact_lid', selector: { text: {} } },
  { name: 'contact_avatar', selector: { text: {} } },
  { name: 'contacts', selector: { object: {} } },
  { name: 'hidden_contacts', selector: { object: {} } },
  { name: 'user_name', selector: { text: {} } },
  { name: 'user_avatar', selector: { text: {} } },
  { name: 'client_id', selector: { text: {} } },
  { name: 'country_code', selector: { text: {} } },
  { name: 'event_type', selector: { text: {} } },
  { name: 'sent_event_type', selector: { text: {} } },
  { name: 'status_event_type', selector: { text: {} } },
  { name: 'prefer_lid', selector: { boolean: {} } },
  { name: 'sync', selector: { boolean: {} } },
  { name: 'height', selector: { number: { min: 240, max: 1200, mode: 'box', unit_of_measurement: 'px' } } },
  { name: 'debug', selector: { boolean: {} } },
];
const WA_LABELS = {
  mode: 'Modo',
  title: 'Título (modo lista)',
  contact_name: 'Un solo contacto: nombre',
  contact_phone: 'Un solo contacto: teléfono',
  contact_lid: 'Un solo contacto: LID (opcional)',
  contact_avatar: 'Un solo contacto: foto (URL)',
  contacts: 'Agenda fija: lista de contactos (name, phone, lid, avatar)',
  hidden_contacts: 'Contactos ocultos siempre (lista de teléfonos o LID)',
  user_name: 'Tu nombre (perfil de usuario)',
  user_avatar: 'Tu foto (URL, opcional)',
  client_id: 'Cuenta que envía (clientId)',
  country_code: 'Prefijo de país (ej. 34)',
  event_type: 'Evento de mensaje recibido',
  sent_event_type: 'Evento de mensaje enviado',
  status_event_type: 'Evento de acuses (entregado/leído)',
  prefer_lid: 'Enviar por LID si se conoce',
  sync: 'Sincronizar historial y agenda entre dispositivos',
  height: 'Alto de la card',
  debug: 'Mostrar depuración al empezar',
};

class WhatsappChatCardEditor extends HTMLElement {
  setConfig(config) { this._config = config; this._render(); }
  set hass(hass) { this._hass = hass; if (this._form) this._form.hass = hass; }
  _render() {
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.computeLabel = (s) => WA_LABELS[s.name] || s.name;
      this._form.addEventListener('value-changed', (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = WA_SCHEMA;
    this._form.data = this._config;
  }
}

customElements.define('whatsapp-chat-card', WhatsappChatCard);
customElements.define('whatsapp-chat-card-editor', WhatsappChatCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'whatsapp-chat-card',
  name: 'WhatsApp Chat',
  description: 'Chats con aspecto de WhatsApp (lista, chat nuevo, agenda) usando el addon de WhatsApp.',
  preview: false,
});
console.info(`%c WHATSAPP-CHAT-CARD %c v${WA_VERSION} `, 'background:#008069;color:#fff', 'background:#eee;color:#111');
