import { networkStatus } from '../src/core/tailscale.js';
console.log(JSON.stringify(await networkStatus(Number(process.env.HARNESS_PORT || 8787))));
