'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { cartApi } from '../lib/api';
import { useAuth } from './AuthContext';

const CartContext = createContext(null);

export function CartProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const [cart, setCart] = useState({
    items: [],
    totalCount: 0,
    subtotal: 0,
    discountAmount: 0,
    finalTotal: 0,
    hasStockIssue: false,
    cartVersion: 0,
    activePromo: null,
  });
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const refreshCart = useCallback(async () => {
    if (!isAuthenticated) {
      setCart({
        items: [],
        totalCount: 0,
        subtotal: 0,
        discountAmount: 0,
        finalTotal: 0,
        hasStockIssue: false,
        cartVersion: 0,
        activePromo: null,
      });
      return;
    }

    try {
      setIsLoading(true);
      const data = await cartApi.getCart();
      if (data.success && data.cart) {
        setCart(data.cart);
      }
    } catch (_) {
      // Игнорируем ошибку при фоновом обновлении
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    refreshCart();
  }, [refreshCart]);

  const addToCart = async (productId, qty = 1) => {
    if (!isAuthenticated) {
      window.location.href = '/auth/signin';
      return false;
    }

    try {
      setIsLoading(true);
      await cartApi.addItem(productId, qty);
      await refreshCart();
      setIsOpen(true); // Автоматически открываем корзину после добавления
      return true;
    } catch (err) {
      alert(err.message || 'Не удалось добавить товар в корзину');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const updateQuantity = async (productId, qty) => {
    try {
      setIsLoading(true);
      await cartApi.updateQty(productId, qty);
      await refreshCart();
    } catch (err) {
      alert(err.message || 'Не удалось обновить количество');
    } finally {
      setIsLoading(false);
    }
  };

  const removeFromCart = async (productId) => {
    try {
      setIsLoading(true);
      await cartApi.removeItem(productId);
      await refreshCart();
    } catch (err) {
      alert(err.message || 'Не удалось удалить товар');
    } finally {
      setIsLoading(false);
    }
  };

  const clearCart = async () => {
    try {
      setIsLoading(true);
      await cartApi.clearCart();
      await refreshCart();
    } catch (err) {
      alert(err.message || 'Не удалось очистить корзину');
    } finally {
      setIsLoading(false);
    }
  };

  const applyPromo = async (code) => {
    try {
      setIsLoading(true);
      const res = await cartApi.applyPromo(code);
      await refreshCart();
      return { success: true, message: res.message };
    } catch (err) {
      return { success: false, message: err.message };
    } finally {
      setIsLoading(false);
    }
  };

  const removePromo = async () => {
    try {
      setIsLoading(true);
      await cartApi.removePromo();
      await refreshCart();
    } catch (_) {
      // Игнорируем ошибку
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <CartContext.Provider
      value={{
        cart,
        isOpen,
        isLoading,
        openCart: () => setIsOpen(true),
        closeCart: () => setIsOpen(false),
        toggleCart: () => setIsOpen((prev) => !prev),
        refreshCart,
        addToCart,
        updateQuantity,
        removeFromCart,
        clearCart,
        applyPromo,
        removePromo,
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
};
