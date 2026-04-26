/** @type {import('next').NextConfig} */
const coreApiUrl = process.env.CORE_API_URL ?? 'http://localhost:4000';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep builds small for containers — no eager loading of source maps.
  productionBrowserSourceMaps: false,
  // Proxy /api/* requests to the core-api so browser-originated cookies
  // land on the same origin as the web app. Solves the cross-origin
  // cookie problem in dev and is also the prod shape (nginx/caddy
  // sitting in front of both services).
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${coreApiUrl}/:path*`,
      },
    ];
  },
  // Transpile our workspace packages so Next's SWC picks up the TS source.
  transpilePackages: ['@panorama/shared', '@panorama/ui-kit'],
  // Server Actions are stable since Next 14.2 — config hoisted out of
  // `experimental` per Next 15. allowedOrigins is the CSRF gate against
  // cross-site Server Action invocations; bodySizeLimit caps the
  // request payload (default 1MB; raised here for the photo-upload
  // action which posts JPEGs after the photo-pipeline downsizes).
  serverActions: {
    allowedOrigins: ['localhost:3000', 'panorama.vitormr.dev'],
    bodySizeLimit: '8mb',
  },
};

export default nextConfig;
