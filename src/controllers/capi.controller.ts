import { Request, Response, NextFunction } from "express";
import * as capiService from "../services/capi.service";

/** Extrae la IP real del visitante detrás de Cloudflare o del proxy de Netlify. */
function clientIp(req: Request) {
  return (
    (req.headers["cf-connecting-ip"] as string) ||
    (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ||
    req.socket.remoteAddress ||
    undefined
  );
}

export async function track(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventName, eventId, eventSourceUrl, userData, customData, eventTime } = req.body || {};

    if (!eventName || !eventId) {
      res.status(400).json({ message: "eventName y eventId son obligatorios" });
      return;
    }

    const result = await capiService.sendEvent(
      { eventName, eventId, eventSourceUrl, userData, customData, eventTime },
      clientIp(req),
      req.headers["user-agent"]
    );

    // Se responde 202 siempre que la petición sea válida: el navegador no debe
    // quedarse esperando ni romperse porque Meta falle.
    res.status(202).json({ received: true, ...result });
  } catch (error) {
    next(error);
  }
}

export function status(_req: Request, res: Response) {
  res.json({ configured: capiService.isConfigured() });
}
