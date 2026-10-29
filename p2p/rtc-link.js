/* Browser-to-browser link: WebRTC data channel plus a small, encrypted signaling channel.
 *
 * Signaling (the first handshake only) goes through the free public service ntfy.sh, like the
 * rorweb port, and through a BroadcastChannel so two tabs on one computer connect instantly even
 * offline. Handshake messages are encrypted with a key derived from the lobby code, and the topic
 * name is a hash of the code. After that, game traffic flows directly between the browsers.
 * No TURN relay is used (STUN only), so very strict networks can fail to connect.
 */
(function () {
	"use strict";

	var NTFY = "https://ntfy.sh/";
	var ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }] };
	var enc = new TextEncoder(), dec = new TextDecoder();

	function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
	function b64(bytes) { var s = ""; bytes = new Uint8Array(bytes); for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
	function unb64(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; var s = atob(str), out = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
	function randomId() { var b = new Uint8Array(8); crypto.getRandomValues(b); return hex(b); }
	function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

	async function topicFor(code) { return "bw" + hex(await crypto.subtle.digest("SHA-256", enc.encode("bonerweb-topic:" + code))).slice(0, 32); }
	async function keyFor(code) {
		var base = await crypto.subtle.importKey("raw", enc.encode("bonerweb:" + code), "PBKDF2", false, ["deriveKey"]);
		return crypto.subtle.deriveKey({ name: "PBKDF2", salt: enc.encode("bonerweb-salt-v1"), iterations: 100000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
	}
	async function seal(key, obj) {
		var iv = crypto.getRandomValues(new Uint8Array(12));
		var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(JSON.stringify(obj)));
		var all = new Uint8Array(12 + ct.byteLength); all.set(iv, 0); all.set(new Uint8Array(ct), 12);
		return b64(all);
	}
	async function open(key, text) {
		var all = unb64(text);
		return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, key, all.slice(12))));
	}

	// ---- signaling ---------------------------------------------------------------------------
	function Signal(code) { this.code = code; this.seen = new Set(); this.handler = null; this.es = null; this.bc = null; }

	Signal.prototype.start = async function (handler) {
		var self = this;
		this.handler = handler;
		this.topic = await topicFor(this.code);
		this.key = await keyFor(this.code);

		async function receive(text) {
			var msg;
			try { msg = await open(self.key, text); } catch (e) { return; }
			if (!msg || !msg.id || self.seen.has(msg.id)) return;
			self.seen.add(msg.id);
			if (Date.now() - msg.ts > 60000) return;
			self.handler(msg);
		}

		if (window.BroadcastChannel) {
			this.bc = new BroadcastChannel("bonerweb-" + this.topic);
			this.bc.onmessage = function (e) { receive(e.data); };
		}
		try {
			this.es = new EventSource(NTFY + this.topic + "/sse?since=20s");
			this.es.onmessage = function (e) {
				try { var m = JSON.parse(e.data); if (m.event === "message") receive(m.message); } catch (err) { /* ignore */ }
			};
		} catch (e) { /* ntfy unreachable: same-computer tabs still work */ }
	};

	Signal.prototype.send = async function (kind, to, extra) {
		var msg = Object.assign({ id: randomId(), ts: Date.now(), kind: kind, to: to }, extra || {});
		var text = await seal(this.key, msg);
		if (this.bc) this.bc.postMessage(text);
		fetch(NTFY + this.topic, { method: "POST", body: text }).catch(function () { /* offline or blocked */ });
	};

	Signal.prototype.stop = function () {
		if (this.es) this.es.close();
		if (this.bc) this.bc.close();
	};

	// ---- data channel wrapper ----------------------------------------------------------------
	// Sends JSON objects; very large ones are split into chunks the channel can carry.
	function Link(pc, dc) {
		var self = this;
		this.pc = pc; this.dc = dc; this.onmessage = null; this.onclose = null; this.closed = false;
		this._parts = new Map();
		dc.onmessage = function (e) {
			var msg;
			try { msg = JSON.parse(e.data); } catch (err) { return; }
			if (msg.t === "chunk") {
				var arr = self._parts.get(msg.id) || [];
				arr[msg.i] = msg.d;
				self._parts.set(msg.id, arr);
				if (arr.length === msg.n && arr.every(function (x) { return x !== undefined; })) {
					self._parts.delete(msg.id);
					try { msg = JSON.parse(arr.join("")); } catch (err2) { return; }
				} else return;
			}
			if (self.onmessage) self.onmessage(msg);
		};
		function gone() { if (self.closed) return; self.closed = true; if (self.onclose) self.onclose(); }
		dc.onclose = gone;
		pc.onconnectionstatechange = function () { if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") gone(); };
	}

	Link.prototype.send = function (obj) {
		if (this.closed || this.dc.readyState !== "open") return false;
		var text = JSON.stringify(obj), LIMIT = 48000;
		if (text.length <= LIMIT) { this.dc.send(text); return true; }
		var id = randomId(), n = Math.ceil(text.length / LIMIT);
		for (var i = 0; i < n; i++) this.dc.send(JSON.stringify({ t: "chunk", id: id, i: i, n: n, d: text.slice(i * LIMIT, (i + 1) * LIMIT) }));
		return true;
	};

	Link.prototype.close = function () {
		this.closed = true;
		try { this.dc.close(); } catch (e) { /* ignore */ }
		try { this.pc.close(); } catch (e) { /* ignore */ }
	};

	// ---- host: accept joiners for a lobby code -----------------------------------------------
	function listen(code, onLink) {
		var signal = new Signal(code), peers = new Map();

		function pending(p, cand) { if (p.pc.remoteDescription) p.pc.addIceCandidate(cand).catch(function () {}); else p.queued.push(cand); }

		signal.start(async function (msg) {
			if (msg.to !== "host") return;
			if (msg.kind === "offer") {
				var pc = new RTCPeerConnection(ICE), p = { pc: pc, queued: [] };
				peers.set(msg.from, p);
				pc.onicecandidate = function (e) { if (e.candidate) signal.send("cand", msg.from, { from: "host", cand: e.candidate }); };
				pc.ondatachannel = function (e) {
					var dc = e.channel, link = null;
					function ready() { if (link) return; link = new Link(pc, dc); onLink(link); }
					dc.onopen = ready;
					if (dc.readyState === "open") ready();
				};
				await pc.setRemoteDescription(msg.sdp);
				p.queued.splice(0).forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); });
				var answer = await pc.createAnswer();
				await pc.setLocalDescription(answer);
				signal.send("answer", msg.from, { from: "host", sdp: pc.localDescription });
			} else if (msg.kind === "cand") {
				var peer = peers.get(msg.from);
				if (peer) pending(peer, msg.cand);
			}
		});
		return { stop: function () { signal.stop(); peers.forEach(function (p) { try { p.pc.close(); } catch (e) { /* ignore */ } }); } };
	}

	// ---- joiner: connect to the host of a lobby code -----------------------------------------
	function connect(code, timeoutMs) {
		var signal = new Signal(code), sid = randomId(), pc = new RTCPeerConnection(ICE), dc = pc.createDataChannel("bw", { ordered: true });
		var queued = [];
		return new Promise(function (resolve, reject) {
			var done = false;
			var timer = setTimeout(function () { fail(new Error("timed out waiting for the host")); }, timeoutMs || 25000);
			function fail(err) { if (done) return; done = true; clearTimeout(timer); signal.stop(); try { pc.close(); } catch (e) { /* ignore */ } reject(err); }

			dc.onopen = function () { if (done) return; done = true; clearTimeout(timer); signal.stop(); resolve(new Link(pc, dc)); };
			pc.onicecandidate = function (e) { if (e.candidate) signal.send("cand", "host", { from: sid, cand: e.candidate }); };
			pc.onconnectionstatechange = function () { if (pc.connectionState === "failed") fail(new Error("direct connection failed (network blocks peer-to-peer)")); };

			signal.start(async function (msg) {
				if (msg.to !== sid) return;
				if (msg.kind === "answer") {
					await pc.setRemoteDescription(msg.sdp);
					queued.splice(0).forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); });
				} else if (msg.kind === "cand") {
					if (pc.remoteDescription) pc.addIceCandidate(msg.cand).catch(function () {}); else queued.push(msg.cand);
				}
			}).then(async function () {
				await wait(300); // let the subscription settle before the offer goes out
				var offer = await pc.createOffer();
				await pc.setLocalDescription(offer);
				signal.send("offer", "host", { from: sid, sdp: pc.localDescription });
			}).catch(fail);
		});
	}

	window.BonerP2P = window.BonerP2P || {};
	window.BonerP2P.rtc = { listen: listen, connect: connect };
})();
