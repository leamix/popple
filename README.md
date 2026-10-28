# Popple

Popple is a small anti-stress game: pop bubbles, change their size and sound, and enjoy a fresh sheet whenever you like. It uses browser-native JavaScript, WebGL and Web Audio, with no runtime dependencies.

## Run locally

Install Node.js, then run from this directory:

```sh
npm start
```

Open http://localhost:4174. The server also prints a local-network address for testing on a phone. Use `BUBBLE_HOST=127.0.0.1 npm start` to listen only on this computer, or set `BUBBLE_PORT` to change the port.

Run deterministic tests with `npm test`. Browser scenarios require an already installed Playwright and matching browser; start the server and run `npm run test:browser` or `npm run test:browser:interaction`. No packages are installed by these commands.

To publish the site, serve the contents of `public/` with any static web server. HTTPS is required for phone motion access outside localhost.
