import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";

// Debe ir siempre después de authMiddleware.
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.accountType !== "admin") {
    res.status(403).json({ message: "Admin access required" });
    return;
  }
  next();
}
