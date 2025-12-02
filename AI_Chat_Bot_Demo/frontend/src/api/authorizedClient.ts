// src/api/authorizedClient.ts
import { API_BASE_URL, handleJsonResponse } from "./client";
import {
  getStoredAccessToken,
  getStoredRefreshToken,
  refreshTokenApi,
  storeAuthData,
  clearAuthData
} from "./auth";

/**
 * Shared refresh promise so multiple parallel 401s only trigger one refresh.
 */
let refreshPromise: Promise<void> | null = null;

async function refreshAccessTokenIfNeeded(): Promise<void> {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) {
    clearAuthData();
    throw new Error("Session expired. Please log in again.");
  }

  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const data = await refreshTokenApi(refreshToken);
        storeAuthData(data);
      } catch (err) {
        clearAuthData();
        throw err;
      } finally {
        refreshPromise = null;
      }
    })();
  }

  return refreshPromise;
}

/**
 * Perform an authenticated JSON request to your backend API.
 * - Attaches Authorization header if accessToken exists
 * - On 401, tries to refresh using refreshToken and retries once
 * - Works with JSON bodies and FormData (no manual Content-Type for FormData)
 */
export async function authFetchJson<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;

  const doFetch = async () => {
    const headers = new Headers(options.headers || {});
    const body: any = options.body;

    // Add Authorization header if we have an access token
    const token = getStoredAccessToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    // Only set JSON content-type when body is a stringified JSON
    if (!headers.has("Content-Type") && typeof body === "string") {
      headers.set("Content-Type", "application/json");
    }

    return fetch(url, {
      ...options,
      headers
    });
  };

  // First attempt
  let res = await doFetch();

  if (res.status !== 401) {
    return handleJsonResponse<T>(res);
  }

  // Try to refresh token on 401
  try {
    await refreshAccessTokenIfNeeded();
  } catch {
    throw new Error("Session expired. Please log in again.");
  }

  // Retry once with new token
  res = await doFetch();
  if (res.status === 401) {
    clearAuthData();
    throw new Error("Session expired. Please log in again.");
  }

  return handleJsonResponse<T>(res);
}
