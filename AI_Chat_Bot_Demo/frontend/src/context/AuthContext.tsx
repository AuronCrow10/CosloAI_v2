// src/context/AuthContext.tsx
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode
} from "react";
import {
  AuthUser,
  loginApi,
  registerApi,
  verifyEmailApi,
  refreshTokenApi,
  logoutApi,
  getStoredAccessToken,
  getStoredRefreshToken,
  getStoredUser,
  storeAuthData,
  clearAuthData
} from "../api/auth";

interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser());
  const [accessToken, setAccessToken] = useState<string | null>(() =>
    getStoredAccessToken()
  );
  const [isLoading, setIsLoading] = useState(false);

  // Optional: try to refresh on mount if we have a refresh token
  useEffect(() => {
    const refreshToken = getStoredRefreshToken();
    if (!accessToken && refreshToken) {
      refreshSession().catch(() => {
        // ignore; user stays logged out
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (email: string, password: string): Promise<void> => {
    setIsLoading(true);
    try {
      const data = await loginApi(email, password);
      storeAuthData(data);
      setUser(data.user);
      setAccessToken(data.accessToken);
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (email: string, password: string): Promise<void> => {
    setIsLoading(true);
    try {
      await registerApi(email, password);
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async (): Promise<void> => {
    setIsLoading(true);
    try {
      const refreshToken = getStoredRefreshToken();
      await logoutApi(refreshToken);
    } catch {
      // ignore errors
    } finally {
      clearAuthData();
      setUser(null);
      setAccessToken(null);
      setIsLoading(false);
    }
  };

  const refreshSession = async (): Promise<void> => {
    const refreshToken = getStoredRefreshToken();
    if (!refreshToken) {
      throw new Error("No refresh token");
    }
    setIsLoading(true);
    try {
      const data = await refreshTokenApi(refreshToken);
      storeAuthData(data);
      setUser(data.user);
      setAccessToken(data.accessToken);
    } finally {
      setIsLoading(false);
    }
  };

  const value: AuthContextValue = {
    user,
    accessToken,
    isLoading,
    login,
    register,
    logout,
    refreshSession
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
