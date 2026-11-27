import './globals.css';
import Header from '../components/Header';
import Footer from '../components/Footer';
import CartDrawer from '../components/CartDrawer';
import SupportWidget from '../components/SupportWidget';
import { AuthProvider } from '../context/AuthContext';
import { CartProvider } from '../context/CartContext';
import { ToastProvider } from '../context/ToastContext';

export const metadata = {
  title: 'TIG MARKET — Цифровые товары, аккаунты и ключи',
  description: 'Независимая цифровая платформа с моментальной выдачей лицензий и подписок. Прямая оплата без ограничений.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru" className="dark">
      <body className="min-h-screen bg-dark-bg text-slate-100 flex flex-col justify-between selection:bg-brand selection:text-white">
        <ToastProvider>
          <AuthProvider>
            <CartProvider>
              <Header />
              <main className="flex-1">{children}</main>
              <CartDrawer />
              <Footer />
              <SupportWidget />
            </CartProvider>
          </AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
