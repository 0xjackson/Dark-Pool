/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Enable polling for Docker file watching
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.watchOptions = {
        poll: 1000,
        aggregateTimeout: 300,
      }
    }

    // Suppress optional dependency warnings
    config.ignoreWarnings = [
      { module: /node_modules\/@metamask\/sdk/ },
      { module: /node_modules\/pino/ },
    ]

    return config
  },
}

module.exports = nextConfig
