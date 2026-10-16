import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';

await migrate();
createApp().listen(config.port, () => {
  console.log(`Ledger API on http://localhost:${config.port}  (docs: /docs)`);
});
