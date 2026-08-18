import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@rehabalpha/core', '@rehabalpha/sync', '@rehabalpha/pcc-client'],
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
};

export default nextConfig;
