import dotenv from "dotenv";
dotenv.config(); // must be first — loads PORT and DB_URI before any other import reads them
import type { IncomingMessage, ServerResponse } from "http";
import { dbConnect } from "./config/mongo";
import { createApp } from "./app";

// Configuración estática que lee @vercel/node al construir la función.
// 300 s permite terminar las traducciones en segundo plano (waitUntil).
export const config = { maxDuration: 300 };

const port = process.env.PORT || 8100;

const { app, server } = createApp();
const ready = dbConnect();

// En local se levanta el servidor HTTP. En Vercel no se escucha ningún puerto:
// el runtime invoca el handler exportado dentro del contexto de la petición,
// lo que permite usar waitUntil para el trabajo en segundo plano.
if (!process.env.VERCEL) {
  ready.then(() => {
    server.timeout = 10 * 60 * 1000;
    server.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await ready;
  return app(req as any, res as any);
}
