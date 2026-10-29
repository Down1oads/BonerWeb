/* Virtual network for the web port.
 *
 * Replaces fetch, XMLHttpRequest and WebSocket for one made-up address (https://p2p.invalid) so the
 * game's server shim talks to the in-browser server (mini-server.js) without any real server.
 *   - The player who creates a lobby becomes the host: their MiniServer is authoritative, and
 *     rtc-link.js waits for joiners on the lobby code.
 *   - A player who joins a code connects to the host over WebRTC. From then on, their lobby calls
 *     are forwarded to the host and the host's realtime messages are delivered to their game.
 */
(function () {
	"use strict";

	var ORIGIN = "https://p2p.invalid";
	var P2P = window.BonerP2P;
	var RealFetch = window.fetch, RealWebSocket = window.WebSocket;
	var realOpen = XMLHttpRequest.prototype.open, realSend = XMLHttpRequest.prototype.send;
	var realSetHeader = XMLHttpRequest.prototype.setRequestHeader, realGetHeader = XMLHttpRequest.prototype.getResponseHeader;

	var net = {
		origin: ORIGIN,
		server: new P2P.MiniServer(),
		clientLink: null, clientToken: null, hostSteamId: null,
		listener: null,
		sockets: new Map(),   // session token -> VWebSocket
		pending: new Map(),   // request id -> resolve
		nextId: 0,
		joining: null,
		onStatus: null,
	};
	P2P.net = net;

	function status(text, isError) { if (net.onStatus) net.onStatus(text, !!isError); }
	function isVirtual(url) { return typeof url === "string" && url.indexOf(ORIGIN) === 0; }
	function relPath(url) { return new URL(url).pathname.replace(/^\/api\/[^/]+\/[^/]+/, ""); }
	function queryOf(url) { var q = {}; new URL(url).searchParams.forEach(function (v, k) { q[k] = v; }); return q; }

	function headerValue(headers, name) {
		if (!headers) return "";
		name = name.toLowerCase();
		if (typeof headers.get === "function") return headers.get(name) || "";
		if (Array.isArray(headers)) { for (var i = 0; i < headers.length; i++) if (String(headers[i][0]).toLowerCase() === name) return headers[i][1]; return ""; }
		for (var k in headers) if (k.toLowerCase() === name) return headers[k];
		return "";
	}

	async function bodyToText(body) {
		if (body == null) return "";
		if (typeof body === "string") return body;
		if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
		if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
		if (typeof Blob !== "undefined" && body instanceof Blob) return body.text();
		return String(body);
	}

	function parseJson(text) { if (!text) return null; try { return JSON.parse(text); } catch (e) { return null; } }

	// ---- routing -----------------------------------------------------------------------------
	net.dispatch = async function (method, url, body, token) {
		var rel = relPath(url), query = queryOf(url);
		if (net.clientLink && /^\/Matchmaking\//.test(rel)) return net.forward(method, rel, query, body, token);
		if (rel === "/Matchmaking/JoinLobby" && body && !net.server.lobbies.has(String(body.lobbyId))) return net.joinRemote(method, rel, query, body, token);
		return net.server.handle(method, rel, query, body, token);
	};

	net.forward = function (method, rel, query, body, token) {
		return new Promise(function (resolve) {
			var id = ++net.nextId;
			net.pending.set(id, resolve);
			if (!net.clientLink || !net.clientLink.send({ t: "req", id: id, method: method, path: rel, query: query, body: body, token: token })) {
				net.pending.delete(id);
				resolve({ status: 503, body: { error: "host_disconnected" } });
				return;
			}
			setTimeout(function () { if (net.pending.delete(id)) resolve({ status: 504, body: { error: "host_timeout" } }); }, 30000);
		});
	};

	net.joinRemote = function (method, rel, query, body, token) {
		if (net.joining) return net.joining;
		var code = String(body.lobbyId);
		var identity = net.server.identityOf(token);
		if (!identity) return Promise.resolve({ status: 401, body: { error: "invalid_or_missing_session" } });
		status("Connecting to lobby " + code + "...");
		net.joining = (async function () {
			var link;
			try {
				link = await P2P.rtc.connect(code, 25000);
			} catch (e) {
				status("Could not reach lobby " + code + ": " + e.message + ". Check the code, or try again.", true);
				return { status: 404, body: { error: "lobby_not_found" } };
			}
			net.attachClientLink(link, identity);
			var res = await net.forward(method, rel, query, body, token);
			if (res.status === 200 && res.body) {
				net.hostSteamId = res.body.ownerId;
				status("Connected to lobby " + code + ".");
			} else {
				net.detachClientLink();
				status("The host refused the join (" + ((res.body && res.body.error) || res.status) + ").", true);
			}
			return res;
		})().then(function (r) { net.joining = null; return r; }, function (e) { net.joining = null; throw e; });
		return net.joining;
	};

	net.attachClientLink = function (link, identity) {
		net.clientLink = link;
		net.clientToken = identity.token;
		link.onmessage = function (m) {
			if (m.t === "res") {
				var resolve = net.pending.get(m.id);
				if (resolve) { net.pending.delete(m.id); resolve({ status: m.status, body: m.body }); }
			} else if (m.t === "push") {
				var ws = net.sockets.get(identity.token);
				if (ws) ws._deliver(m.m);
			}
		};
		link.onclose = function () {
			if (net.clientLink !== link) return;
			var host = net.hostSteamId;
			net.clientLink = null;
			net.pending.forEach(function (resolve) { resolve({ status: 503, body: { error: "host_disconnected" } }); });
			net.pending.clear();
			status("Disconnected from the host.", true);
			var ws = net.sockets.get(identity.token);
			if (ws && host) ws._deliver(JSON.stringify({ type: "PeerDisconnected", from: host }));
		};
		link.send({ t: "hello", identity: identity });
	};

	net.detachClientLink = function () {
		var link = net.clientLink;
		net.clientLink = null;
		if (link) link.close();
	};

	// ---- hosting -----------------------------------------------------------------------------
	net.server.onLobbyCreated = function (code) {
		if (net.listener) net.listener.stop();
		net.listener = P2P.rtc.listen(code, net.onIncomingLink);
		status("Hosting lobby " + code + ". Friends join with this code (Join Game, then Join By ID).");
	};

	net.server.onLobbyClosed = function () {
		if (net.listener) net.listener.stop();
		net.listener = null;
		status("");
	};

	net.onIncomingLink = function (link) {
		var token = null;
		link.onmessage = function (m) {
			if (m.t === "hello") {
				var id = m.identity || {};
				if (typeof id.token !== "string" || typeof id.steamId !== "string") { link.close(); return; }
				var session = net.server.createRemoteSession(id, function (text) { link.send({ t: "push", m: text }); });
				if (!session) { link.close(); return; }
				token = session.token;
			} else if (!token) {
				return;
			} else if (m.t === "req") {
				var r = net.server.handle(String(m.method), String(m.path), m.query || {}, m.body, token);
				link.send({ t: "res", id: m.id, status: r.status, body: r.body });
			} else if (m.t === "ws") {
				net.server.receiveWS(token, String(m.m));
			}
		};
		link.onclose = function () { if (token) net.server.dropSession(token); };
	};

	// ---- fetch -------------------------------------------------------------------------------
	window.fetch = function (input, init) {
		var url = typeof input === "string" ? input : (input && input.url) || String(input);
		if (!isVirtual(url)) return RealFetch.apply(this, arguments);
		return (async function () {
			var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
			var headers = (init && init.headers) || (input && input.headers);
			var raw = init && init.body !== undefined ? init.body : (input && input.body && typeof input.clone === "function" ? await input.clone().text() : null);
			var res = await net.dispatch(method, url, parseJson(await bodyToText(raw)), headerValue(headers, "x-webworks-session"));
			var text = JSON.stringify(res.body == null ? {} : res.body);
			return new Response(text, { status: res.status, headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(text).length) } });
		})();
	};

	// ---- XMLHttpRequest (the shim uses synchronous XHR for the first calls) ----------------------
	XMLHttpRequest.prototype.open = function (method, url, async) {
		if (isVirtual(String(url))) { this.__v = { method: String(method).toUpperCase(), url: String(url), async: async !== false, headers: {} }; return; }
		this.__v = null;
		return realOpen.apply(this, arguments);
	};
	XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
		if (this.__v) { this.__v.headers[String(k).toLowerCase()] = v; return; }
		return realSetHeader.apply(this, arguments);
	};
	XMLHttpRequest.prototype.getResponseHeader = function (name) {
		if (this.__v) return /^content-type$/i.test(name) ? "application/json" : null;
		return realGetHeader.apply(this, arguments);
	};
	XMLHttpRequest.prototype.send = function (body) {
		var v = this.__v, self = this;
		if (!v) return realSend.apply(this, arguments);
		// Synchronous XHR can only be answered locally (it is used for the guest session and file list).
		var res = net.server.handle(v.method, relPath(v.url), queryOf(v.url), parseJson(typeof body === "string" ? body : ""), v.headers["x-webworks-session"] || "");
		var text = JSON.stringify(res.body == null ? {} : res.body);
		[["readyState", 4], ["status", res.status], ["statusText", res.status === 200 ? "OK" : "Error"], ["responseText", text], ["response", text], ["responseURL", v.url]].forEach(function (p) {
			Object.defineProperty(self, p[0], { value: p[1], configurable: true });
		});
		if (v.async) {
			setTimeout(function () {
				["readystatechange", "load", "loadend"].forEach(function (t) { self.dispatchEvent(new Event(t)); });
			}, 0);
		}
	};

	// ---- WebSocket ---------------------------------------------------------------------------
	function VWebSocket(url) {
		var self = this;
		this.url = url; this.readyState = 0; this.protocol = ""; this.extensions = ""; this.bufferedAmount = 0; this.binaryType = "blob";
		this.onopen = this.onmessage = this.onclose = this.onerror = null;
		this._listeners = {};
		this._token = new URL(url.replace(/^ws/, "http")).searchParams.get("session") || "";
		this._sink = function (text) { self._deliver(text); };
		setTimeout(function () {
			if (self.readyState !== 0) return;
			if (!net.server.attachSocket(self._token, self._sink)) { self._finish(4401, "invalid_session"); return; }
			net.sockets.set(self._token, self);
			self.readyState = 1;
			self._emit("open", {});
		}, 0);
	}
	VWebSocket.CONNECTING = 0; VWebSocket.OPEN = 1; VWebSocket.CLOSING = 2; VWebSocket.CLOSED = 3;
	VWebSocket.prototype.CONNECTING = 0; VWebSocket.prototype.OPEN = 1; VWebSocket.prototype.CLOSING = 2; VWebSocket.prototype.CLOSED = 3;

	VWebSocket.prototype.addEventListener = function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); };
	VWebSocket.prototype.removeEventListener = function (type, fn) { var a = this._listeners[type] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
	VWebSocket.prototype._emit = function (type, props) {
		var ev = new Event(type);
		for (var k in props) ev[k] = props[k];
		var handler = this["on" + type];
		if (typeof handler === "function") handler.call(this, ev);
		(this._listeners[type] || []).slice().forEach(function (fn) { fn.call(this, ev); }, this);
	};
	// Messages arrive as separate tasks, like network messages, never inside the caller's stack.
	VWebSocket.prototype._deliver = function (text) {
		var self = this;
		setTimeout(function () { if (self.readyState === 1) self._emit("message", { data: text }); }, 0);
	};
	VWebSocket.prototype.send = function (data) {
		if (this.readyState !== 1) return;
		var text = String(data);
		if (net.clientLink && net.clientToken === this._token) net.clientLink.send({ t: "ws", m: text });
		else net.server.receiveWS(this._token, text);
	};
	VWebSocket.prototype._finish = function (code, reason) {
		if (this.readyState === 3) return;
		this.readyState = 3;
		net.server.detachSocket(this._token, this._sink);
		if (net.sockets.get(this._token) === this) net.sockets.delete(this._token);
		this._emit("close", { code: code, reason: reason, wasClean: true });
	};
	VWebSocket.prototype.close = function (code, reason) { this._finish(code || 1000, reason || ""); };

	function PatchedWebSocket(url, protocols) {
		if (isVirtual(String(url).replace(/^ws/, "http")) || String(url).indexOf("wss://p2p.invalid") === 0) return new VWebSocket(String(url));
		return protocols ? new RealWebSocket(url, protocols) : new RealWebSocket(url);
	}
	PatchedWebSocket.prototype = RealWebSocket.prototype;
	["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) { PatchedWebSocket[k] = RealWebSocket[k]; });
	window.WebSocket = PatchedWebSocket;

	window.addEventListener("pagehide", function () { net.detachClientLink(); if (net.listener) net.listener.stop(); });
})();
