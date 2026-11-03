// Single source of truth for the local server's host/port.
//
// Both server.js and the tray import this so a PORT/HOST override can't make
// them disagree - previously the tray hardcoded 7477 while server.js honoured
// process.env.PORT, so any override left the tray probing the wrong port and
// permanently reporting "offline".
const PORT = Number(process.env.PORT || 7477);
const HOST = process.env.HOST || "127.0.0.1"; // localhost only by default

const net = require("net");

// True for addresses only this machine can reach: 127.0.0.0/8, ::1 and
// localhost. An empty host, 0.0.0.0 or :: means every interface, and a
// hostname may resolve to a LAN address, so none of those count.
function isLoopbackHost(host) {
  const h = String(host ?? "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice(7) : h; // IPv4-mapped IPv6
  if (net.isIPv4(v4)) return v4.startsWith("127.");
  if (net.isIPv6(h)) return h === "::1" || h === "0:0:0:0:0:0:0:1";
  return false;
}

// The server has no authentication, so binding beyond loopback lets anything
// that can reach the address use it. Returns the startup warning, or null.
function exposureWarning(host, port) {
  if (isLoopbackHost(host)) return null;
  return `[startup] WARNING: listening on ${host || "0.0.0.0"}:${port}, not loopback. ` +
    "This server has no authentication: anything that can reach this address " +
    "can use it. Set HOST=127.0.0.1 unless you mean to expose it.";
}

module.exports = { PORT, HOST, isLoopbackHost, exposureWarning };
