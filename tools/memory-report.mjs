#!/usr/bin/env node
// Build the VoiceDock memory report from a folder of memory CSV files, for
// reviewing from WSL or any shell:
//
//   node tools/memory-report.mjs <csv dir> [--out <file.html>] [--open] [--now <ISO time>]
//
// The CSV files come from the VoiceDock tray ("Record memory history") or the
// n8voice N8 Tray module; on Windows they are under %APPDATA%\VoiceDock\memory
// (from WSL: /mnt/c/Users/<you>/AppData/Roaming/VoiceDock/memory). The report
// is one self-contained HTML file. The logic lives with the tray, in
// servers/piper/tray/memory-report.js, so both produce the same page.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { main } = require('../servers/piper/tray/memory-report.js');

process.exitCode = main(process.argv);
