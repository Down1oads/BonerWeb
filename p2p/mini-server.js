/* In-browser lobby server for the web port.
 *
 * Answers the HTTP calls and realtime messages the game's server shim makes, so no real server is
 * needed. The browser of the player who hosts a lobby runs the authoritative copy; other players'
 * calls are forwarded to it (see vnet.js). Written from the traffic the game actually produces.
 */
(function () {
	"use strict";

	var ADJECTIVES = ["Quiet", "Swift", "Lucky", "Clever", "Brave", "Iron", "Salty", "Rusty", "Wild", "Gentle", "Misty", "Sunny"];
	var ANIMALS = ["Fox", "Wolf", "Raven", "Otter", "Badger", "Hawk", "Viper", "Bear", "Moth", "Heron", "Lynx", "Crane"];

	function rnd(n) { return Math.floor(Math.random() * n); }
	function digits(n) { var s = ""; for (var i = 0; i < n; i++) s += rnd(10); return s; }
	function randomToken() {
		var bytes = new Uint8Array(24);
		crypto.getRandomValues(bytes);
		return Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
	}

	function MiniServer() {
		this.sessions = new Map();      // token -> session
		this.bySteam = new Map();       // steamId -> session
		this.lobbies = new Map();       // code -> lobby
		this.onLobbyCreated = null;     // (code) => void
		this.onLobbyClosed = null;      // (code) => void
	}

	// ---- sessions -------------------------------------------------------------------------
	MiniServer.prototype._newSteamId = function () {
		var id;
		do { id = "9" + digits(16); } while (this.bySteam.has(id));
		return id;
	};

	MiniServer.prototype.guestSession = function (body) {
		var session = {
			token: randomToken(),
			steamId: this._newSteamId(),
			name: ADJECTIVES[rnd(ADJECTIVES.length)] + ANIMALS[rnd(ANIMALS.length)] + digits(4),
			appId: String((body && body.appId) || "0"),
			sinks: new Set(),
			remote: false,
		};
		this.sessions.set(session.token, session);
		this.bySteam.set(session.steamId, session);
		return session;
	};

	// A session that lives in another player's browser; `sink(text)` delivers realtime messages to it.
	MiniServer.prototype.createRemoteSession = function (identity, sink) {
		var existing = this.sessions.get(identity.token);
		if (existing) {
			// Only a remote player's own session may be re-attached; never take over a local one.
			if (!existing.remote) return null;
			existing.sinks.add(sink);
			return existing;
		}
		if (this.bySteam.has(identity.steamId)) return null;
		var session = {
			token: identity.token,
			steamId: identity.steamId,
			name: String(identity.name || "Player").slice(0, 40),
			appId: String(identity.appId || "0"),
			sinks: new Set([sink]),
			remote: true,
		};
		this.sessions.set(session.token, session);
		this.bySteam.set(session.steamId, session);
		return session;
	};

	MiniServer.prototype.identityOf = function (token) {
		var s = this.sessions.get(token);
		return s ? { token: s.token, steamId: s.steamId, name: s.name, appId: s.appId } : null;
	};

	MiniServer.prototype.attachSocket = function (token, sink) {
		var s = this.sessions.get(token);
		if (!s) return false;
		s.sinks.add(sink);
		return true;
	};

	MiniServer.prototype.detachSocket = function (token, sink) {
		var s = this.sessions.get(token);
		if (s) s.sinks.delete(sink);
	};

	// A player's browser went away: leave their lobbies and tell the others.
	MiniServer.prototype.dropSession = function (token) {
		var s = this.sessions.get(token);
		if (!s) return;
		var self = this;
		this.lobbies.forEach(function (lobby) {
			if (lobby.members.indexOf(s.steamId) >= 0) self._removeMember(lobby, s, "LobbyMemberDisconnected");
		});
		this.sessions.delete(token);
		this.bySteam.delete(s.steamId);
	};

	MiniServer.prototype._push = function (session, obj) {
		if (!session || !session.sinks.size) return;
		var text = JSON.stringify(obj);
		session.sinks.forEach(function (sink) { try { sink(text); } catch (e) { /* a dead socket must not stop the rest */ } });
	};

	MiniServer.prototype._pushLobby = function (lobby, obj) {
		var self = this;
		lobby.members.forEach(function (id) { self._push(self.bySteam.get(id), obj); });
	};

	// ---- realtime messages sent by the game --------------------------------------------------
	MiniServer.prototype.receiveWS = function (token, text) {
		var s = this.sessions.get(token), msg;
		if (!s) return;
		try { msg = JSON.parse(text); } catch (e) { return; }
		if (msg.type === "Relay" && msg.to) {
			var dest = this.bySteam.get(String(msg.to));
			if (!dest) { this._push(s, { type: "PeerDisconnected", from: String(msg.to) }); return; }
			this._push(dest, { type: "Relay", from: s.steamId, fromName: s.name, payload: msg.payload });
		}
	};

	// ---- lobbies -----------------------------------------------------------------------------
	MiniServer.prototype._snapshot = function (lobby) {
		var self = this, memberData = {};
		lobby.members.forEach(function (id) { memberData[id] = lobby.memberData[id] || {}; });
		return {
			id: lobby.id,
			ownerId: lobby.ownerId,
			maxMembers: lobby.maxMembers,
			memberCount: lobby.members.length,
			visibility: lobby.visibility,
			joinable: lobby.joinable,
			data: lobby.data,
			members: lobby.members.map(function (id) { return { steamId: id, name: self.bySteam.get(id).name }; }),
			memberData: memberData,
			gameServer: lobby.gameServer,
		};
	};

	MiniServer.prototype._removeMember = function (lobby, session, eventType) {
		var i = lobby.members.indexOf(session.steamId);
		if (i < 0) return;
		var wasOwner = lobby.ownerId === session.steamId;
		lobby.members.splice(i, 1);
		delete lobby.memberData[session.steamId];
		if (wasOwner && lobby.members.length) lobby.ownerId = lobby.members[0];
		var event = { type: eventType, lobbyId: lobby.id, steamId: session.steamId, name: session.name, ownerId: lobby.ownerId };
		this._push(session, event);
		this._pushLobby(lobby, event);
		if (!lobby.members.length) {
			this.lobbies.delete(lobby.id);
			if (this.onLobbyClosed) this.onLobbyClosed(lobby.id);
		}
	};

	MiniServer.prototype._newLobbyCode = function () {
		var code;
		do { code = String(100000000 + rnd(900000000)); } while (this.lobbies.has(code));
		return code;
	};

	// ---- HTTP -------------------------------------------------------------------------------
	// path is relative to /api/<engine>/<mount>, e.g. "/Matchmaking/JoinLobby".
	// Returns { status, body }.
	MiniServer.prototype.handle = function (method, path, query, body, token) {
		var self = this;
		var ok = { status: 200, body: { ok: true } };
		function fail(status, error) { return { status: status, body: { error: error } }; }

		if (path === "/User/GuestSession" && method === "POST") {
			var gs = this.guestSession(body);
			return { status: 200, body: { sessionToken: gs.token, steamId: gs.steamId, name: gs.name, appId: gs.appId, accountSystem: "local", linkedAccount: null, hasAvatar: false } };
		}

		var session = this.sessions.get(token);
		if (!session) return fail(401, "invalid_or_missing_session");

		switch (path) {
			case "/RemoteStorage/Files": return { status: 200, body: { quota: 5242880, used: 0, files: [] } };
			case "/UserStats/Stats": return method === "GET" ? { status: 200, body: { stats: {} } } : ok;
			case "/UserStats/Achievements": return { status: 200, body: { achievements: [] } };
			case "/Friends/List": return { status: 200, body: { friends: [], onlineCount: 0 } };
			case "/User/AuthTicket": {
				var expiresAt = Date.now() + 5 * 60 * 1000;
				return { status: 200, body: { ticket: btoa(session.steamId + "." + expiresAt + ".p2p"), expiresAt: expiresAt } };
			}
			case "/User/BeginAuthSession": return { status: 200, body: { valid: true, steamId: session.steamId } };
			case "/Friends/Avatar": {
				// The shim treats `data` as raw RGBA pixels; a 1x1 colour square per player is enough.
				var seed = parseInt(String((query && query.steamid) || session.steamId).slice(-6), 10) || 1;
				var rgba = btoa(String.fromCharCode(60 + seed % 160, 60 + (seed >> 3) % 160, 60 + (seed >> 6) % 160, 255));
				return { status: 200, body: { width: 1, height: 1, mime: "image/png", data: rgba, rgba: rgba, custom: false } };
			}
			case "/Networking/AcceptSession":
			case "/Networking/CloseSession": return ok;
			case "/Networking/RelayTicket": return fail(503, "relay_unavailable");
			case "/Matchmaking/LobbyList": return { status: 200, body: { lobbies: [] } };
		}

		if (path.indexOf("/Matchmaking/") !== 0) return method === "GET" ? { status: 200, body: {} } : ok;

		if (path === "/Matchmaking/CreateLobby") {
			var code = this._newLobbyCode();
			var lobby = {
				id: code, ownerId: session.steamId, maxMembers: Number(body && body.maxMembers) || 8,
				visibility: "public", joinable: true, data: {}, members: [session.steamId],
				memberData: {}, gameServer: { ip: 0, port: 0, serverId: "0" },
			};
			lobby.memberData[session.steamId] = {};
			this.lobbies.set(code, lobby);
			if (this.onLobbyCreated) this.onLobbyCreated(code);
			return { status: 200, body: this._snapshot(lobby) };
		}

		var lobbyId = String((body && body.lobbyId) || (query && query.lobbyId) || "");
		var l = this.lobbies.get(lobbyId);
		if (!l) return fail(404, "lobby_not_found");

		if (path === "/Matchmaking/Lobby") return { status: 200, body: this._snapshot(l) };

		if (path === "/Matchmaking/JoinLobby") {
			if (l.members.indexOf(session.steamId) < 0) {
				if (!l.joinable) return fail(403, "lobby_not_joinable");
				if (l.members.length >= l.maxMembers) return fail(403, "lobby_full");
				l.members.push(session.steamId);
				l.memberData[session.steamId] = {};
				this._pushLobby(l, { type: "LobbyMemberJoined", lobbyId: l.id, steamId: session.steamId, name: session.name });
			}
			return { status: 200, body: this._snapshot(l) };
		}

		if (l.members.indexOf(session.steamId) < 0) return fail(403, "not_a_lobby_member");
		var isOwner = l.ownerId === session.steamId;

		switch (path) {
			case "/Matchmaking/LeaveLobby":
				this._removeMember(l, session, "LobbyMemberLeave");
				return ok;
			case "/Matchmaking/LobbyData": {
				if (!isOwner) return fail(403, "not_lobby_owner");
				var key = String(body.key);
				if (method === "DELETE") delete l.data[key]; else l.data[key] = String(body.value == null ? "" : body.value);
				this._pushLobby(l, { type: "LobbyDataChanged", lobbyId: l.id, key: key, value: method === "DELETE" ? null : l.data[key] });
				return ok;
			}
			case "/Matchmaking/MemberData": {
				var mk = String(body.key);
				var md = l.memberData[session.steamId] || (l.memberData[session.steamId] = {});
				if (body.value == null) delete md[mk]; else md[mk] = String(body.value);
				this._pushLobby(l, { type: "LobbyMemberDataChanged", lobbyId: l.id, steamId: session.steamId, name: session.name, key: mk, value: body.value == null ? null : md[mk] });
				return ok;
			}
			case "/Matchmaking/ChatSend":
				this._pushLobby(l, { type: "LobbyChat", lobbyId: l.id, steamId: session.steamId, name: session.name, message: String(body.message || "") });
				return ok;
			case "/Matchmaking/LobbyVisibility": if (isOwner) l.visibility = String(body.mode); return ok;
			case "/Matchmaking/LobbyJoinable": if (isOwner) l.joinable = !!body.joinable; return ok;
			case "/Matchmaking/LobbyMaxMembers": if (isOwner) l.maxMembers = Number(body.maxMembers) || l.maxMembers; return ok;
			case "/Matchmaking/LobbyOwner":
				if (isOwner && l.members.indexOf(String(body.ownerId)) >= 0) {
					l.ownerId = String(body.ownerId);
					this._pushLobby(l, { type: "LobbyDataChanged", lobbyId: l.id, ownerId: l.ownerId });
				}
				return ok;
			case "/Matchmaking/LobbyGameServer":
				if (isOwner) {
					l.gameServer = { ip: Number(body.ip) || 0, port: Number(body.port) || 0, serverId: String(body.serverId || "0") };
					this._pushLobby(l, { type: "LobbyGameCreated", lobbyId: l.id, ip: l.gameServer.ip, port: l.gameServer.port, serverId: l.gameServer.serverId });
				}
				return ok;
		}
		return ok;
	};

	window.BonerP2P = window.BonerP2P || {};
	window.BonerP2P.MiniServer = MiniServer;
})();
