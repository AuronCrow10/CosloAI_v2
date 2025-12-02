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
  refreshTokenApi,
  logoutApi,
  getStoredAccessToken,
  getStoredRefreshToken,
  getStoredUser,
  storeAuthData,
  clearAuthData,
  loginWithGoogleApi
} from "../api/auth";

interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  loginWithGoogle: (idToken: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser());
  const [accessToken, setAccessToken] = useState<string | null>(() =>
    getStoredAccessToken()
  );
  const [isLoading, setIsLoading] = useState(false);

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

  const loginWithGoogle = async (idToken: string): Promise<void> => {
    setIsLoading(true);
    try {
      const data = await loginWithGoogleApi(idToken);
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
      // ignore backend errors on logout
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
      clearAuthData();
      setUser(null);
      setAccessToken(null);
      throw new Error("No refresh token");
    }

    setIsLoading(true);
    try {
      const data = await refreshTokenApi(refreshToken);
      storeAuthData(data);
      setUser(data.user);
      setAccessToken(data.accessToken);
    } catch (err) {
      clearAuthData();
      setUser(null);
      setAccessToken(null);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  // On mount: if we have refreshToken but no accessToken, try to restore session
  useEffect(() => {
    const refreshToken = getStoredRefreshToken();
    if (!accessToken && refreshToken) {
      refreshSession().catch(() => {
        // ignore; refreshSession already cleared on failure
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: AuthContextValue = {
    user,
    accessToken,
    isLoading,
    login,
    register,
    logout,
    refreshSession,
    loginWithGoogle
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
