// Single source of truth for the local server's host/port.
//
// Both server.js and the tray import this so a PORT/HOST override can't make
// them disagree — previously the tray hardcoded 7477 while server.js honoured
// process.env.PORT, so any override left the tray probing the wrong port and
// permanently reporting "offline".
const PORT = Number(process.env.PORT || 7477);
const HOST = process.env.HOST || "127.0.0.1"; // localhost only by default

module.exports = { PORT, HOST };
