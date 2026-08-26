IMPORTANT FIX

The previous version manually replied to select_known_packs. That is not needed and can interfere with the 1.21.11 protocol state. This version removes that manual packet handler.

Mineflayer 4.37.1 supports Minecraft 1.21.11. Use Node.js 22+.

Install:
npm install
npm start

The bot still handles add_resource_pack/resource_pack_send and downloads the pack locally, but it does not manually echo select_known_packs.
