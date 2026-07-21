import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User";
import { AuthRequest } from "../types/AuthRequest";

function signToken(userId: string, email: string, accountType: string): string {
  return jwt.sign(
    { userId, email, accountType },
    process.env.JWT_SECRET as string,
    { expiresIn: "7d" }
  );
}

// POST /api/auth/register
export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({ message: "Name, email and password are required" });
      return;
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      res.status(409).json({ message: "Email already registered" });
      return;
    }

    const user = await User.create({ name, email, password });
    const token = signToken(user.id, user.email, user.accountType);

    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, accountType: user.accountType },
    });
  } catch (error) {
    next(error);
  }
}

// POST /api/auth/login
export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required" });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.isActive) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const token = signToken(user.id, user.email, user.accountType);

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, accountType: user.accountType },
    });
  } catch (error) {
    next(error);
  }
}

// GET /api/auth/me  (protected)
export async function getMe(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.user?.userId).select("-password -__v");
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }
    res.json({ data: user });
  } catch (error) {
    next(error);
  }
}
