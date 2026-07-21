import express from "express";
import cors from "cors";
import http from "http";
import routerApi from "./routes";
import { globalErrorHandler } from "./middlewares/globalErrorHandler.middleware";

const whitelist = [
  "http://localhost:8100",
  "http://localhost:8080",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:8101",
  // production frontends
  "https://powerhousebiotech.com",
  "https://www.powerhousebiotech.com",
  "https://juanromangarza.com",
  "https://www.juanromangarza.com",
  "https://drjuangarza.net",
  "https://www.drjuangarza.net",
];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // server-to-server / curl
    // Allow exact whitelist matches
    if (whitelist.includes(origin)) return callback(null, true);
    // Allow all Vercel preview & production deployments
    if (origin.endsWith(".vercel.app")) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
};

export function createApp() {
  const app = express();

  app.use(cors(corsOptions));
  app.use(express.json({ limit: "50mb" }));

  app.get("/", (_req, res) => {
    res.send("Server is alive");
  });

  routerApi(app);

  app.use(globalErrorHandler);

  const server = http.createServer(app);

  return { app, server };
}
