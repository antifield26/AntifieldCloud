import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

const PORT = Number(process.env.WB_PORT ?? 3000);
const HOST = process.env.WB_HOST ?? '127.0.0.1';

const start = async (app: FastifyInstance): Promise<void> => {
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

buildApp().then(({ app }) => start(app), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
