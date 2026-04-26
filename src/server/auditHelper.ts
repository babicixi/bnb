import type { Request } from "express";
import type { Repository } from "../repo/memory.js";
import { nextId } from "../repo/memory.js";
import { recordAudit, type CreateAuditEntry } from "../services/audit.js";
import type { RequestWithUser } from "./middleware/auth.js";

export function audit(
  repo: Repository,
  req: Request,
  input: Omit<CreateAuditEntry, "id" | "actorUserId" | "actorRole">,
): void {
  const user = (req as RequestWithUser).currentUser;
  recordAudit(
    { push: (e) => repo.auditLog.push(e) },
    {
      id: nextId("audit"),
      actorUserId: user?.id,
      actorRole: user?.role,
      ...input,
    },
  );
}
