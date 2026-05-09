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
  // Server Actions are stable, but Next 16 moved the config key BACK
  // under `experimental` (top-level was the Next 15 shape; reverted in
  // 16 — surfaces as `Unrecognized key(s) in object: 'serverActions'`
  // boot warning if left at top-level, which silently drops bodySizeLimit
  // back to the 1MB default and breaks photo upload).
  // allowedOrigins is the CSRF gate against cross-site Server Action
  // invocations; bodySizeLimit caps the request payload (raised for the
  // photo-upload action which posts JPEGs after the photo-pipeline
  // downsizes).
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:3000', 'panorama.vitormr.dev'],
      bodySizeLimit: '8mb',
    },
  },
};

export default nextConfig;
