'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // Проверка сессии при загрузке приложения
  const refreshUser = useCallback(async () => {
    try {
      const data = await authApi.getMe();
      if (data.success && data.user) {
        setUser(data.user);
      } else {
        setUser(null);
      }
    } catch (_) {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const setAuthenticatedUser = (newUser) => {
    setUser(newUser);
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } catch (_) {
      // Игнорируем ошибку при логауте
    } finally {
      setUser(null);
      window.location.href = '/';
    }
  };

  const role = user?.role;
  const isStaff = ['support', 'moderator', 'admin', 'superadmin'].includes(role);
  const isModerator = ['moderator', 'admin', 'superadmin'].includes(role);
  const isAdmin = role === 'admin' || role === 'superadmin';

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: Boolean(user),
        isSupport: isStaff,
        isModerator,
        isStaff,
        isAdmin,
        isSuperAdmin: role === 'superadmin',
        refreshUser,
        setAuthenticatedUser,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
