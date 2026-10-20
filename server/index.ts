import { Store } from "./store.js";
import { configuration } from "./config.js";
import { createApplication } from "./app.js";

const config = configuration();
const server = createApplication(new Store(), config);
server.http.listen(config.port, config.host, () =>
  console.log(`Encore server: ${config.origin}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => server.close().then(() => process.exit(0)));
