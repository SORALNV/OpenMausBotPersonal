import type { Plugin } from "vite";

export function privacyVite(): Plugin {
  return {
    name: "privacy-development-csp",
    configureServer(server) {
      if (process.env.VITE_OMB_PRIVACY_STRICT !== "1") return;
      server.middlewares.use((req, res, next) => {
        const token = process.env.OMB_PRIVACY_APP_TOKEN;
        if (token && req.headers["x-omb-privacy-instance"] === token) res.setHeader("X-OMB-Privacy-Instance", token);
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'self' blob:");
        res.setHeader("Referrer-Policy", "no-referrer");
        next();
      });
    },
  };
}
