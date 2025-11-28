// src/api/auth.ts
import { API_BASE_URL, handleJsonResponse } from "./client";

export interface AuthUser {
  id: string;
  email: string;
  role: "ADMIN" | "CLIENT";
  emailVerified: boolean;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface VerifyEmailResponse {
  success: boolean;
  message?: string;
}

const ACCESS_TOKEN_KEY = "accessToken";
const REFRESH_TOKEN_KEY = "refreshToken";
const USER_KEY = "authUser";

export function getStoredAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getStoredRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function storeAuthData(data: AuthResponse): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, data.accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
}

export function clearAuthData(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function registerApi(email: string, password: string): Promise<void> {
  const res = await fetch(`/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });
  // backend may return {message}, but we don't need body
  await handleJsonResponse<unknown>(res);
}

export async function loginApi(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });
  return handleJsonResponse<AuthResponse>(res);
}

export async function verifyEmailApi(token: string): Promise<VerifyEmailResponse> {
  const res = await fetch(`/auth/verify-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token })
  });
  return handleJsonResponse<VerifyEmailResponse>(res);
}

export async function refreshTokenApi(refreshToken: string): Promise<AuthResponse> {
  const res = await fetch(`/auth/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ refreshToken })
  });
  return handleJsonResponse<AuthResponse>(res);
}

export async function logoutApi(refreshToken: string | null): Promise<void> {
  // backend may require refreshToken body; send if present
  const res = await fetch(`/auth/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ refreshToken })
  });
  await handleJsonResponse<unknown>(res);
}

// Placeholder for Google login via idToken (UI can pass idToken from Google SDK)
export async function loginWithGoogleApi(idToken: string): Promise<AuthResponse> {
  const res = await fetch(`/auth/google`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ idToken })
  });
  return handleJsonResponse<AuthResponse>(res);
}
