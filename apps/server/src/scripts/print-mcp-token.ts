import { KeytarKeychain } from "../secrets/keychain.js";

const override = process.env.THEAIHATCH_MCP_TOKEN;
const token = override !== undefined && override !== "" ? override : await new KeytarKeychain().get("mcp:bearer");

if (token === null) {
  console.error("No MCP token is stored yet. Start the server once so first run generates it.");
  process.exit(1);
}

console.log(token);
