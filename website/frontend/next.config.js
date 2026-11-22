/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const apiBackend = process.env.BACKEND_API_URL || 'http://127.0.0.1:4000';
    return [
      {
        source: '/api/:path*',
        destination: `${apiBackend}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
