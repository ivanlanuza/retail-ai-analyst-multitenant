// lib/auth.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookie from "cookie";
import { getDb } from "./db";

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set in environment variables");
}

// PASSWORD HASHING

export async function hashPassword(plainPassword) {
  const saltRounds = 10;
  const hash = await bcrypt.hash(plainPassword, saltRounds);
  return hash;
}

export async function verifyPassword(plainPassword, hash) {
  return bcrypt.compare(plainPassword, hash);
}

// JWT

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// COOKIE HELPERS

export function setAuthCookie(res, token) {
  const serialized = cookie.serialize("auth_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
  });

  res.setHeader("Set-Cookie", serialized);
}

export function clearAuthCookie(res) {
  const serialized = cookie.serialize("auth_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  res.setHeader("Set-Cookie", serialized);
}

export async function getUserFromRequest(req) {
  const cookies = cookie.parse(req.headers.cookie || "");
  const token = cookies.auth_token;
  if (!token) return null;

  const decoded = verifyToken(token);
  if (!decoded?.userId) return null;

  const db = getDb();
  const [rows] = await db.query(
    "SELECT id, email, name, created_at FROM users WHERE id = ?",
    [decoded.userId]
  );
  if (rows.length === 0) return null;

  return rows[0];
}
