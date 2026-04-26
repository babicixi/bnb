import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
const uploadsDir = path.join(projectRoot, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const port = Number(process.env.PORT ?? 3000);
const sessionSecret = process.env.SESSION_SECRET ?? "dev-secret-change-me";

const { app, demoCredentials } = createApp({ uploadsDir, sessionSecret });

app.listen(port, () => {
  console.log(`▶ booking app listening on http://localhost:${port}`);
  console.log("Demo logins:");
  for (const cred of demoCredentials) {
    console.log(`  ${cred.role.padEnd(14)} ${cred.email}  /  ${cred.password}`);
  }
});
