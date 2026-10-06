// ClipForge Events: forwards the local player's highlight events from
// Overwolf's Game Events Provider to ClipForge on localhost. ClipForge does
// the recording; this app only says "clip now". CS2 and League are left
// out because ClipForge reads their official APIs directly.

const CLIPFORGE = "http://127.0.0.1:3888/overwolf";

// Overwolf game class id -> GEP features to subscribe to, and which event
// names count as a highlight. Every event here is already local-player-only.
const GAMES = {
  21640: { name: "Valorant", features: ["gep_internal", "me", "match_info", "kill", "death"], highlights: ["kill"] },
  21216: { name: "Fortnite", features: ["gep_internal", "me", "match_info", "kill", "killed", "death"], highlights: ["kill", "knockout"] },
  21566: { name: "Apex Legends", features: ["gep_internal", "me", "match_info", "kill", "death"], highlights: ["kill", "knockdown"] },
  10826: { name: "Rainbow Six Siege", features: ["gep_internal", "me", "match_info", "kill", "death"], highlights: ["kill"] },
  10844: { name: "Overwatch", features: ["gep_internal", "match_info", "kill", "death"], highlights: ["elimination"] },
  10798: { name: "Rocket League", features: ["gep_internal", "me", "match_info", "stats"], highlights: ["action_points:Goal"] },
  24890: { name: "Marvel Rivals", features: ["game_info", "match_info"], highlights: ["kill"] },
};

function send(body) {
  // text/plain keeps this a "simple" request: no CORS preflight to answer.
  fetch(CLIPFORGE, { method: "POST", body: JSON.stringify(body) }).catch(() => {
    // ClipForge not running; nothing to do.
  });
}

function classId(gameInfo) {
  return gameInfo ? Math.floor(gameInfo.id / 10) : null;
}

function isHighlight(game, event) {
  return game.highlights.some((h) => {
    const [name, data] = h.split(":");
    return event.name === name && (data === undefined || String(event.data) === data);
  });
}

let currentGame = null;

// GEP often refuses features right after launch; retry until it accepts.
function subscribe(id, attempt = 0) {
  const game = GAMES[id];
  if (!game || currentGame !== id) return;
  overwolf.games.events.setRequiredFeatures(game.features, (result) => {
    if (result.success) {
      console.log(`ClipForge: subscribed to ${game.name}`, result.supportedFeatures);
    } else if (attempt < 20) {
      setTimeout(() => subscribe(id, attempt + 1), 3000);
    } else {
      console.warn(`ClipForge: ${game.name} events unavailable`, result.error);
    }
  });
}

function onGame(gameInfo) {
  const id = gameInfo && gameInfo.isRunning ? classId(gameInfo) : null;
  if (id === currentGame) return;
  currentGame = id;
  if (id && GAMES[id]) {
    send({ type: "hello", game: id });
    subscribe(id);
  }
}

overwolf.games.events.onNewEvents.addListener((e) => {
  const game = GAMES[currentGame];
  if (!game) return;
  for (const event of e.events) {
    if (isHighlight(game, event)) {
      send({ type: "highlight", game: currentGame, event: event.name });
    }
  }
});

overwolf.games.onGameInfoUpdated.addListener((e) => {
  if (e && (e.runningChanged || e.gameChanged)) onGame(e.gameInfo);
});

overwolf.games.getRunningGameInfo(onGame);

// Heartbeat so ClipForge's settings can show "Connected".
send({ type: "hello" });
setInterval(() => send({ type: "hello" }), 60000);
