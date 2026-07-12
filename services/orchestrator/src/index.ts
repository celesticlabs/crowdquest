import { createCrowdQuestApp } from "./app.js";

const { app, startSourceStream } = await createCrowdQuestApp();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 8788) });
startSourceStream();
