import { Console } from "console";

// A stdio MCP server must write nothing but JSON-RPC frames to stdout; a single stray
// log line corrupts the protocol stream. Route every console method that prints to
// stdout to stderr instead, so neither this code base nor a dependency can break it.
// Imported first by index.ts, before any other module runs.
const stderrConsole = new Console({ stdout: process.stderr, stderr: process.stderr });

console.log = console.error;
console.info = console.error;
console.debug = console.error;
console.dir = stderrConsole.dir.bind(stderrConsole);
