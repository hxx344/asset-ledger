import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  serverExternalPackages: ['node:sqlite'],
  outputFileTracingIncludes: { '/*': ['./drizzle/*.sql'] },
  outputFileTracingExcludes: { '/*': ['./.data/**/*', './.sites-runtime/**/*', './.wrangler/**/*', './lib/imported-ledger.json', './tests/**/*'] },
};

export default nextConfig;
