module.exports = {
  apps: [
    {
      name: "api-ges4-bridge",
      script: "./server.js",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 3001
      },
      error_file: "logs/err.log",
      out_file: "logs/out.log",
      log_file: "logs/combined.log",
      time: true
    },
    {
      name: "cloudflare-tunnel",
      script: "./cloudflared.exe",
      args: "tunnel --config C:\\Users\\CUOM-CE-2\\.cloudflared\\config.yml run api-ges4-bridge",
      watch: false,
      error_file: "logs/tunnel-err.log",
      out_file: "logs/tunnel-out.log",
      time: true
    }
  ]
}
