import express, { Application } from "express";
import articlesRouter from "./articles";
import authRouter from "./auth";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/articles", articlesRouter);
  router.use("/auth", authRouter);
}

export default routerApi;
