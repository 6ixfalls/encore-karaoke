import { serviceError } from "./types.js";
import { Store } from "./store.js";
import { configuration } from "./config.js";
import { createApplication } from "./app.js";
import { lock } from "./operations.js";

const config = configuration();
const unlock = lock(config.data);
const store = new Store(config.data);
const server = createApplication(store, config);
await server.library
  .scan()
  .catch((error) =>
    console.error(`Library scan failed: ${serviceError(error).code || "scan_failed"}`),
  );
server.http.listen(config.port, config.host, () =>
  console.log(`Encore headless server: ${config.origin}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () =>
    server.close().then(() => {
      unlock();
      process.exit(0);
    }),
  );
