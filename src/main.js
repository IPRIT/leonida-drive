import { createGame } from './core/bootstrap.js';
import { netModule, preconnectNet } from './net/index.js';

// Prepare the online client without connecting. The Multiplayer button starts
// the handshake; singleplayer stays local (src/net/INTEGRATION.md).
preconnectNet();

// Feature modules are added here as workstreams land (see docs/ARCHITECTURE.md).
createGame(document.getElementById('app'), {
  modules: [netModule()],
});
