# BonerWeb

Unofficial web (WebGL) port of **Bonerooms** by Jasozz Games, so it can be played in a desktop
browser with nothing to install and **no server to run**. All credit for the game goes to its
developer, who gave permission for a web version.

## Playing

1. Open the page in desktop **Chrome or Edge** (phones and tablets are not supported).
2. Wait for the download (about 470 MB the first time) and press Enter.
3. **To host:** choose *Host Game*, pick a mode, and start the lobby. The page shows a 9-digit lobby
   code at the top, and the lobby screen shows it as well. Send it to your friends.
4. **To join:** choose *Join Game*, then *Join By ID*, and type the host's code.

Playing alone also works: host a lobby, press Ready, then Start.

You need a few GB of free memory. The game is heavy; older or low-memory laptops and Chromebooks
may crash it.

## What is in this repository

- The web build of the game: compiled code and packed assets. It includes the third-party libraries
  the original game uses, in compiled form.
- `index.html` and `p2p/`: the page and the code that replaces the game's online server (below).
- `Build/data/`: the game data, split into ten pieces because GitHub rejects files over 100 MB.
  The page downloads them, checks each checksum and joins them in the browser.

## How multiplayer works without a server

The game's server calls are answered inside the browser (`p2p/`). The host's browser runs a small
lobby server and the other players connect to it directly over WebRTC.

- **Finding each other:** players swap their first connection details through the free public
  service [ntfy.sh](https://ntfy.sh) using the lobby code. The messages are encrypted with a key
  derived from the code, and the channel name is a hash of the code. Two tabs on the same computer
  also connect through the browser itself, with no internet at all.
- **Playing:** after that, game traffic flows directly between the browsers.
- **The host's tab is the server.** If the host closes it, everyone is disconnected.

### Limits you should know about

- **Some networks block it.** Only STUN is used, with no relay fallback. It works on most home
  networks, but strict school, work or mobile networks can stop two browsers from connecting.
- **Players can see each other's IP address.** That is how WebRTC works.
- **The lobby code is the only secret.** It has 9 digits, so a determined person could guess it
  while a lobby is open. Do not use the code for anything else, and keep lobbies short-lived.
- ntfy.sh is a third-party free service. If it is down or blocked, only same-computer play works.
- Voice chat does not work in the browser. Playing in two browsers on different computers over the
  internet has not been tested yet.

A link can also carry `?server=https://example.com` to use a real Webworks server instead of the
built-in one (only `https://`, or `http://localhost` for testing).

## Takedown

If you own any content here and want it removed, open an issue on this repository and it will be
taken down.
