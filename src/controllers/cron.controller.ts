import { Request, Response, NextFunction } from "express";
import { credsFromRequest, processBacklog } from "../services/articleTranslation.service";
import { hasWaitUntil } from "../utils/background";
import { hasLlmCredentials } from "../services/translation.service";

const CRON_BATCH = 3;

// Autorización del cron de Vercel:
// - Con CRON_SECRET definida: exige "Authorization: Bearer <CRON_SECRET>" (lo envía Vercel).
// - Sin CRON_SECRET: solo acepta el user-agent "vercel-cron/1.0". Es una protección DÉBIL
//   (cualquiera puede enviar ese header); el daño está acotado por el lote pequeño y el
//   bloqueo por hash, pero se recomienda definir CRON_SECRET en Vercel.
function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) return req.headers.authorization === `Bearer ${secret}`;
  return req.headers["user-agent"] === "vercel-cron/1.0";
}

// GET /api/cron/translate-backlog
export async function cronTranslateBacklog(req: Request, res: Response, next: NextFunction) {
  try {
    if (!isAuthorizedCron(req)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const result = await processBacklog(CRON_BATCH, credsFromRequest(req));
    const { results: _r, ...summary } = result;
    console.log("[cron] translate-backlog", JSON.stringify(summary));
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
}

// GET /api/cron/health — diagnóstico sin datos sensibles (solo booleanos)
export function translationHealth(req: Request, res: Response) {
  res.json({
    data: {
      waitUntil: hasWaitUntil(),
      llmCredentials: hasLlmCredentials(credsFromRequest(req)),
      provider: process.env.ANTHROPIC_API_KEY ? "anthropic" : "ai-gateway",
      cronSecret: !!process.env.CRON_SECRET,
    },
  });
}
