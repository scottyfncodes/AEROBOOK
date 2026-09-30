import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `npm run dev` serves /api from the same handler as production, so the app
 * works end to end in development. Needs DATABASE_URL and BETTER_AUTH_SECRET
 * in .env.local.
 */
function api(): Plugin {
  return {
    name: 'aerobook-api',
    configureServer(server) {
      Object.assign(process.env, loadEnv(server.config.mode, process.cwd(), ''));
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        const origin = `http://${req.headers.host}`;
        process.env.APP_ORIGINS ??= origin;
        process.env.FILES_DIR ??= `${process.cwd()}/.local-files`;
        const { handle } = await server.ssrLoadModule('/server/app.ts');
        const { toRequest, sendResponse } = await server.ssrLoadModule('/server/node.ts');
        await sendResponse(res, await handle(await toRequest(req, origin)));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), api()],
  build: { target: 'es2022', sourcemap: false },
});
