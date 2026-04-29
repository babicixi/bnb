import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

// In production (Render, Fly, etc.) point DATA_DIR at the mounted persistent
// disk so state.json + uploads/ survive deploys and restarts. Locally, both
// default to the repo root so dev keeps working unchanged with whatever
// already lives in ./uploads and ./data.
const dataDir = process.env.DATA_DIR ?? path.join(projectRoot, "data");
const uploadsDir =
  process.env.UPLOADS_DIR ??
  (process.env.DATA_DIR
    ? path.join(dataDir, "uploads")
    : path.join(projectRoot, "uploads"));
const persistencePath =
  process.env.STATE_FILE ?? path.join(dataDir, "state.json");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const port = Number(process.env.PORT ?? 3000);
const sessionSecret = process.env.SESSION_SECRET ?? "dev-secret-change-me";

if (
  process.env.NODE_ENV === "production" &&
  sessionSecret === "dev-secret-change-me"
) {
  console.error(
    "✗ SESSION_SECRET is required in production. Set a long random string and redeploy.",
  );
  process.exit(1);
}

const { app, demoCredentials } = createApp({
  uploadsDir,
  sessionSecret,
  startSweepTimer: true,
  persistencePath,
});

app.listen(port, () => {
  console.log(`▶ booking app listening on http://localhost:${port}`);
  console.log(`  data: ${persistencePath}`);
  console.log(`  uploads: ${uploadsDir}`);
  if (process.env.NODE_ENV !== "production") {
    console.log("Demo logins:");
    for (const cred of demoCredentials) {
      console.log(
        `  ${cred.role.padEnd(14)} ${cred.email}  /  ${cred.password}`,
      );
    }
  }
});
